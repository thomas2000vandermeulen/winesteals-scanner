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

async function supabase(endpoint, params) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + endpoint + (params || ''), {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) throw new Error('Supabase ' + res.status);
  return res.json();
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function matchWine(name, producer, vintage) {
  const enc = s => encodeURIComponent(s.trim());
  const nameParts = name.split(' ').filter(w => w.length > 2).slice(0, 4);
  const producerParts = producer ? producer.split(' ').filter(w => w.length > 1) : [];
  const producerFirst = producerParts[0] || '';

  function scoreMatch(w) {
    let score = 0;
    const wn = (w.name || '').toLowerCase(), wp = (w.producer || '').toLowerCase();
    const pn = name.toLowerCase();
    if (wn === pn) score += 10;
    else if (wn.includes(pn) || pn.includes(wn)) score += 6;
    else if (nameParts.some(p => p.length > 3 && wn.includes(p.toLowerCase()))) score += 2;
    if (producerFirst) {
      if (wp.includes(producerFirst.toLowerCase())) score += 8;
      else if (producerParts[1] && wp.includes(producerParts[1].toLowerCase())) score += 4;
      else score -= 15;
    }
    return score;
  }

  try {
    let candidates = [];
    const fields = 'id,name,producer,vintage,region,country,colour';

    if (producerFirst && nameParts.length) {
      candidates = await supabase('wines', '?producer=ilike.*' + enc(producerFirst) + '*&name=ilike.*' + enc(nameParts[0]) + '*&limit=5&select=' + fields);
    }
    if (!candidates.length && producerFirst) {
      const res = await supabase('wines', '?producer=ilike.*' + enc(producerFirst) + '*&limit=5&select=' + fields);
      candidates = res.filter(w => nameParts.some(p => (w.name || '').toLowerCase().includes(p.toLowerCase())));
    }
    if (!candidates.length && nameParts.length >= 2) {
      candidates = await supabase('wines', '?name=ilike.*' + enc(nameParts.slice(0, 2).join(' ')) + '*&limit=5&select=' + fields);
    }
    if (!candidates.length) return null;

    let best = null, bestScore = 5;
    for (const w of candidates) {
      const s = scoreMatch(w);
      if (s > bestScore) { bestScore = s; best = w; }
    }
    if (!best) return null;

    // Zoek vintage-specifieke prijs
    let priceData = null;
    if (vintage) {
      const exact = await supabase('wine_vintage_prices', '?wine_id=eq.' + best.id + '&vintage=eq.' + vintage + '&limit=1&select=market_price_eur,market_price_min,market_price_max');
      if (exact.length > 0) {
        priceData = exact[0];
      } else {
        const nearby = await supabase('wine_vintage_prices', '?wine_id=eq.' + best.id + '&vintage=gte.' + (vintage - 3) + '&vintage=lte.' + (vintage + 3) + '&order=vintage.desc&limit=1&select=market_price_eur,market_price_min,market_price_max');
        if (nearby.length > 0) priceData = nearby[0];
      }
    }

    // Fallback naar wines tabel
    if (!priceData) {
      const wineWithPrice = await supabase('wines', '?id=eq.' + best.id + '&select=market_price_eur,market_price_min,market_price_max');
      if (wineWithPrice.length > 0 && wineWithPrice[0].market_price_eur) {
        priceData = wineWithPrice[0];
      }
    }

    return Object.assign({}, best, {
      market_price_eur: priceData ? priceData.market_price_eur : null,
      market_price_min: priceData ? priceData.market_price_min : null,
      market_price_max: priceData ? priceData.market_price_max : null,
    });
  } catch (e) {
    console.warn('matchWine error:', e.message);
    return null;
  }
}

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
        content: 'Je bent een expert in het lezen van restaurantwijnkaarten. Extraheer ALLEEN de wijnen als JSON array.\n\nRegels:\n- Geef ALLEEN een JSON array terug, geen uitleg\n- Negeer sectieheaders, beschrijvingen, aperitief, cocktails, bier, water\n- Elke wijn: name, producer, vintage (null als NV), price (FLESPRIJS als getal), bottle_format (null tenzij magnum/halve fles)\n- Bij twee prijzen (glas + fles): gebruik ALTIJD de HOOGSTE = flesprijs\n- Als er ALLEEN een glasprijs staat zonder flesprijs: sla de wijn OVER\n- Geen duplicaten\n\nWijnkaart van ' + (restaurant || 'restaurant') + ':\n' + text + '\n\nGeef ALLEEN een JSON array:'
      }]
    });

    let raw = message.content[0].text.trim()
      .replace(/^```jsons*/i, '').replace(/^```s*/i, '').replace(/```s*$/i, '').trim();

    let wines;
    try { wines = JSON.parse(raw); }
    catch (e) { const m = raw.match(/[[sS]*]/); wines = m ? JSON.parse(m[0]) : []; }

    wines = wines
      .filter(w => w.price && w.price > 8 && w.price < 10000 && w.name && w.name.length > 1)
      .map(w => ({
        name: String(w.name || '').trim(),
        producer: String(w.producer || '').trim(),
        vintage: w.vintage ? parseInt(w.vintage) : null,
        price: parseFloat(w.price),
        bottle_format: w.bottle_format || null
      }));

    const seen = new Set();
    wines = wines.filter(w => {
      const key = (w.name + w.producer + w.vintage).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const BATCH = 10;
    const results = [];
    for (let i = 0; i < wines.length; i += BATCH) {
      const batch = wines.slice(i, i + BATCH);
      const matched = await Promise.all(batch.map(w => matchWine(w.name, w.producer, w.vintage)));
      batch.forEach((w, j) => {
        const db = matched[j];
        results.push(Object.assign({}, w, {
          matched: !!(db && db.market_price_eur),
          region: db ? [db.region, db.country].filter(Boolean).join(' · ') : null,
          colour: db ? db.colour : null,
          market_price_eur: db ? db.market_price_eur : null,
          market_price_min: db ? db.market_price_min : null,
          market_price_max: db ? db.market_price_max : null,
        }));
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

app.listen(PORT, () => console.log('WineSteals server poort ' + PORT));
