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

  // Naam score — strenger: alleen exacte en sterke matches tellen
  if (wn === normName) score += 25;
  else if (wn.includes(normName) || normName.includes(wn)) {
    // Voorkom false positives: "Palmer" matcht zowel "Alter Ego de Palmer" als "Chateau Palmer"
    // Als de zoekterm beduidend korter is dan de DB-naam, lagere score
    const lenRatio = Math.min(normName.length, wn.length) / Math.max(normName.length, wn.length);
    score += Math.round(12 * lenRatio);
  } else {
    // Gedeeltelijke match op losse woorden — alleen woorden > 3 chars tellen
    const hits = nameParts.filter(p => p.length > 3 && wn.includes(p));
    // Maar straf af als er woorden in de DB-naam zijn die niet in de zoeknaam zitten
    const dbWords = wn.split(' ').filter(p => p.length > 3);
    const missed = dbWords.filter(p => !normName.includes(p)).length;
    score += hits.length * 3 - missed * 2;
  }

  // Alias score
  for (const alias of aliases) {
    if (alias === normName || alias.includes(normName) || normName.includes(alias)) { score += 15; break; }
    if (nameParts.some(p => p.length > 3 && alias.includes(p))) { score += 8; break; }
  }

  // Producent score — zwaarder gewogen
  if (normProducer) {
    if (wp === normProducer) score += 18;
    else if (wp.includes(normProducer) || normProducer.includes(wp)) score += 12;
    else {
      const phits = producerParts.filter(p => p.length > 2 && wp.includes(p));
      score += phits.length > 0 ? phits.length * 5 : -15; // hogere penalty voor verkeerde producent
    }
  }

  // Minimum drempel: als de naam totaal niet klopt, geen match
  if (score < 0) score = 0;
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

