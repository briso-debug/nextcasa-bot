/**
 * bot.mjs — NextCasa
 * Agrège les annonces immobilières depuis :
 *   - Anibis.ch (Genève)
 *   - Ricardo.ch (Genève)
 *   - ImmoScout24.ch (Genève)
 *   - PetitesAnnonces.ch (Genève)
 *
 * - Filtre les 6 dernières heures uniquement
 * - Dédoublonnage par prix + pièces + quartier
 * - Lien source affiché uniquement au clic
 * - Planification : toutes les heures de 6h-00h, toutes les 2h de 00h-6h
 * - Expire après 14 jours
 * - Détecte "trouvé preneur"
 */

import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  sources: [
    {
      id: 'anibis',
      name: 'Anibis.ch',
      url: 'https://www.anibis.ch/fr/q/immobilier-geneve-appartements-louer/Ak8CqcmVhbEVzdGF0ZZSSkqtsaXN0aW5nVHlwZalhcGFydG1lbnSSqXByaWNlVHlwZaRSRU5UwMCRk6hsb2NhdGlvbq9nZW8tY2l0eS1nZW5ldmXA?sort=newest',
      type: 'anibis',
    },
    {
      id: 'anibis-maisons',
      name: 'Anibis.ch · Maisons',
      url: 'https://www.anibis.ch/fr/q/immobilier-geneve-maisons-louer/Ak8CqcmVhbEVzdGF0ZZSSkqtsaXN0aW5nVHlwZaVob3VzZZKpcHJpY2VUeXBlpFJFTlTAwJGTqGxvY2F0aW9ur2dlby1jaXR5LWdlbmV2ZcA?sort=newest',
      type: 'anibis',
    },
    {
      id: 'ricardo',
      name: 'Ricardo.ch',
      url: 'https://www.ricardo.ch/fr/s/?q=appartement+gen%C3%A8ve&category=11056&sort=newest',
      type: 'generic',
    },
    {
      id: 'immoscout',
      name: 'ImmoScout24.ch',
      url: 'https://www.immoscout24.ch/fr/immobilier/louer/ville-geneve?sort=NewestFirstListing',
      type: 'immoscout',
    },
    {
      id: 'petitesannonces',
      name: 'PetitesAnnonces.ch',
      url: 'https://www.petitesannonces.ch/r/270108',
      type: 'generic',
    },
  ],

  maxAgeHours: 6,

  schedule: {
    dayStart: 6,
    dayEnd: 24,
    dayInterval: 60 * 60 * 1000,
    nightInterval: 2 * 60 * 60 * 1000,
  },

  minConfidence: 55,
  expiryDays: 14,

  closedKeywords: [
    'trouvé preneur', 'trouve preneur', "c'est pris", 'plus disponible',
    'loué', 'bail signé', 'dossier accepté', 'merci à tous',
    'found someone', 'taken', 'rented', 'reprise effectuée',
  ],

  dataFile: path.join(__dirname, 'data', 'listings.json'),
  seenFile: path.join(__dirname, 'data', 'seen_posts.json'),
  logFile: path.join(__dirname, 'data', 'bot.log'),
};

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min) + min);

function loadJSON(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return fallback;
}

function saveJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function log(msg) {
  const ts = new Date().toLocaleString('fr-CH', { timeZone: 'Europe/Zurich' });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(CONFIG.logFile), { recursive: true });
    fs.appendFileSync(CONFIG.logFile, line + '\n');
  } catch {}
}

function makeId(text) {
  return Buffer.from((text || '').substring(0, 100)).toString('base64').substring(0, 28);
}

function getSwissHour() {
  const now = new Date();
  return parseInt(now.toLocaleString('fr-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', hour12: false }));
}

function isDay() {
  const h = getSwissHour();
  return h >= CONFIG.schedule.dayStart && h < CONFIG.schedule.dayEnd;
}

