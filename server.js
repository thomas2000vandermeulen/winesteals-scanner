const express = require('express');
const cors = require('cors');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/scan', async (req, res) => {
  const { text, restaurant } = req.body;
  if (!text || text.length < 20) return res.status(400).json({ error: 'Geen tekst' });
  if (text.length > 100000) return res.status(400).json({ error: 'Tekst te lang' });

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: `Je bent een expert in het lezen van restaurantwijnkaarten.
Extraheer ALLEEN de wijnen die op de kaart staan als JSON array.

Strikte regels:
- Geef ALLEEN een JSON array terug, geen uitleg of andere tekst
- Negeer sectieheaders: "ROOD", "WIT", "BUBBELS", "CHAMPAGNE", "MUIS", "GLAS", "PER GLAS" etc.
- Negeer beschrijvingen van druivenrassen en regio's (bijv. "Pinot Noir - Champagne, Frankrijk")
- Negeer aperitief, cocktails, bier, frisdrank, water, koffie
- Negeer paginanummers, kopteksten, voetteksten
- Elke wijn: name, producer, vintage (null als NV), price (getal = FLESPRIJS), bottle_format (null tenzij magnum/halve fles)
- Bij twee prijzen glas+fles (bijv. "11  65" of "9.5 / 47.5"): gebruik ALTIJD de HOOGSTE = flesprijs
- Als er ALLEEN een glasprijs staat (bijv. "8 /" zonder tweede getal): sla de wijn OVER
- Naam = appellation of wijnnaam (bijv. "Morgon", "Gevrey-Chambertin 1er Cru")
- Producer = producent of domaine (bijv. "Foillard", "Rossignol-Trapet")
- Vintage = heel getal of null. PDF-artefact "202 2" = 2022
- Geen duplicaten: zelfde wijn maar dan 1x opnemen
- Als een regel geen duidelijke wijnnaam + prijs heeft: sla over

Wijnkaart van ${restaurant || 'restaurant'}:

${text}

Geef ALLEEN een JSON array:` }]
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
        bottle_format: w.bottle_format || null
      }));

    // Dedupliceer
    const seen = new Set();
    wines = wines.filter(w => {
      const key = (w.name + w.producer + w.vintage).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });

    res.json({ success: true, wines, count: wines.length, tokens_used: message.usage.input_tokens + message.usage.output_tokens });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('WineSteals AI Scanner poort ' + PORT));
