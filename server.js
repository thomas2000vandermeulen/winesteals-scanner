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
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

// Verwijder accenten, stopwoorden, lowercase
function normalize(s) {
  if (!s) return '';
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(chateau|domaine|domain|maison|clos|les|la|le|de|du|des|d|l|et|and|von|van|del|della|di|dei)\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function scoreMatch(w, normName, normProducer, nameParts, producerParts) {
  let score = 0;
  const wn = normalize(w.name);
  const wp = normalize(w.producer);
  const aliases = (w.search_aliases || []).map(a => normalize(a));

  // Naam score
  if (wn === normName) score += 20;
  else if (wn.includes(normName) || normName.includes(wn)) score += 12;
  else {
    const hits = nameParts.filter(p => p.length > 2 && wn.includes(p));
    score += hits.length * 3;
  }

  // Alias score
  for (const alias of aliases) {
    if (alias === normName || alias.includes(normName) || normName.includes(alias)) { score += 15; break; }
    if (nameParts.some(p => p.length > 2 && alias.includes(p))) { score += 8; break; }
  }

  // Producent score
  if (normProducer) {
    if (wp === normProducer) score += 15;
    else if (wp.includes(normProducer) || normProducer.includes(wp)) score += 10;
    else {
      const phits = producerParts.filter(p => p.length > 2 && wp.includes(p));
      if (phits.length > 0) score += phits.length * 4;
      else score -= 10;
    }
  }

  return score;
}

// Match een batch wijnen in één keer tegen de DB
async function matchBatch(wines) {
  // Verzamel alle unieke zoektermen
  const keywords = new Set();
  wines.forEach(w => {
    const normName = normalize(w.name);
    const normProducer = normalize(w.producer);
    const nameParts = normName.split(' ').filter(p => p.length > 2);
    const producerParts = normProducer.split(' ').filter(p => p.length > 2);
    if (nameParts[0]) keywords.add(nameParts[0]);
    if (nameParts[1]) keywords.add(nameParts[1]);
    if (producerParts[0]) keywords.add(producerParts[0]);
  });

  // Haal kandidaten op met OR query — één grote fetch voor alle wijnen
  const fields = 'id,name,producer,vintage,region,country,colour,market_price_eur,market_price_min,market_price_max,search_aliases';
  const orTerms = [...keywords].map(k => `name.ilike.*${encodeURIComponent(k)}*,producer.ilike.*${encodeURIComponent(k)}*`).join(',');

  let candidates = [];
  try {
    candidates = await sbGet(`wines?or=(${orTerms})&limit=50&select=${fields}`);
  } catch(e) {
    console.warn('matchBatch fetch error:', e.message);
    return wines.map(() => null);
  }

  // Haal vintage prijzen op voor alle kandidaat wine_ids
  const candidateIds = candidates.map(c => c.id);
  let vintagePrices = [];
  if (candidateIds.length > 0) {
    try {
      const vintageYears = wines.map(w => w.vintage).filter(Boolean);
      const minYear = vintageYears.length ? Math.min(...vintageYears) - 3 : 1990;
      const maxYear = vintageYears.length ? Math.max(...vintageYears) + 3 : 2025;
      vintagePrices = await sbGet(
        `wine_vintage_prices?wine_id=in.(${candidateIds.join(',')})&vintage=gte.${minYear}&vintage=lte.${maxYear}&select=wine_id,vintage,market_price_eur,market_price_min,market_price_max`
      );
    } catch(e) {
      console.warn('vintage prices fetch error:', e.message);
    }
  }

  // Maak vintage prijzen lookup: wine_id → vintage → prijs
  const vpLookup = {};
  for (const vp of vintagePrices) {
    if (!vpLookup[vp.wine_id]) vpLookup[vp.wine_id] = {};
    vpLookup[vp.wine_id][vp.vintage] = vp;
  }

  // Match elke wijn tegen kandidaten
  return wines.map(w => {
    const normName = normalize(w.name);
    const normProducer = normalize(w.producer);
    const nameParts = normName.split(' ').filter(p => p.length > 2);
    const producerParts = normProducer.split(' ').filter(p => p.length > 2);

    let best = null, bestScore = 6;
    for (const c of candidates) {
      const s = scoreMatch(c, normName, normProducer, nameParts, producerParts);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (!best) return null;

    // Zoek beste vintage prijs
    let priceData = null;
    if (w.vintage && vpLookup[best.id]) {
      // Exacte match
      if (vpLookup[best.id][w.vintage]) {
        priceData = vpLookup[best.id][w.vintage];
      } else {
        // Dichtstbijzijnde ±3 jaar
        let minDiff = 999, closest = null;
        for (const [yr, data] of Object.entries(vpLookup[best.id])) {
          const diff = Math.abs(parseInt(yr) - w.vintage);
          if (diff <= 3 && diff < minDiff) { minDiff = diff; closest = data; }
        }
        priceData = closest;
      }
    }

    // Fallback naar wines tabel prijs
    if (!priceData && best.market_price_eur) {
      priceData = { market_price_eur: best.market_price_eur, market_price_min: best.market_price_min, market_price_max: best.market_price_max };
    }

    return {
      ...best,
      match_score: bestScore,
      market_price_eur: priceData?.market_price_eur || null,
      market_price_min: priceData?.market_price_min || null,
      market_price_max: priceData?.market_price_max || null,
    };
  });
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
- Elk object: name, producer, vintage (null als NV/geen jaargang), price (FLESPRIJS als getal)
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

    wines = wines
      .filter(w => w.price && w.price > 8 && w.price < 10000 && w.name?.length > 1)
      .map(w => ({
        name: String(w.name || '').trim(),
        producer: String(w.producer || '').trim(),
        vintage: w.vintage ? parseInt(w.vintage) : null,
        price: parseFloat(w.price),
      }));

    // Dedupliceer
    const seen = new Set();
    wines = wines.filter(w => {
      const key = normalize(w.name + w.producer + (w.vintage || ''));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Match in batches van 15 (1 grote DB call per batch)
    const BATCH = 15;
    const results = [];
    for (let i = 0; i < wines.length; i += BATCH) {
      const batch = wines.slice(i, i + BATCH);
      const matched = await matchBatch(batch);
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
    console.error('Scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`WineSteals server poort ${PORT}`));