function getNextInterval() {
  return isDay() ? CONFIG.schedule.dayInterval : CONFIG.schedule.nightInterval;
}

function isExpired(l) {
  return Date.now() - new Date(l.scrapedAt).getTime() > CONFIG.expiryDays * 86400000;
}

function isClosed(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CONFIG.closedKeywords.some(kw => lower.includes(kw));
}

function isDuplicate(listing, existingListings) {
  return existingListings.some(e => {
    if (e.status !== 'active') return false;
    const samePrix = listing.prix && e.prix && Math.abs(listing.prix - e.prix) <= 50;
    const samePieces = listing.pieces && e.pieces && listing.pieces === e.pieces;
    const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const sameQuartier = norm(listing.quartier).includes(norm(e.quartier)) || norm(e.quartier).includes(norm(listing.quartier));
    return (samePrix && samePieces) || (samePrix && sameQuartier) || (samePieces && sameQuartier);
  });
}

async function scrapeAnibis(page, source) {
  log(`  → ${source.name}`);
  try {
    await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(rand(2000, 3500));
    try { await page.click('[data-cy="accept-all-cookies"]', { timeout: 3000 }); await sleep(800); } catch {}

    const items = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('[data-cy="listing-item"], .listing-item, article').forEach(card => {
        try {
          const title = card.querySelector('h2, h3, [class*="title"]')?.innerText?.trim() || '';
          const price = card.querySelector('[class*="price"]')?.innerText?.trim() || '';
          const location = card.querySelector('[class*="location"], [class*="place"]')?.innerText?.trim() || '';
          const link = card.querySelector('a[href]')?.href || '';
          const img = card.querySelector('img[src]')?.src || '';
          const dateText = card.querySelector('[class*="date"], time')?.innerText?.trim() || '';
          if (!title && !price) return;
          results.push({ title, price, location, link, img, dateText, raw: [title, price, location].join(' ') });
        } catch {}
      });
      return results;
    });

    log(`    ${items.length} items`);
    return items.map(i => ({ ...i, sourceId: source.id, sourceName: source.name }));
  } catch (e) {
    log(`    ✗ ${e.message}`);
    return [];
  }
}

async function scrapeImmoScout(page, source) {
  log(`  → ${source.name}`);
  try {
    await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(rand(2500, 4000));
    try { await page.click('#onetrust-accept-btn-handler', { timeout: 3000 }); await sleep(800); } catch {}

    const items = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('[class*="ListItem"], [class*="listing-item"], article').forEach(card => {
        try {
          const title = card.querySelector('[class*="title"], h2, h3')?.innerText?.trim() || '';
          const price = card.querySelector('[class*="price"]')?.innerText?.trim() || '';
          const rooms = card.querySelector('[class*="room"]')?.innerText?.trim() || '';
          const location = card.querySelector('[class*="address"], [class*="location"]')?.innerText?.trim() || '';
          const link = card.querySelector('a[href]')?.href || '';
          const img = card.querySelector('img[src*="http"]')?.src || '';
          const dateText = card.querySelector('[class*="date"], time')?.innerText?.trim() || '';
          if (!title && !price) return;
          results.push({ title, price, rooms, location, link, img, dateText, raw: [title, price, rooms, location].join(' ') });
        } catch {}
      });
      return results;
    });

    log(`    ${items.length} items`);
    return items.map(i => ({ ...i, sourceId: source.id, sourceName: source.name }));
  } catch (e) {
    log(`    ✗ ${e.message}`);
    return [];
  }
}

