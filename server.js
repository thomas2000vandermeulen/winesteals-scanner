const express = require('express');
const cors = require('cors');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SUPABASE_URL = 'https://kdhczlabjecqxlyuxprl.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtkaGN6bGFiamVjcXhseXV4cHJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwMDI1MzEsImV4cCI6MjA5MTU3ODUzMX0.9vpr3P0Q6xhs_99nLsU_yE3Ht6prPe9cPjUrt0f5mX4';

async function sbGet(endpoint) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return res.json();
}

// ── NORMALIZE: verwijder accenten, stopwoorden, lowercase ──
function normalize(s) {
  if (!s) return '';
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // accenten weg: é→e, ô→o
    .replace(/\b(chateau|domaine|domain|maison|clos|les|la|le|de|du|des|d'|l'|et|and|von|van|del|della|di|dei|dei)\b/g, '')
    .replace(/[''"`]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── SCORE: hoe goed matcht wijn w met zoektermen? ──
function scoreMatch(w, normName, normProducer, nameParts, producerParts) {
  let score = 0;
  const wn = normalize(w.name);
  const wp = normalize(w.producer);
  const aliases = (w.search_aliases || []).map(a => normalize(a));

  // Naam match
  if (wn === normName) score += 20;
  else if (wn.includes(normName) || normName.includes(wn)) score += 12;
  else {
    const hits = nameParts.filter(p => p.length > 2 && wn.includes(p));
    score += hits.length * 3;
  }

  // Alias match
  for (const alias of aliases) {
    if (alias === normName || alias.includes(normName) || normName.includes(alias)) {
      score += 15;
      break;
    }
    if (nameParts.some(p => p.length > 2 && alias.includes(p))) {
      score += 8;
      break;
    }
  }

  // Producent match
  if (normProducer) {
    if (wp === normProducer) score += 15;
    else if (wp.includes(normProducer) || normProducer.includes(wp)) score += 10;
    else {
      const phits = producerParts.filter(p => p.length > 2 && wp.includes(p));
      if (phits.length > 0) score += phits.length * 4;
      else score -= 10; // verkeerde producent = grote penalty
    }
  }

  return score;
}

async function matchWine(name, producer, vintage) {
  const normName = normalize(name);
  const normProducer = normalize(producer);
  const nameParts = normName.split(' ').filter(p => p.length > 2);
  const producerParts = normProducer.split(' ').filter(p => p.length > 2);

  // Bouw zoektermen — gebruik eerste betekenisvolle woorden
  const nameKeyword = nameParts[0] || '';
  const producerKeyword = producerParts[0] || '';

  const enc = s => encodeURIComponent(s);
  const fields = 'id,name,producer,vintage,region,country,colour,search_aliases';

  let candidates = [];

  try {
    // Strategie 1: naam + producent
    if (nameKeyword && producerKeyword) {
      const r = await sbGet(`wines?name=ilike.*${enc(nameKeyword)}*&producer=ilike.*${enc(producerKeyword)}*&limit=8&select=${fields}`);
      candidates.push(...r);
    }

    // Strategie 2: alleen producent, filter op naam
    if (candidates.length < 3 && producerKeyword) {
      const r = await sbGet(`wines?producer=ilike.*${enc(producerKeyword)}*&limit=12&select=${fields}`);
      candidates.push(...r);
    }

    // Strategie 3: eerste twee naamwoorden
    if (candidates.length < 3 && nameParts.length >= 2) {
      const twoWords = encodeURIComponent(nameParts.slice(0, 2).join(' '));
      const r = await sbGet(`wines?name=ilike.*${twoWords}*&limit=8&select=${fields}`);
      candidates.push(...r);
    }

    // Strategie 4: alias search via tweede naamwoord (e.g. "Barolo" → vindt alle Barolo's)
    if (candidates.length < 3 && nameKeyword) {
      const r = await sbGet(`wines?name=ilike.*${enc(nameKeyword)}*&limit=10&select=${fields}`);
      candidates.push(...r);
    }

    // Dedupliceer
    const seen = new Set();
    candidates = candidates.filter(w => { if (seen.has(w.id)) return false; seen.add(w.id); return true; });

    if (!candidates.length) return null;

    // Scoor en kies beste match
    let best = null, bestScore = 6; // minimum drempel
    for (const w of candidates) {
      const s = scoreMatch(w, normName, normProducer, nameParts, producerParts);
      if (s > bestScore) { bestScore = s; best = w; }
    }
    if (!best) return null;

    // Zoek vintage-specifieke prijs
    let priceData = null;
    if (vintage) {
      const exact = await sbGet(`wine_vintage_prices?wine_id=eq.${best.id}&vintage=eq.${vintage}&limit=1&select=market_price_eur,market_price_min,market_price_max`);
      if (exact.length > 0) {
        priceData = exact[0];
      } else {
        // Dichtstbijzijnde jaargang ±3 jaar
        const nearby = await sbGet(`wine_vintage_prices?wine_id=eq.${best.id}&vintage=gte.${vintage - 3}&vintage=lte.${vintage + 3}&order=vintage.desc&limit=1&select=market_price_eur,market_price_min,market_price_max`);
        if (nearby.length > 0) priceData = nearby[0];
      }
    }

    // Fallback: prijs uit wines tabel
    if (!priceData) {
      const winePrice = await sbGet(`wines?id=eq.${best.id}&select=market_price_eur,market_price_min,market_price_max`);
      if (winePrice.length > 0 && winePrice[0].market_price_eur) priceData = winePrice[0];
    }

    return {
      ...best,
      match_score: bestScore,
      market_price_eur: priceData?.market_price_eur || null,
      market_price_min: priceData?.market_price_min || null,
      market_price_max: priceData?.market_price_max || null,
    };
  } catch (e) {
    console.warn('matchWine error:', e.message);
    return null;
  }
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/scan', async (req, res) => {
  const { text, restaurant } = req.body;
  if (!text || text.length < 20) return res.status(400).json({ error: 'Geen tekst' });
  if (text.length > 100000) return res.status(400).json({ error: 'Tekst te lang' });

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16000,
      messages: [{
        role: 'user',
        content: `Je bent een expert in het lezen van restaurantwijnkaarten. Extraheer ALLEEN de wijnen als JSON array.

Regels:
- Geef ALLEEN een JSON array terug, geen uitleg of markdown
- Negeer: sectieheaders, beschrijvingen, cocktails, bier, water, aperitief
- Elk object: name, producer, vintage (null als NV/geen jaargang), price (FLESPRIJS als getal), bottle_format (null tenzij magnum etc)
- Bij twee prijzen (glas + fles): neem ALTIJD de hoogste = flesprijs
- Alleen glasprijs zonder flesprijs: sla over
- Geen duplicaten

Wijnkaart van ${restaurant || 'restaurant'}:
${text}

JSON array:`
      }]
    });

    let raw = message.content[0].text.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let wines;
    try { wines = JSON.parse(raw); }
    catch { const m = raw.match(/\[[\s\S]*\]/); wines = m ? JSON.parse(m[0]) : []; }

    // Filter en normaliseer
    wines = wines
      .filter(w => w.price && w.price > 8 && w.price < 10000 && w.name?.length > 1)
      .map(w => ({
        name: String(w.name || '').trim(),
        producer: String(w.producer || '').trim(),
        vintage: w.vintage ? parseInt(w.vintage) : null,
        price: parseFloat(w.price),
        bottle_format: w.bottle_format || null
      }));

    // Dedupliceer
    const seen = new Set();
    wines = wines.filter(w => {
      const key = normalize(w.name + w.producer + (w.vintage || ''));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Match in batches van 8
    const results = [];
    for (let i = 0; i < wines.length; i += 8) {
      const batch = wines.slice(i, i + 8);
      const matched = await Promise.all(batch.map(w => matchWine(w.name, w.producer, w.vintage)));
      batch.forEach((w, j) => {
        const db = matched[j];
        results.push({
          ...w,
          matched: !!(db?.market_price_eur),
          match_score: db?.match_score || 0,
          region: db ? [db.region, db.country].filter(Boolean).join(' · ') : null,
          colour: db?.colour || null,
          market_price_eur: db?.market_price_eur || null,
          market_price_min: db?.market_price_min || null,
          market_price_max: db?.market_price_max || null,
        });
      });
    }

    res.json({
      success: true,
      wines: results,
      count: results.length,
      matched: results.filter(w => w.matched).length,
      tokens_used: message.usage.input_tokens + message.usage.output_tokens
    });

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`WineSteals server poort ${PORT}`));
