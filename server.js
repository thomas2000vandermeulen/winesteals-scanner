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
  if (!res.ok) throw new Error(`Supabase GET ${res.status}`);
  return res.json();
}

async function sbPost(endpoint, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' }
  , body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Supabase POST ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sbPatch(endpoint, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }
  , body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Supabase PATCH ${res.status}`);
}

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

  if (wn === normName) score += 20;
  else if (wn.includes(normName) || normName.includes(wn)) score += 12;
  else { score += nameParts.filter(p => p.length > 2 && wn.includes(p)).length * 3; }

  for (const alias of aliases) {
    if (alias === normName || alias.includes(normName) || normName.includes(alias)) { score += 15; break; }
    if (nameParts.some(p => p.length > 2 && alias.includes(p))) { score += 8; break; }
  }

  if (normProducer) {
    if (wp === normProducer) score += 15;
    else if (wp.includes(normProducer) || normProducer.includes(wp)) score += 10;
    else {
      const phits = producerParts.filter(p => p.length > 2 && wp.includes(p));
      score += phits.length > 0 ? phits.length * 4 : -10;
    }
  }
  return score;
}

async function matchBatch(wines) {
  const keywords = new Set();
  wines.forEach(w => {
    normalize(w.name).split(' ').filter(p => p.length > 2).slice(0, 2).forEach(k => keywords.add(k));
    normalize(w.producer).split(' ').filter(p => p.length > 2).slice(0, 1).forEach(k => keywords.add(k));
  });

  const fields = 'id,name,producer,vintage,region,country,colour,market_price_eur,market_price_min,market_price_max,search_aliases';
  const orTerms = [...keywords].slice(0, 20).map(k => `name.ilike.*${encodeURIComponent(k)}*,producer.ilike.*${encodeURIComponent(k)}*`).join(',');

  let candidates = [];
  try { candidates = await sbGet(`wines?or=(${orTerms})&limit=60&select=${fields}`); }
  catch(e) { console.warn('matchBatch error:', e.message); return wines.map(() => null); }

  const candidateIds = candidates.map(c => c.id);
  let vintagePrices = [];
  if (candidateIds.length > 0) {
    const years = wines.map(w => w.vintage).filter(Boolean);
    const minY = years.length ? Math.min(...years) - 3 : 1990;
    const maxY = years.length ? Math.max(...years) + 3 : 2025;
    try {
      vintagePrices = await sbGet(`wine_vintage_prices?wine_id=in.(${candidateIds.join(',')})&vintage=gte.${minY}&vintage=lte.${maxY}&select=wine_id,vintage,market_price_eur,market_price_min,market_price_max`);
    } catch(e) { console.warn('vintage prices error:', e.message); }
  }

  const vpLookup = {};
  for (const vp of vintagePrices) {
    if (!vpLookup[vp.wine_id]) vpLookup[vp.wine_id] = {};
    vpLookup[vp.wine_id][vp.vintage] = vp;
  }

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

    let priceData = null;
    if (w.vintage && vpLookup[best.id]) {
      if (vpLookup[best.id][w.vintage]) {
        priceData = vpLookup[best.id][w.vintage];
      } else {
        let minDiff = 999, closest = null;
        for (const [yr, data] of Object.entries(vpLookup[best.id])) {
          const diff = Math.abs(parseInt(yr) - w.vintage);
          if (diff <= 3 && diff < minDiff) { minDiff = diff; closest = data; }
        }
        priceData = closest;
      }
    }
    if (!priceData && best.market_price_eur) {
      priceData = { market_price_eur: best.market_price_eur, market_price_min: best.market_price_min, market_price_max: best.market_price_max };
    }

    return { ...best, match_score: bestScore, market_price_eur: priceData?.market_price_eur || null, market_price_min: priceData?.market_price_min || null, market_price_max: priceData?.market_price_max || null };
  });
}

// ── BEREKEN STEAL SCORE ──
function calcStealScore(restaurantPrice, marketPrice) {
  if (!marketPrice || !restaurantPrice) return 0;
  const discount = (marketPrice - restaurantPrice) / marketPrice;
  if (discount <= 0) return 0;
  return Math.min(100, Math.round(discount * 100));
}

// ── SLA RESTAURANT OP OF ZOEK OP ──
async function upsertRestaurant(name, city) {
  // Zoek bestaand restaurant op naam (case-insensitive)
  try {
    const existing = await sbGet(`restaurants?name=ilike.${encodeURIComponent(name)}&limit=1&select=id,name`);
    if (existing.length > 0) {
      // Update last_scanned_at
      await sbPatch(`restaurants?id=eq.${existing[0].id}`, { last_scanned_at: new Date().toISOString() });
      return existing[0].id;
    }
    // Nieuw restaurant aanmaken
    const created = await sbPost('restaurants', { name, city: city || 'Amsterdam', last_scanned_at: new Date().toISOString() });
    return created[0]?.id;
  } catch(e) {
    console.warn('upsertRestaurant error:', e.message);
    return null;
  }
}

// ── SLA SCAN RESULTATEN OP ──
async function saveScanResults(restaurantId, wines) {
  if (!restaurantId || !wines.length) return;
  const steals = wines.filter(w => w.matched && w.steal_score > 0);
  if (!steals.length) return;

  try {
    const rows = steals.map(w => ({
      restaurant_id: restaurantId,
      wine_name: w.name,
      producer: w.producer || null,
      vintage: w.vintage || null,
      restaurant_price: w.price,
      market_price: w.market_price_eur,
      steal_score: w.steal_score,
      is_steal: w.steal_score >= 10,
      colour: w.colour || null,
      region: w.region || null,
      scanned_at: new Date().toISOString()
    }));
    await sbPost('scan_results', rows);
  } catch(e) {
    console.warn('saveScanResults error:', e.message);
  }
}

// ── PUBLIEKE ENDPOINTS ──

// Haal beste actieve steals op (voor homepage widget)
app.get('/steals', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const days = parseInt(req.query.days) || 90;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const results = await sbGet(
      `scan_results?is_steal=eq.true&scanned_at=gte.${since}&order=steal_score.desc&limit=${limit}&select=wine_name,producer,vintage,restaurant_price,market_price,steal_score,colour,region,scanned_at,restaurant_id,restaurants(name,city,lat,lng)`
    );
    res.json({ success: true, steals: results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Haal restaurants op (voor kaart)
app.get('/restaurants', async (req, res) => {
  try {
    const results = await sbGet('restaurants?order=last_scanned_at.desc&limit=100&select=id,name,city,lat,lng,last_scanned_at');
    res.json({ success: true, restaurants: results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/scan', async (req, res) => {
  const { text, restaurant, city } = req.body;
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
      .map(w => ({ name: String(w.name || '').trim(), producer: String(w.producer || '').trim(), vintage: w.vintage ? parseInt(w.vintage) : null, price: parseFloat(w.price) }));

    const seen = new Set();
    wines = wines.filter(w => {
      const key = normalize(w.name + w.producer + (w.vintage || ''));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Match wijnen
    const BATCH = 15;
    const results = [];
    for (let i = 0; i < wines.length; i += BATCH) {
      const batch = wines.slice(i, i + BATCH);
      const matched = await matchBatch(batch);
      batch.forEach((w, j) => {
        const db = matched[j];
        const stealScore = calcStealScore(w.price, db?.market_price_eur);
        results.push({
          ...w,
          matched: !!(db?.market_price_eur),
          match_score: db?.match_score || 0,
          region: db ? [db.region, db.country].filter(Boolean).join(' · ') : null,
          colour: db?.colour || null,
          market_price_eur: db?.market_price_eur || null,
          market_price_min: db?.market_price_min || null,
          market_price_max: db?.market_price_max || null,
          steal_score: stealScore,
        });
      });
    }

    // Sla op in database (fire & forget — wacht niet op resultaat)
    if (restaurant) {
      upsertRestaurant(restaurant, city).then(restaurantId => {
        saveScanResults(restaurantId, results);
      }).catch(e => console.warn('save error:', e.message));
    }

    res.json({
      success: true,
      wines: results,
      count: results.length,
      matched: results.filter(w => w.matched).length,
      steals: results.filter(w => w.steal_score > 0).length,
      tokens_used: message.usage.input_tokens + message.usage.output_tokens
    });

  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`WineSteals server poort ${PORT}`));