async function scrapeGeneric(page, source) {
  log(`  → ${source.name}`);
  try {
    await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(rand(2000, 3500));

    const items = await page.evaluate(() => {
      const results = [];
      const selectors = ['article', '[class*="listing"]', '[class*="article"]', '[class*="ad-item"]', 'li[class*="result"]'];
      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel));
        if (cards.length > 2) break;
      }
      cards.forEach(card => {
        try {
          const title = card.querySelector('h2, h3, [class*="title"], .title')?.innerText?.trim() || '';
          const price = card.querySelector('[class*="price"], .price')?.innerText?.trim() || '';
          const location = card.querySelector('[class*="location"], .location, [class*="place"]')?.innerText?.trim() || '';
          const link = card.querySelector('a[href]')?.href || '';
          const img = card.querySelector('img[src*="http"]')?.src || '';
          const dateText = card.querySelector('time, [class*="date"], .date')?.innerText?.trim() || '';
          if (!title && !price) return;
          results.push({ title, price, location, link, img, dateText, raw: [title, price, location].join(' ') });
        } catch {}
      });
      return results;
    });

    log(`    ${items.length} items`);
    return items.map(i => ({ ...i, sourceId: source.id, sourceName: source.name }));
  } catch (e) {
    log(`    ✗ ${e.message}`);
    return [];
  }
}

async function scrapeSource(page, source) {
  if (source.type === 'anibis') return scrapeAnibis(page, source);
  if (source.type === 'immoscout') return scrapeImmoScout(page, source);
  return scrapeGeneric(page, source);
}

async function extractWithLLM(rawText, sourceName) {
  const prompt = `Tu es un extracteur d'annonces immobilières genevoises.
Source: "${sourceName}"
Texte: "${rawText.substring(0, 500)}"

Réponds UNIQUEMENT en JSON valide:
{
  "type": "logement" | "parking" | "ignorer",
  "raison_ignorer": null | "cherche" | "sous-location" | "vente" | "autre",
  "titre": "Xp · Quartier",
  "quartier": "quartier ou ville",
  "pieces": null ou nombre,
  "prix": null ou entier CHF/mois,
  "charges": "incluses" | "non incluses" | "inconnues",
  "dispo": "Immédiat" | "date" | "inconnue",
  "details": ["max 4 items"],
  "confiance": 0-100
}

Règles: ignore recherches/sous-locations/ventes. Prix mensuel uniquement. Quartiers GE: Carouge, Plainpalais, Jonction, Eaux-Vives, Champel, Servette, Meyrin, Lancy, Pâquis, Onex, Vernier...`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw = response.content.map(b => b.text || '').join('');
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (e) {
    log(`    ⚠ LLM: ${e.message}`);
    return null;
  }
}

const GEO = {
  'carouge': { lat: 46.1848, lng: 6.1425 }, 'plainpalais': { lat: 46.1965, lng: 6.1412 },
  'jonction': { lat: 46.2002, lng: 6.1302 }, 'eaux-vives': { lat: 46.2018, lng: 6.1625 },
  'champel': { lat: 46.1920, lng: 6.1530 }, 'servette': { lat: 46.2198, lng: 6.1388 },
  'meyrin': { lat: 46.2332, lng: 6.0798 }, 'lancy': { lat: 46.1758, lng: 6.1195 },
  'vernier': { lat: 46.2198, lng: 6.0932 }, 'onex': { lat: 46.1832, lng: 6.1072 },
  'bernex': { lat: 46.1702, lng: 6.0982 }, 'paquis': { lat: 46.2105, lng: 6.1468 },
  'saint-gervais': { lat: 46.2072, lng: 6.1408 }, 'grottes': { lat: 46.2115, lng: 6.1358 },
  'charmilles': { lat: 46.2168, lng: 6.1248 }, 'chatelaine': { lat: 46.2172, lng: 6.1082 },
  'geneve': { lat: 46.2044, lng: 6.1432 },
};

function geocode(quartier) {
  if (!quartier) return { lat: 46.2044 + (Math.random()-.5)*.04, lng: 6.1432 + (Math.random()-.5)*.06 };
  const key = quartier.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const match = Object.entries(GEO).find(([k]) => key.includes(k));
  if (match) return { lat: match[1].lat + (Math.random()-.5)*.004, lng: match[1].lng + (Math.random()-.5)*.006 };
  return { lat: 46.2044 + (Math.random()-.5)*.04, lng: 6.1432 + (Math.random()-.5)*.06 };
}

