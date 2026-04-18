const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS — alleen WineSteals domeinen toestaan
app.use(cors({
  origin: [
    'https://winesteals.nl',
    'https://www.winesteals.nl',
    'https://thomas2000vandermeulen.github.io',
    'http://localhost:3000',
    'http://localhost:5500'
  ]
}));

app.use(express.json({ limit: '2mb' }));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Health check
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Hoofd endpoint — verwerk wijnkaart tekst
app.post('/scan', async (req, res) => {
  const { text, restaurant } = req.body;

  if (!text || text.length < 20) {
    return res.status(400).json({ error: 'Geen tekst ontvangen' });
  }

  if (text.length > 100000) {
    return res.status(400).json({ error: 'Tekst te lang (max 100.000 tekens)' });
  }

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `Je bent een expert in het lezen van restaurantwijnkaarten. 
Extraheer ALLE wijnen uit onderstaande wijnkaart tekst.

Regels:
- Geef ALLEEN een JSON array terug, geen uitleg of andere tekst
- Negeer sectieheaders zoals "ROOD", "WIT", "BUBBELS", "CHAMPAGNE", etc.
- Negeer beschrijvingen van druivenrassen en regio's (bijv. "Pinot Noir - Champagne, Frankrijk")
- Negeer aperitief, cocktails, bier, frisdrank
- Elke wijn heeft: name, producer, vintage (null als NV), price (getal), bottle_format (null/"½ fles"/"magnum" etc.)
- Bij twee prijzen op één regel (glas + fles, bijv. "11  65" of "8 / 45"): gebruik ALTIJD de hogere prijs (dat is de flesprijs)
- Bij prijs per glas notatie ("8 /", "7.5 /", "11 /") zonder flesprijs: sla de wijn over — geen flesprijs beschikbaar
- Naam = de wijnnaam of appellation (bijv. "Morgon", "Gevrey-Chambertin 1er Cru", "Brut Réserve")
- Producer = de producent/domaine (bijv. "Foillard", "Rossignol-Trapet", "Pol Roger")
- Als naam en producer onduidelijk zijn: producer = eerste deel voor komma of pipe, name = tweede deel
- Vintage als getal (2021) of null voor non-vintage — let op PDF artefacten zoals "202 2" = 2022
- Negeer PDF artefacten: losse cijfers, "/" tekens, paginanummers, puntjes
- Als een regel er niet uitziet als een wijn (geen herkende naam of prijs): sla over

Wijnkaart van ${restaurant || 'onbekend restaurant'}:

${text}

Geef ALLEEN een JSON array zoals dit voorbeeld:
[
  {"name": "Morgon", "producer": "Foillard", "vintage": 2022, "price": 65, "bottle_format": null},
  {"name": "Gevrey-Chambertin 1er Cru", "producer": "Rossignol-Trapet", "vintage": 2019, "price": 95, "bottle_format": null},
  {"name": "Brut Réserve", "producer": "Pol Roger", "vintage": null, "price": 96, "bottle_format": null}
]`
      }]
    });

    // Parse de JSON response
    let rawText = message.content[0].text.trim();

    // Strip eventuele markdown code blocks
    rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let wines;
    try {
      wines = JSON.parse(rawText);
    } catch (parseErr) {
      // Probeer JSON te extracten als er toch extra tekst bij zit
      const match = rawText.match(/\[[\s\S]*\]/);
      if (match) {
        wines = JSON.parse(match[0]);
      } else {
        throw new Error('Kon JSON niet parsen: ' + rawText.substring(0, 200));
      }
    }

    // Valideer en filter
    wines = wines
      .filter(w => w.price && w.price > 8 && w.price < 10000)
      .filter(w => w.name && w.name.length > 1)
      .map(w => ({
        name: String(w.name || '').trim(),
        producer: String(w.producer || '').trim(),
        vintage: w.vintage ? parseInt(w.vintage) : null,
        price: parseFloat(w.price),
        bottle_format: w.bottle_format || null
      }));

    res.json({
      success: true,
      wines,
      count: wines.length,
      tokens_used: message.usage.input_tokens + message.usage.output_tokens
    });

  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({
      error: 'Scan mislukt: ' + err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`WineSteals AI Scanner draait op poort ${PORT}`);
});