// Sla niet-gematchte wijnen op als pending — maar check eerst op dubbelen
async function saveUnmatchedAsPending(wines) {
  const unmatched = wines.filter(w => !w.matched && w.name && w.name.length > 1);
  if (!unmatched.length) return;

  try {
    // Bouw een OR query om bestaande wijnen te vinden
    const checks = unmatched.map(w => {
      const nm = encodeURIComponent(w.name.trim());
      const pr = encodeURIComponent((w.producer || '').trim());
      return `name.ilike.${nm},producer.ilike.${pr}`;
    });

    // Check per batch van 10
    const BATCH = 10;
    const toInsert = [];
    for (let i = 0; i < unmatched.length; i += BATCH) {
      const batch = unmatched.slice(i, i + BATCH);
      for (const w of batch) {
        try {
          const nm = encodeURIComponent(w.name.trim());
          const existing = await sbGet(`wines?name=ilike.${nm}&vintage=eq.${w.vintage || 'null'}&limit=1&select=id`);
          if (!existing.length) {
            toInsert.push({
              name: w.name.trim(),
              producer: w.producer?.trim() || null,
              vintage: w.vintage || null,
              colour: w.colour || null,
              region: w.region?.split(' · ')[0] || null,
              country: w.region?.split(' · ')[1] || null,
              price_source: 'pending'
            });
          }
        } catch(e) { /* skip */ }
      }
    }

    if (toInsert.length > 0) {
      await sbPost('wines', toInsert);
      console.log(`Saved ${toInsert.length} new pending wines (skipped ${unmatched.length - toInsert.length} duplicates)`);
    }
  } catch(e) {
    console.warn('saveUnmatchedAsPending error:', e.message);
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
    // Splits grote teksten in chunks van max 8000 chars
    const CHUNK_SIZE = 8000;
    const prompt = `Je bent een expert in het lezen van restaurantwijnkaarten. Extraheer ALLEEN de wijnen als JSON array.

Regels:
- Geef ALLEEN een JSON array terug, geen uitleg of markdown
- Negeer: sectieheaders, beschrijvingen, cocktails, bier, water, aperitief
- Elk object: name (wijnnaam), producer (producent/wijnhuis), vintage (null als NV/geen jaargang), price (FLESPRIJS als getal)
- Bij twee prijzen (glas + fles): neem ALTIJD de hoogste = flesprijs
- Alleen glasprijs zonder flesprijs: sla over
- Geen duplicaten
- BELANGRIJK naam vs producent: de producent is het wijnhuis/domaine (bijv. "De Venoge", "Bollinger", "Domaine Leflaive"). De naam is het specifieke product/cuvée (bijv. "Brut Rosé", "Corton-Charlemagne", "Millésimé"). Als een wijn alleen staat als "De Venoge Brut" dan is producer="De Venoge" en name="Brut". Niet andersom.
- Bij champagne: het wijnhuis is bijna altijd de producent, de cuvée/stijl is de naam

Wijnkaart van ${restaurant || 'restaurant'}:
`;

    const chunks = [];
    if (text.length <= CHUNK_SIZE) {
      chunks.push(text);
    } else {
      // Splits op lege regels om wijnen niet door te knippen
      const lines = text.split('\n');
      let current = '';
      for (const line of lines) {
        if ((current + '\n' + line).length > CHUNK_SIZE && current.length > 500) {
          chunks.push(current);
          current = line;
        } else {
          current += (current ? '\n' : '') + line;
        }
      }
      if (current.length > 100) chunks.push(current);
    }

    console.log(`Processing ${chunks.length} chunk(s), total ${text.length} chars`);

    // Verwerk chunks parallel (max 3 tegelijk)
    let allWinesRaw = [];
    const PARALLEL = 3;
    for (let i = 0; i < chunks.length; i += PARALLEL) {
      const batch = chunks.slice(i, i + PARALLEL);
      const results = await Promise.all(batch.map(async (chunk) => {
        try {
          const message = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 8000,
            messages: [{ role: 'user', content: prompt + chunk + '\n\nJSON array:' }]
          });
          let raw = message.content[0].text.trim()
            .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
          try { return JSON.parse(raw); }
          catch { const m = raw.match(/\[[\s\S]*\]/); return m ? JSON.parse(m[0]) : []; }
        } catch(e) {
          console.warn('Chunk error:', e.message);
          return [];
        }
      }));
      results.forEach(r => allWinesRaw.push(...r));
    }

    let wines = allWinesRaw
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
    // Sla niet-gematchte wijnen op als pending (met dubbelen-check)
    saveUnmatchedAsPending(results).catch(e => console.warn('pending save error:', e.message));

    res.json({
      success: true,
      wines: results,
      count: results.length,
      matched: results.filter(w => w.matched).length,
      steals: results.filter(w => w.steal_score > 0).length,
      tokens_used: 0
    });

  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Price lookup endpoint — gebruikt door admin-prices.html
// Voorkomt CORS problemen door de Anthropic API call via de server te laten gaan
app.post('/price-lookup', async (req, res) => {
  const { wines } = req.body;
  if (!wines || !Array.isArray(wines) || !wines.length) {
    return res.status(400).json({ error: 'Geen wijnen opgegeven' });
  }
  if (wines.length > 30) {
    return res.status(400).json({ error: 'Max 30 wijnen per batch' });
  }

  const wineList = wines.map((w, i) =>
    `${i + 1}. "${w.name}" — ${w.producer || 'onbekend'}${w.vintage ? ', ' + w.vintage : ''}${w.country && w.country !== 'Unknown' ? ', ' + w.country : ''}`
  ).join('\n');

  const prompt = `Je bent een wijnprijsexpert. Geef de gemiddelde retailmarktprijs in EUR (Europese markt, 750ml) voor elke wijn.

Geef ALLEEN een JSON array terug zonder uitleg of markdown. Elk object:
{"index":N,"price":45.00,"confidence":"high/medium/low","note":"bron of toelichting max 8 woorden"}

confidence:
- "high": ken je goed, prijs ±10%
- "medium": redelijk bekend, prijs ±25%
- "low": weinig info of onbekende producent
- Als je de wijn echt niet kent: price:null

Wijnen:
${wineList}

JSON array:`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    let raw = message.content[0].text.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let prices;
    try { prices = JSON.parse(raw); }
    catch { const m = raw.match(/\[[\s\S]*\]/); prices = m ? JSON.parse(m[0]) : []; }

    res.json({ success: true, prices });
  } catch (err) {
    console.error('Price lookup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`WineSteals server poort ${PORT}`));