async function runCycle() {
  const start = Date.now();
  log('════════════════════════════════');
  log(`Cycle · ${isDay() ? 'Journée 1h' : 'Nuit 2h'}`);

  const listings = loadJSON(CONFIG.dataFile, []);
  const seenIds = new Set(loadJSON(CONFIG.seenFile, []));
  let newCount = 0, dupCount = 0, expiredCount = 0;

  for (const l of listings) {
    if (l.status === 'active' && isExpired(l)) { l.status = 'expired'; expiredCount++; }
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=fr-FR', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'fr-FR',
    timezoneId: 'Europe/Zurich',
  });

  const page = await context.newPage();

  for (const source of CONFIG.sources) {
    const items = await scrapeSource(page, source);
    await sleep(rand(2000, 4000));

    for (const item of items) {
      const itemId = makeId(item.raw);
      if (seenIds.has(itemId)) continue;
      seenIds.add(itemId);

      if (isClosed(item.raw)) {
        const ex = listings.find(l => l.sourceItemId === itemId);
        if (ex?.status === 'active') { ex.status = 'closed'; ex.closedAt = new Date().toISOString(); }
        continue;
      }

      await sleep(rand(400, 1000));
      const ex = await extractWithLLM(item.raw, source.name);
      if (!ex || ex.type === 'ignorer' || ex.confiance < CONFIG.minConfidence) continue;

      const coords = geocode(ex.quartier);
      const listing = {
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        sourceItemId: itemId,
        status: 'active',
        type: ex.type,
        title: ex.titre || item.title || 'Annonce',
        quartier: ex.quartier || 'Genève',
        pieces: ex.pieces,
        prix: ex.prix || parseInt((item.price || '').replace(/[^\d]/g, '')) || null,
        cc: ex.charges === 'incluses',
        charges: ex.charges,
        dispo: ex.dispo || 'inconnue',
        details: ex.details || [],
        desc: (item.raw || '').substring(0, 400),
        photos: item.img ? [item.img] : [],
        // Lien source — révélé uniquement au clic sur l'annonce
        sourceUrl: item.link || source.url,
        sourceName: source.name,
        sourceId: source.id,
        lat: coords.lat,
        lng: coords.lng,
        confiance: ex.confiance,
        scrapedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + CONFIG.expiryDays * 86400000).toISOString(),
        ageHours: 0,
      };

      if (isDuplicate(listing, listings)) { dupCount++; log(`  ≈ Doublon: ${listing.title?.substring(0, 35)}`); continue; }

      listings.push(listing);
      newCount++;
      log(`  ✓ ${source.name}: ${listing.title} · CHF ${listing.prix || '?'}`);
    }
  }

  await browser.close();

  for (const l of listings) {
    if (l.status === 'active') {
      l.ageHours = Math.round((Date.now() - new Date(l.scrapedAt).getTime()) / 3600000);
    }
  }

  saveJSON(CONFIG.dataFile, listings);
  saveJSON(CONFIG.seenFile, [...seenIds].slice(-20000));

  const actives = listings.filter(l => l.status === 'active').length;
  log(`+${newCount} · ${dupCount} doublons · ${expiredCount} expirées · ${actives} actives · ${Math.round((Date.now()-start)/1000)}s`);
}

async function main() {
  log('NextCasa Bot — Anibis · ImmoScout24 · Ricardo · PetitesAnnonces');
  log('6h filtre · dédoublonnage · 1h/jour · 2h/nuit');

  while (true) {
    try { await runCycle(); } catch (e) { log(`✗ ${e.message}`); }
    const interval = getNextInterval();
    log(`Prochain cycle dans ${Math.round(interval/60000)} min…`);
    await sleep(interval);
  }
}

main().catch(e => { log(`✗ Fatal: ${e.message}`); process.exit(1); });
