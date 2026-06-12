// WineSteals server v3 - STRICT MATCHING
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

// Alleen echte leeswoordjes/functiewoorden - GEEN cuvÃ©e-onderscheidende woorden
const STOP_WORDS = new Set([
  'de','du','des','d','l','le','la','les','et','and','von','van','del','della','di','dei','al','the',
  'a','an','of','or','en','sur','aux'
]);

// "Type" woorden die voor producers worden gebruikt
const PRODUCER_PREFIXES = new Set([
  'chateau','chÃ¢teau','domaine','domain','maison','cave','cellier','clos','domaines',
  'tenuta','azienda','weingut','bodega','vina','viÃ±a','quinta'
]);

function normalize(s) {
  if (!s) return '';
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Verwijder stopwoorden EN producer-prefixes voor eerlijke vergelijking
function normalizeStrict(s) {
  if (!s) return '';
  return normalize(s).split(' ')
    .filter(w => w.length > 1 && !STOP_WORDS.has(w) && !PRODUCER_PREFIXES.has(w))
    .join(' ').trim();
}

function tokensStrict(s) {
  if (!s) return [];
  return normalize(s).split(' ')
    .filter(w => w.length > 1 && !STOP_WORDS.has(w) && !PRODUCER_PREFIXES.has(w));
}

// ââ STRIKTE MATCHING ââ
// Een match wordt alleen geaccepteerd als:
// 1. ALLE betekenisvolle woorden uit de DB naam in de query staan
// 2. ALLE betekenisvolle woorden uit de query in de DB naam staan
// 3. Producer woorden overlappen significant
function scoreStrict(dbWine, queryName, queryProducer) {
  const dbNameTokens = tokensStrict(dbWine.name);
  const dbProducerTokens = tokensStrict(dbWine.producer || '');
  const queryNameTokens = tokensStrict(queryName);
  const queryProducerTokens = tokensStrict(queryProducer);

  if (dbNameTokens.length === 0 || queryNameTokens.length === 0) return 0;

  // ââ NAAM CHECK ââ
  // Elke token in DB naam MOET in query naam staan (of in query producer als fallback)
  // En vice versa
  const queryNameSet = new Set(queryNameTokens);
  const queryProducerSet = new Set(queryProducerTokens);
  const dbNameSet = new Set(dbNameTokens);
  const dbProducerSet = new Set(dbProducerTokens);

  // Combineer query naam + producer als Ã©Ã©n pool (soms staat producent in de naam)
  const queryPool = new Set([...queryNameTokens, ...queryProducerTokens]);
  const dbPool = new Set([...dbNameTokens, ...dbProducerTokens]);

  // KRITIEK: alle DB naam tokens moeten in query pool zitten
  const missingFromQuery = dbNameTokens.filter(t => !queryPool.has(t));
  if (missingFromQuery.length > 0) {
    // De DB wijn heeft een extra cuvÃ©e-naam die niet in de query staat
    // Bijv DB="Bandol La Tourtine", Query="Bandol" â "la", "tourtine" missen
    return 0;
  }

  // Alle query naam tokens moeten in db pool zitten
  const missingFromDb = queryNameTokens.filter(t => !dbPool.has(t));
  if (missingFromDb.length > 0) {
    // De query heeft een specifieke naam die niet in DB staat
    // Bijv Query="Bandol La Tourtine", DB="Bandol" â "la", "tourtine" missen in DB
    return 0;
  }

  // ââ PRODUCER CHECK ââ
  // Als er een query producer is, moet er overlap zijn met DB producer
  if (queryProducerTokens.length > 0 && dbProducerTokens.length > 0) {
    const producerOverlap = queryProducerTokens.filter(t => dbProducerSet.has(t)).length;
    if (producerOverlap === 0) {
      // Geen enkele producent-token overeen â andere producent
      return 0;
    }
    // Bij gedeeltelijke overlap (1 op 2 woorden): toch valid als sterk woord
    const producerCoverage = producerOverlap / Math.max(dbProducerTokens.length, queryProducerTokens.length);
    if (producerCoverage < 0.5) return 0;
  } else if (queryProducerTokens.length === 0 && dbProducerTokens.length > 0) {
    // Geen producer in query â check of producer tokens in query naam staan
    const producerInName = dbProducerTokens.filter(t => queryNameSet.has(t)).length;
    if (producerInName === 0) return 0;
  }

  // ââ SCORE BEREKENEN ââ
  // Hoe meer tokens overeenkomen, hoe hoger de score
  // Maximum: alle tokens komen 1-op-1 overeen
  let score = 100;

  // Penalty voor "uneven" matches (DB heeft veel meer of minder tokens)
  const lengthDiff = Math.abs(dbNameTokens.length - queryNameTokens.length);
  score -= lengthDiff * 5;

  // Bonus voor exacte vintage match
  if (dbWine.vintage && queryName.vintage && dbWine.vintage === queryName.vintage) {
    score += 10;
  }

  // ââ ALIAS CHECK ââ
  // Als er aliases zijn die exact matchen, bonus
  const aliases = (dbWine.search_aliases || []).map(a => tokensStrict(a));
  for (const aliasTokens of aliases) {
    if (aliasTokens.length === 0) continue;
    const aliasMatch = aliasTokens.every(t => queryPool.has(t)) &&
                       queryNameTokens.every(t => new Set([...aliasTokens, ...dbProducerTokens]).has(t));
    if (aliasMatch) {
      score += 20;
      break;
    }
  }

  return Math.max(0, score);
}

async function matchBatch(wines) {
  // Verzamel keywords om kandidaten op te halen
  const keywords = new Set();
  wines.forEach(w => {
    tokensStrict(w.name).slice(0, 3).forEach(k => keywords.add(k));
    tokensStrict(w.producer || '').slice(0, 2).forEach(k => keywords.add(k));
  });

  const fields = 'id,name,producer,vintage,region,country,colour,market_price_eur,market_price_min,market_price_max,search_aliases';
  const orTerms = [...keywords].slice(0, 20)
    .map(k => `name.ilike.*${encodeURIComponent(k)}*,producer.ilike.*${encodeURIComponent(k)}*`)
    .join(',');

  let candidates = [];
  try {
    candidates = await sbGet(`wines?or=(${orTerms})&limit=80&select=${fields}`);
  } catch(e) {
    console.warn('matchBatch error:', e.message);
    return wines.map(() => null);
  }

  // Haal jaargang-specifieke prijzen op
  const candidateIds = candidates.map(c => c.id);
  let vintagePrices = [];
  if (candidateIds.length > 0) {
    const years = wines.map(w => w.vintage).filter(Boolean);
    const minY = years.length ? Math.min(...years) - 3 : 1990;
    const maxY = years.length ? Math.max(...years) + 3 : 2025;
    try {
      vintagePrices = await sbGet(
        `wine_vintage_prices?wine_id=in.(${candidateIds.join(',')})&vintage=gte.${minY}&vintage=lte.${maxY}&select=wine_id,vintage,market_price_eur,market_price_min,market_price_max`
      );
    } catch(e) {
      console.warn('vintage prices error:', e.message);
    }
  }

  const vpLookup = {};
  for (const vp of vintagePrices) {
    if (!vpLookup[vp.wine_id]) vpLookup[vp.wine_id] = {};
    vpLookup[vp.wine_id][vp.vintage] = vp;
  }

  return wines.map(w => {
    // STRIKTE matching: minimum score 80 om geaccepteerd te worden
    const MIN_SCORE = 80;
    let best = null;
    let bestScore = MIN_SCORE - 1;

    for (const c of candidates) {
      const s = scoreStrict(c, w.name, w.producer || '');
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }

    if (!best) {
      console.log(`Geen match: "${w.name}" / "${w.producer}"`);
      return null;
    }

    console.log(`Match (score ${bestScore}): "${w.name}" â "${best.name}" / "${best.producer}"`);

    // Bepaal de juiste prijs voor de jaargang
    let priceData = null;
    if (w.vintage && vpLookup[best.id]) {
      if (vpLookup[best.id][w.vintage]) {
        priceData = vpLookup[best.id][w.vintage];
      } else {
        // Probeer max 3 jaar verschil
        let minDiff = 999, closest = null;
        for (const [yr, data] of Object.entries(vpLookup[best.id])) {
          const diff = Math.abs(parseInt(yr) - w.vintage);
          if (diff <= 3 && diff < minDiff) { minDiff = diff; closest = data; }
        }
        priceData = closest;
      }
    }
    if (!priceData && best.market_price_eur) {
      priceData = {
        market_price_eur: best.market_price_eur,
        market_price_min: best.market_price_min,
        market_price_max: best.market_price_max
      };
    }

    return {
      ...best,
      match_score: bestScore,
      market_price_eur: priceData?.market_price_eur || null,
      market_price_min: priceData?.market_price_min || null,
      market_price_max: priceData?.market_price_max || null
    };
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
    await sbPost('scan_results', steals.map(w => ({
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
    })));
  } catch(e) {
    console.warn('saveScanResults error:', e.message);
  }
}

async function saveUnmatchedAsPending(wines) {
  const unmatched = wines.filter(w => !w.matched && w.name && w.name.length > 1);
  if (!unmatched.length) return;
  try {
    const toInsert = [];
    for (const w of unmatched) {
      try {
        const nm = encodeURIComponent(w.name.trim());
        // Check alle bestaande records (ook niet-pending)
        // Zoek op naam zonder vintage filter zodat verwijderde items niet terugkomen
        const existing = await sbGet(
          `wines?name=ilike.${nm}&select=id,price_source,seen_count`
        );
        if (!existing.length) {
          // Nieuw: toevoegen als pending
          toInsert.push({
            name: w.name.trim(),
            producer: w.producer?.trim() || null,
            vintage: w.vintage || null,
            colour: w.colour || null,
            region: w.region?.split(' Â· ')[0] || null,
            country: w.region?.split(' Â· ')[1] || null,
            price_source: 'pending',
            seen_count: 1,
            seen_list_price: w.price || null
          });
        } else {
          // Bestaand pending: seen_count ophogen
          const pend = existing.find(e => e.price_source === 'pending');
          if (pend) {
            await sbPatch(`wines?id=eq.${pend.id}`, {
              seen_count: (pend.seen_count || 1) + 1,
              seen_list_price: w.price || null
            });
          }
          // Niet-pending (goedgekeurd of handmatig verwijderd): NIET opnieuw aanmaken
        }
      } catch(e) { /* skip */ }
    }
    if (toInsert.length > 0) {
      await sbPost('wines', toInsert);
      console.log(`Pending saved: ${toInsert.length}`);
    }
  } catch(e) {
    console.warn('saveUnmatchedAsPending error:', e.message);
  }
}

// ââ ENDPOINTS ââ

app.get('/steals', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const since = new Date(Date.now() - (parseInt(req.query.days) || 90) * 86400000).toISOString();
    const r = await sbGet(
      `scan_results?is_steal=eq.true&scanned_at=gte.${since}&order=steal_score.desc&limit=${limit}&select=wine_name,producer,vintage,restaurant_price,market_price,steal_score,colour,region,scanned_at,restaurant_id,restaurants(name,city,lat,lng)`
    );
    res.json({ success: true, steals: r });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/restaurants', async (req, res) => {
  try {
    const r = await sbGet('restaurants?order=last_scanned_at.desc&limit=100&select=id,name,city,lat,lng,last_scanned_at');
    res.json({ success: true, restaurants: r });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/scan', async (req, res) => {
  const { text, restaurant, city } = req.body;
  if (!text || text.length < 20) return res.status(400).json({ error: 'Geen tekst' });
  if (text.length > 500000) return res.status(400).json({ error: 'Tekst te lang' });

  try {
    const CHUNK_SIZE = 15000;
    const prompt = `Je bent een expert in het lezen van restaurantwijnkaarten. Extraheer ALLE wijnen als JSON array.

Geef ALLEEN een JSON array terug, geen uitleg of markdown. Elk object:
- name: de VOLLEDIGE specifieke cuvÃ©e/wijn naam, inclusief alle onderscheidende woorden
- producer: het wijnhuis of de producent (alleen de naam, zonder "Domaine"/"ChÃ¢teau")
- vintage: het jaartal als integer, of null
- price: flesprijs als getal

KRITIEKE REGELS:
1. Neem ALTIJD de volledige cuvÃ©e-naam mee. "Bandol La Tourtine" is NIET hetzelfde als "Bandol".
2. Specifieke woorden zoals "La Tourtine", "La Migoua", "Vieilles Vignes", "Premier Cru", "Grand Cru", "RÃ©serve", "CuvÃ©e SpÃ©ciale" zijn ESSENTIEEL â laat ze NOOIT weg.
3. Voorbeelden:
   - "Bandol - La Tourtine Domaine Tempier 2020" â name: "Bandol La Tourtine", producer: "Tempier", vintage: 2020
   - "Bandol Domaine Tempier 2020" â name: "Bandol", producer: "Tempier", vintage: 2020
   - "Gevrey-Chambertin 1er Cru - Lavaux Saint-Jacques" â name: "Gevrey-Chambertin 1er Cru Lavaux Saint-Jacques"
4. Negeer sectieheaders, beschrijvingen, cocktails, bier, water
5. Zelfde wijn in meerdere jaargangen = meerdere objecten
6. Geen glasprijs-only entries

Wijnkaart van ${restaurant || 'restaurant'}:
`;

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

    console.log(`Processing ${chunks.length} chunks, ${text.length} chars totaal`);

    let allWinesRaw = [];
    for (let i = 0; i < chunks.length; i += 2) {
      const batch = chunks.slice(i, i + 2);
      const results = await Promise.all(batch.map(async (chunk, idx) => {
        try {
          const n = i + idx + 1;
          const msg = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 16000,
            messages: [{ role: 'user', content: prompt + chunk + '\n\nJSON array:' }]
          });
          let raw = msg.content[0].text.trim()
            .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
          try {
            const p = JSON.parse(raw);
            console.log(`Chunk ${n}: ${p.length} wijnen`);
            return p;
          } catch {
            const m = raw.match(/\[[\s\S]*\]/);
            if (m) { const p = JSON.parse(m[0]); console.log(`Chunk ${n}: ${p.length} wijnen (fallback)`); return p; }
            console.warn(`Chunk ${n}: parse mislukt`);
            return [];
          }
        } catch(e) {
          console.warn(`Chunk ${i + idx + 1} fout:`, e.message);
          return [];
        }
      }));
      results.forEach(r => allWinesRaw.push(...r));
    }

    console.log(`Totaal voor dedup: ${allWinesRaw.length}`);

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
      const key = normalize(w.name + '|' + w.producer + '|' + (w.vintage || 'nv') + '|' + Math.round(w.price));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`Na dedup: ${wines.length} unieke wijnen`);

    const results = [];
    for (let i = 0; i < wines.length; i += 15) {
      const batch = wines.slice(i, i + 15);
      const matched = await matchBatch(batch);
      batch.forEach((w, j) => {
        const db = matched[j];
        const stealScore = calcStealScore(w.price, db?.market_price_eur);
        results.push({
          ...w,
          matched: !!(db?.market_price_eur),
          match_score: db?.match_score || 0,
          region: db ? [db.region, db.country].filter(Boolean).join(' Â· ') : null,
          colour: db?.colour || null,
          market_price_eur: db?.market_price_eur || null,
          market_price_min: db?.market_price_min || null,
          market_price_max: db?.market_price_max || null,
          matched_name: db?.name || null,
          matched_producer: db?.producer || null,
          steal_score: stealScore
        });
      });
    }

    if (restaurant) {
      upsertRestaurant(restaurant, city).then(id => saveScanResults(id, results)).catch(e => console.warn('save:', e.message));
    }
    saveUnmatchedAsPending(results).catch(e => console.warn('pending:', e.message));

    console.log(`Klaar: ${results.length} wijnen, ${results.filter(w => w.matched).length} gematcht, ${results.filter(w => w.steal_score > 0).length} steals`);

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

app.post('/price-lookup', async (req, res) => {
  const { wines } = req.body;
  if (!wines || !Array.isArray(wines) || !wines.length) return res.status(400).json({ error: 'Geen wijnen' });
  if (wines.length > 30) return res.status(400).json({ error: 'Max 30 wijnen' });

  const wineList = wines.map((w, i) =>
    `${i + 1}. "${w.name}" â ${w.producer || 'onbekend'}${w.vintage ? ', ' + w.vintage : ''}${w.country && w.country !== 'Unknown' ? ', ' + w.country : ''}`
  ).join('\n');

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: `Geef retailmarktprijs EUR voor elke wijn. Alleen JSON array, geen uitleg.
Elk object: {"index":N,"price":45.00,"confidence":"high/medium/low","note":"max 8 woorden"}
Als onbekend: price:null

Wijnen:
${wineList}

JSON array:` }]
    });
    let raw = msg.content[0].text.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    let prices;
    try { prices = JSON.parse(raw); } catch { const m = raw.match(/\[[\s\S]*\]/); prices = m ? JSON.parse(m[0]) : []; }
    res.json({ success: true, prices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// ── CT PROXY ENDPOINT ──
app.get('/ct-search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q parameter required' });
  const cookie = process.env.CT_COOKIE || '';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Cookie': cookie
  };
  try {
    // Stap 1: zoek pagina
    const searchUrl = 'https://www.cellartracker.com/list.asp?Table=List&szSearch=' + encodeURIComponent(q) + '&fInCellar=0&iUserOverride=0';
    const r1 = await fetch(searchUrl, { headers });
    const html1 = await r1.text();
    const iWines = [...new Set([...html1.matchAll(/iWine=(\d+)/g)].map(m => m[1]))].slice(0, 25);
    if (!iWines.length) return res.json({ found: false, vintages: [] });

    // Stap 2: per iWine vintage + prijs ophalen
    const vintages = [];
    for (const iWine of iWines) {
      try {
        const wr = await fetch('https://www.cellartracker.com/wine.asp?iWine=' + iWine, { headers });
        const whtml = await wr.text();
        const titleM = whtml.match(/<title>(\d{4})\s+([^,<]+)/);
        const vintage = titleM ? parseInt(titleM[1]) : null;
        const wineName = titleM ? titleM[2].trim() : q;
        const pr = await fetch('https://www.cellartracker.com/wheretobuy/' + iWine + '/prices', { headers });
        const pj = await pr.json();
        const ph = pj.html || '';
        const pm = ph.match(/(\d+)[,\.](\d{2})/);
        const price = pm ? parseFloat(pm[0].replace(',', '.')) : null;
        vintages.push({ iWine, vintage, name: wineName, price });
        await new Promise(r => setTimeout(r, 200));
      } catch(e) { /* skip */ }
    }
    res.json({ found: true, vintages });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`WineSteals server v3 (strict matching) poort ${PORT}`));
