const express = require('express');
const cors = require('cors');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '4mb' }));
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
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase POST ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sbPatch(endpoint, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${res.status}`);
}

const STOP_WORDS = new Set(['chateau','domaine','domain','maison','cave','cellier','clos','domaines',
  'de','du','des','d','l','le','la','les','et','and','von','van','del','della','di','dei','al','the']);

function normalize(s) {
  if (!s) return '';
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function normalizeNoStop(s) {
  if (!s) return '';
  return normalize(s).split(' ')
    .filter(w => !STOP_WORDS.has(w))
    .join(' ').trim();
}

function tokenize(s) {
  return normalize(s).split(' ').filter(w => w.length > 1);
}

function tokenizeSignificant(s) {
  return normalize(s).split(' ').filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

function scoreMatch(w, normName, normProducer, nameParts, producerParts) {
  let score = 0;

  const dbName = normalize(w.name);
  const dbProducer = normalize(w.producer || '');
  const dbNameTokens = tokenizeSignificant(w.name);
  const dbProducerTokens = tokenizeSignificant(w.producer || '');
  const aliases = (w.search_aliases || []).map(a => normalize(a));

  const dbFull = dbProducer + ' ' + dbName;
  const queryFull = (normProducer || '') + ' ' + normName;

  const queryTokens = tokenizeSignificant(queryFull);
  const dbTokens = tokenizeSignificant(dbFull);

  const normNameClean = normalizeNoStop(normName);
  const dbNameClean = normalizeNoStop(w.name);

  if (dbNameClean === normNameClean && normNameClean.length > 2) {
    score += 30;
  } else {
    const nameQueryTokens = tokenizeSignificant(normName);
    const nameDbTokens = tokenizeSignificant(w.name);

    const hits = nameQueryTokens.filter(t => nameDbTokens.includes(t));
    const missed = nameDbTokens.filter(t => !nameQueryTokens.includes(t) && !STOP_WORDS.has(t));

    const specificWords = ['petit','grand','blanc','rouge','rose','brut','sec','demi','nature',
      'premier','cru','village','reserve','riserva','classico','superiore','vieilles','vigne',
      'monopole','combes','forest','vaillons','montee','perrieres'];
    const missedSpecific = missed.filter(t => specificWords.includes(t));

    score += hits.length * 4;
    score -= missed.length * 3;
    score -= missedSpecific.length * 6;

    if (nameQueryTokens.length > 0 && nameDbTokens.length > 0) {
      const ratio = nameQueryTokens.length / nameDbTokens.length;
      if (ratio < 0.4) score -= 8;
    }
  }

  if (normProducer && normProducer.length > 2) {
    const prodQueryTokens = tokenizeSignificant(normProducer);
    const prodDbTokens = tokenizeSignificant(w.producer || '');

    if (dbProducer === normalize(normProducer)) {
      score += 20;
    } else {
      const prodHits = prodQueryTokens.filter(t => prodDbTokens.includes(t));
      const prodMissed = prodDbTokens.filter(t => !prodQueryTokens.includes(t));
      score += prodHits.length * 6;
      score -= prodMissed.length * 4;
      if (prodHits.length === 0) score -= 20;
    }
  } else {
    const nameQueryTokens = tokenizeSignificant(normName);
    const prodHitsInName = dbProducerTokens.filter(t => nameQueryTokens.includes(t));
    score += prodHitsInName.length * 5;
  }

  for (const alias of aliases) {
    const aliasClean = normalizeNoStop(alias);
    const nameClean = normalizeNoStop(normName);
    if (aliasClean === nameClean) { score += 20; break; }
    if (aliasClean.includes(nameClean) || nameClean.includes(aliasClean)) { score += 12; break; }
  }

  return Math.max(0, score);
}

async function matchBatch(wines) {
  const keywords = new Set();
  wines.forEach(w => {
    tokenizeSignificant(w.name).slice(0, 3).forEach(k => keywords.add(k));
    tokenizeSignificant(w.producer || '').slice(0, 2).forEach(k => keywords.add(k));
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
    const normProducer = normalize(w.producer || '');
    const nameParts = tokenizeSignificant(w.name);
    const producerParts = tokenizeSignificant(w.producer || '');

    let best = null, bestScore = 10;
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

function calcStealScore(restaurantPrice, marketPrice) {
  if (!marketPrice || !restaurantPrice) return 0;
  const discount = (marketPrice - restaurantPrice) / marketPrice;
  if (discount <= 0) return 0;
  return Math.min(100, Math.round(discount * 100));
}

async function upsertRestaurant(name, city) {
  try {
    const existing = await sbGet(`restaurants?name=ilike.${encodeURIComponent(name)}&limit=1&select=id,name`);
    if (existing.length > 0) {
      await sbPatch(`restaurants?id=eq.${existing[0].id}`, { last_scanned_at: new Date().toISOString() });
      return existing[0].id;
    }
    const created = await sbPost('restaurants', { name, city: city || 'Amsterdam', last_scanned_at: new Date().toISOString() });
    return created[0]?.id;
  } catch(e) {
    console.warn('upsertRestaurant error:', e.message);
    return null;
  }
}

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

async function saveUnmatchedAsPending(wines) {
  const unmatched = wines.filter(w => !w.matched && w.name && w.name.length > 1);
  if (!unmatched.length) return;
  try {
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
  if (text.length > 500000) return res.status(400).json({ error: 'Tekst te lang (max 500.000 tekens)' });

  try {
    // ── STAP 1: Splits tekst in chunks van max 15.000 chars ──
    // Grotere chunks = minder API calls, minder kans op gemiste wijnen
    const CHUNK_SIZE = 15000;

    const prompt = `Je bent een expert in het lezen van restaurantwijnkaarten. Extraheer ALLE wijnen als JSON array.

Geef ALLEEN een JSON array terug, geen uitleg of markdown. Elk object heeft exact deze velden:
- name: de specifieke cuvée/wijn naam (bijv. "Petit Chablis", "Brut Rosé", "Barolo Riserva", "1er Cru Vaillons")
- producer: het wijnhuis of de producent (bijv. "Vincent Dauvissat", "Bollinger", "Ceretto")
- vintage: het jaartal als integer, of null als NV of niet vermeld
- price: de FLESPRIJS als getal (bij glas+fles prijzen: neem de hoogste)

KRITIEKE REGELS:
1. De PRODUCENT is altijd het wijnhuis/domaine/château
2. De NAAM is altijd de specifieke cuvée of appellation
3. Negeer: sectieheaders (ROOD, WIT, CHAMPAGNE etc.), beschrijvingen, cocktails, bier, water
4. Elke wijn op een aparte regel in de kaart = een apart object
5. Dezelfde wijn in meerdere jaargangen = meerdere objecten (één per jaargang)
6. Geen glasprijs-only entries (alleen als er ook een flesprijs is)
7. Magnums en halve flessen: apart opnemen met price van die flesformaat

Dit is DEEL van een grote wijnkaart. Extraheer ALLE wijnen die je ziet, ook al zijn het er veel.
Wijnkaart van ${restaurant || 'restaurant'}:
`;

    // Split op lege regels om wijnen niet door te knippen
    const chunks = [];
    if (text.length <= CHUNK_SIZE) {
      chunks.push(text);
    } else {
      const lines = text.split('\n');
      let current = '';
      for (const line of lines) {
        if ((current + '\n' + line).length > CHUNK_SIZE && current.length > 1000) {
          chunks.push(current);
          current = line;
        } else {
          current += (current ? '\n' : '') + line;
        }
      }
      if (current.length > 100) chunks.push(current);
    }

    console.log(`Processing ${chunks.length} chunk(s), total ${text.length} chars`);

    // ── STAP 2: Verwerk chunks — max 2 tegelijk om timeouts te voorkomen ──
    let allWinesRaw = [];
    const PARALLEL = 2;
    for (let i = 0; i < chunks.length; i += PARALLEL) {
      const batch = chunks.slice(i, i + PARALLEL);
      const results = await Promise.all(batch.map(async (chunk, idx) => {
        try {
          const chunkNum = i + idx + 1;
          console.log(`Chunk ${chunkNum}/${chunks.length}: ${chunk.length} chars`);
          const message = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 16000,  // Verhoogd van 8000 naar 16000
            messages: [{ role: 'user', content: prompt + chunk + '\n\nJSON array:' }]
          });
          let raw = message.content[0].text.trim()
            .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
          try {
            const parsed = JSON.parse(raw);
            console.log(`Chunk ${chunkNum}: ${parsed.length} wijnen gevonden`);
            return parsed;
          } catch {
            const m = raw.match(/\[[\s\S]*\]/);
            if (m) {
              const parsed = JSON.parse(m[0]);
              console.log(`Chunk ${chunkNum}: ${parsed.length} wijnen gevonden (fallback parse)`);
              return parsed;
            }
            console.warn(`Chunk ${chunkNum}: parse mislukt`);
            return [];
          }
        } catch(e) {
          console.warn(`Chunk ${i + idx + 1} error:`, e.message);
          return [];
        }
      }));
      results.forEach(r => allWinesRaw.push(...r));
    }

    console.log(`Totaal geëxtraheerd voor deduplicatie: ${allWinesRaw.length} wijnen`);

    // ── STAP 3: Filter en dedupliceer ──
    // Deduplicatie op naam + producent + JAARGANG — zelfde wijn in ander jaar telt als apart item
    let wines = allWinesRaw
      .filter(w => w.price && w.price > 5 && w.price < 15000 && w.name?.length > 1)
      .map(w => ({
        name: String(w.name || '').trim(),
        producer: String(w.producer || '').trim(),
        vintage: w.vintage ? parseInt(w.vintage) : null,
        price: parseFloat(w.price)
      }));

    const seen = new Set();
    wines = wines.filter(w => {
      // Key bevat jaargang zodat dezelfde wijn in 2015 en 2018 BEIDE bewaard worden
      const key = normalize(w.name + '|' + w.producer + '|' + (w.vintage || 'nv') + '|' + Math.round(w.price));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`Na deduplicatie: ${wines.length} unieke wijnen`);

    // ── STAP 4: Match wijnen tegen database ──
    const MATCH_BATCH = 15;
    const results = [];
    for (let i = 0; i < wines.length; i += MATCH_BATCH) {
      const batch = wines.slice(i, i + MATCH_BATCH);
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

    // ── STAP 5: Sla op in database (fire & forget) ──
    if (restaurant) {
      upsertRestaurant(restaurant, city).then(restaurantId => {
        saveScanResults(restaurantId, results);
      }).catch(e => console.warn('save error:', e.message));
    }
    saveUnmatchedAsPending(results).catch(e => console.warn('pending save error:', e.message));

    console.log(`Scan klaar: ${results.length} wijnen, ${results.filter(w => w.matched).length} gematcht, ${results.filter(w => w.steal_score > 0).length} steals`);

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

// ── PRICE LOOKUP ──
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

confidence: "high" (ken je goed, ±10%), "medium" (redelijk bekend, ±25%), "low" (weinig info). Als echt onbekend: price:null

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
