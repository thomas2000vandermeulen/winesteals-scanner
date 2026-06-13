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
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtkaGN6bGFiamVjcXhseXV4cHJsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NjAwMjUzMSwiZXhwIjoyMDkxNTc4NTMxfQ.8Ok37JAr6c4IDb4RZuOKY2nddje7e-nLdQYa7jLUJhs';

async function sbGet(endpoint) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase GET ${res.status}`);
  return res.json();
}

async function sbPost(endpoint, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(data)
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Supabase POST ${res.status}: ${t}`); }
}

async function sbPatch(endpoint, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(data)
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Supabase PATCH ${res.status}: ${t}`); }
}

// ── SCORE FUNCTIONS ──
function calcStealScore(restaurantPrice, marketPrice) {
  if (!restaurantPrice || !marketPrice || marketPrice <= 0) return 0;
  const ratio = restaurantPrice / marketPrice;
  if (ratio >= 1.0) return 0;
  const discount = 1 - ratio;
  return Math.min(100, Math.round(discount * 150));
}

// ── STRICT MATCHING ──
function tokenize(str) {
  return (str || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !['de','le','la','les','du','des','di','del','della','van','von','the','and','et','en','rouge','blanc','rosé','rose','grand','cru','premier','vieilles','vignes','vigne','chateau','domaine','mas','maison','cave','caves','wine','winery','estate','cellars','vineyards','vineyard'].includes(t));
}

function scoreStrict(scanned, dbWine) {
  const scanName = tokenize(scanned.name);
  const dbName = tokenize(dbWine.name);
  const scanProd = tokenize(scanned.producer || '');
  const dbProd = tokenize(dbWine.producer || '');
  const scanAll = [...new Set([...scanName, ...scanProd])];
  const dbAll = [...new Set([...dbName, ...dbProd])];
  if (!scanAll.length || !dbAll.length) return 0;
  const inDb = scanAll.filter(t => dbAll.includes(t)).length;
  const inScan = dbAll.filter(t => scanAll.includes(t)).length;
  const recall = inDb / scanAll.length;
  const precision = inScan / dbAll.length;
  if (recall < 0.6 || precision < 0.6) return 0;
  const score = (recall + precision) / 2 * 100;
  if (scanned.vintage && dbWine.vintage && scanned.vintage !== dbWine.vintage) return score * 0.7;
  return score;
}

// ── SAVE FUNCTIONS ──
async function saveUnmatchedAsPending(wines) {
  const unmatched = wines.filter(w => !w.matched && w.name && w.name.length > 1);
  if (!unmatched.length) return;
  try {
    const toInsert = [];
    for (const w of unmatched) {
      try {
        const nm = encodeURIComponent(w.name.trim());
        const existing = await sbGet(`wines?name=ilike.${nm}&select=id,price_source,seen_count`);
        if (!existing.length) {
          toInsert.push({
            name: w.name.trim(),
            producer: w.producer?.trim() || null,
            vintage: w.vintage || null,
            colour: w.colour || null,
            region: w.region?.split(' · ')[0] || null,
            country: w.region?.split(' · ')[1] || null,
            price_source: 'pending',
            seen_count: 1,
            seen_list_price: w.price || null
          });
        } else {
          const pend = existing.find(e => e.price_source === 'pending');
          if (pend) {
            await sbPatch(`wines?id=eq.${pend.id}`, {
              seen_count: (pend.seen_count || 1) + 1,
              seen_list_price: w.price || null
            });
          }
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

async function saveScanResults(restaurantId, results) {
  const matched = results.filter(w => w.matched && w.steal_score > 0);
  if (!matched.length) return;
  try {
    const rows = matched.map(w => ({
      restaurant_id: restaurantId,
      wine_id: w.wine_id,
      wine_name: w.name,
      producer: w.producer,
      vintage: w.vintage,
      restaurant_price: w.price,
      market_price: w.market_price,
      steal_score: w.steal_score,
      colour: w.colour,
      region: w.region,
      scanned_at: new Date().toISOString()
    }));
    await sbPost('scan_results', rows);
    console.log(`Scan results saved: ${rows.length}`);
  } catch(e) {
    console.warn('saveScanResults error:', e.message);
  }
}

// ── SCAN ENDPOINT ──
app.post('/scan', async (req, res) => {
  const { wines, restaurantId } = req.body;
  if (!wines || !wines.length) return res.status(400).json({ error: 'No wines provided' });

  try {
    const dbWines = await sbGet('wines?price_source=neq.pending&market_price_eur=not.is.null&limit=10000&select=id,name,producer,vintage,colour,region,market_price_eur,market_price_min,market_price_max');

    const results = wines.map(w => {
      let bestScore = 0, bestMatch = null;
      for (const db of dbWines) {
        const score = scoreStrict(w, db);
        if (score > bestScore) { bestScore = score; bestMatch = db; }
      }
      if (bestScore >= 80 && bestMatch) {
        const marketPrice = bestMatch.market_price_eur;
        const stealScore = calcStealScore(w.price, marketPrice);
        return {
          ...w,
          matched: true,
          wine_id: bestMatch.id,
          market_price: marketPrice,
          steal_score: stealScore,
          colour: bestMatch.colour || w.colour,
          region: bestMatch.region || w.region,
          match_score: bestScore
        };
      }
      return { ...w, matched: false };
    });

    if (restaurantId) {
      await saveScanResults(restaurantId, results).catch(e => console.warn('scan save:', e.message));
      await saveUnmatchedAsPending(results).catch(e => console.warn('pending:', e.message));
    }

    res.json({ results, matched: results.filter(r => r.matched).length, total: results.length });
  } catch(e) {
    console.error('Scan error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── EXTRACT ENDPOINT ──
app.post('/extract', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `Extract all wines from this restaurant wine list. Return ONLY valid JSON array.

For each wine extract:
- name: wine name WITHOUT producer (e.g. "Barolo", "Bandol Rouge", "Château Margaux")
- producer: the winery/producer name (e.g. "Ceretto", "Domaine Tempier")
- vintage: year as integer or null
- price: price in euros as number or null
- colour: "red", "white", "sparkling", "rosé", "dessert", or "orange"
- region: region · country (e.g. "Bordeaux · France", "Barolo · Italy")

Wine list text:
${text}

Return ONLY a JSON array, no other text.`
      }]
    });

    const content = msg.content[0].text;
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.status(400).json({ error: 'No JSON found in response' });
    const wines = JSON.parse(jsonMatch[0]);
    res.json({ wines });
  } catch(e) {
    console.error('Extract error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── STEALS ENDPOINT ──
app.get('/steals', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const days = parseInt(req.query.days) || 90;
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const data = await sbGet(`scan_results?scanned_at=gte.${since}&steal_score=gt.0&order=steal_score.desc&limit=${limit}&select=wine_name,producer,vintage,restaurant_price,market_price,steal_score,colour,region,scanned_at,restaurant_id,restaurants(name,city,lat,lng)`);
    res.json({ steals: data });
  } catch(e) {
    res.status(500).json({ error: e.message });
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
    // Stap 1: zoekpagina ophalen
    const searchUrl = 'https://www.cellartracker.com/list.asp?Table=List&szSearch=' + encodeURIComponent(q) + '&fInCellar=0&iUserOverride=0';
    const r1 = await fetch(searchUrl, { headers, signal: AbortSignal.timeout(10000) });
    const html1 = await r1.text();

    // Unieke iWine IDs ophalen
    const iWines = [...new Set([...html1.matchAll(/iWine=(\d+)/g)].map(m => m[1]))].slice(0, 15);
    if (!iWines.length) return res.json({ found: false, vintages: [] });

    // Stap 2: prijzen parallel ophalen in batches van 5
    const vintages = iWines.map(iWine => ({ iWine, vintage: null, name: q, price: null }));
    const BATCH = 5;

    for (let i = 0; i < vintages.length; i += BATCH) {
      const batch = vintages.slice(i, i + BATCH);
      await Promise.all(batch.map(async (v) => {
        try {
          // Prijs ophalen
          const pr = await fetch(`https://www.cellartracker.com/wheretobuy/${v.iWine}/prices`, {
            headers, signal: AbortSignal.timeout(5000)
          });
          const pj = await pr.json();
          const ph = pj.html || '';
          const pm = ph.match(/(\d+)[,\.](\d{2})/);
          v.price = pm ? parseFloat(pm[0].replace(',', '.')) : null;

          // Vintage + naam ophalen
          const wr = await fetch(`https://www.cellartracker.com/wine.asp?iWine=${v.iWine}`, {
            headers, signal: AbortSignal.timeout(5000)
          });
          const whtml = await wr.text();
          const titleM = whtml.match(/<title>(\d{4})\s+([^,<]+)/);
          if (titleM) { v.vintage = parseInt(titleM[1]); v.name = titleM[2].trim(); }
        } catch(e) { /* timeout of fout — skip */ }
      }));
    }

    res.json({ found: true, vintages: vintages.filter(v => v.vintage) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HEALTH CHECK ──
app.get('/health', (req, res) => res.json({ status: 'ok', version: 'v3' }));

app.listen(PORT, () => console.log(`WineSteals server v3 (strict matching) poort ${PORT}`));
