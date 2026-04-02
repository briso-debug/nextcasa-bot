/**
 * bot.mjs — NextCasa v4
 * Sources: Anibis · ImmoScout24 · PetitesAnnonces
 * Stratégie: attendre JS, scroll, extraire texte + liens + images
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
      url: 'https://www.anibis.ch/fr/q/immobilier-geneve-appartements-maisons-louer/Ak8CqcmVhbEVzdGF0ZZSSkqtsaXN0aW5nVHlwZZKpYXBhcnRtZW50pWhvdXNlkqlwcmljZVR5cGWkUkVOVMDAkZOobG9jYXRpb26xZ2VvLWNhbnRvbi1nZW5ldmXA?sorting=newest&page=1',
      waitFor: 5000,
    },
    {
      id: 'immoscout',
      name: 'ImmoScout24.ch',
      url: 'https://www.immoscout24.ch/fr/immobilier/louer/lieu-geneve?o=dateCreated-desc',
      waitFor: 5000,
    },
    {
      id: 'petitesannonces',
      name: 'PetitesAnnonces.ch',
      url: 'https://www.petitesannonces.ch/r/270608?od=desc&ob=submissionDate',
      waitFor: 3000,
    },
  ],

  schedule: {
    dayStart: 6,
    dayEnd: 24,
    dayInterval: 60 * 60 * 1000,
    nightInterval: 2 * 60 * 60 * 1000,
  },

  minConfidence: 45,
  expiryDays: 14,
  maxPerSource: 25,

  closedKeywords: [
    'trouvé preneur', 'trouve preneur', "c'est pris", 'plus disponible',
    'loué', 'bail signé', 'merci à tous', 'found someone', 'taken',
  ],

  dataFile: path.join(__dirname, 'data', 'listings.json'),
  seenFile: path.join(__dirname, 'data', 'seen.json'),
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

function isDay() {
  const h = parseInt(new Date().toLocaleString('fr-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', hour12: false }));
  return h >= CONFIG.schedule.dayStart && h < CONFIG.schedule.dayEnd;
}

function getNextInterval() {
  return isDay() ? CONFIG.schedule.dayInterval : CONFIG.schedule.nightInterval;
}

function isExpired(l) {
  return Date.now() - new Date(l.scrapedAt).getTime() > CONFIG.expiryDays * 86400000;
}

function isDuplicate(listing, existing) {
  return existing.some(e => {
    if (e.status !== 'active') return false;
    const samePrix = listing.prix && e.prix && Math.abs(listing.prix - e.prix) <= 100;
    const samePieces = listing.pieces && e.pieces && listing.pieces === e.pieces;
    const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const sameQ = norm(listing.quartier) && norm(e.quartier) &&
      (norm(listing.quartier).includes(norm(e.quartier)) || norm(e.quartier).includes(norm(listing.quartier)));
    return (samePrix && samePieces) || (samePrix && sameQ);
  });
}

// ── SCRAPER ANIBIS ───────────────────────────────────────────────────
async function scrapeAnibis(page, source) {
  log(`  → ${source.name}`);
  try {
    await page.goto(source.url, { waitUntil: 'networkidle', timeout: 40000 });
    await sleep(source.waitFor);

    // Accepter cookies
    try { await page.click('button:has-text("Tout accepter"), button:has-text("Accepter"), [data-cy*="accept"]', { timeout: 3000 }); await sleep(1000); } catch {}

    // Scroll progressif
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await sleep(1000);
    }

    // Debug: voir ce qu'il y a dans la page
    const pageInfo = await page.evaluate(() => ({
      title: document.title,
      bodyLength: document.body.innerText.length,
      links: Array.from(document.querySelectorAll('a[href]')).slice(0, 5).map(a => a.href),
    }));
    log(`    Page: "${pageInfo.title}" · ${pageInfo.bodyLength} chars`);

    // Extraire les annonces avec sélecteurs Anibis spécifiques
    const items = await page.evaluate((max) => {
      const results = [];

      // Anibis utilise des divs avec data attributes ou classes spécifiques
      const selectors = [
        '[data-testid*="listing"]',
        '[class*="ListingItem"]',
        '[class*="listing-item"]',
        '[class*="SearchResult"]',
        '[class*="AdItem"]',
        'article',
        '[class*="Card"]',
      ];

      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel))
          .filter(el => el.innerText && el.innerText.length > 40);
        if (cards.length > 3) {
          console.log('Found with selector:', sel, cards.length);
          break;
        }
      }

      // Fallback: chercher tous les liens qui ressemblent à des annonces
      if (cards.length === 0) {
        const links = Array.from(document.querySelectorAll('a[href*="/vi/"], a[href*="/fr/vi/"]'));
        links.slice(0, max).forEach(a => {
          let el = a;
          for (let i = 0; i < 4; i++) {
            if (el.parentElement?.innerText?.length > 60) el = el.parentElement;
            else break;
          }
          const text = el.innerText?.trim() || '';
          const img = el.querySelector('img')?.src || '';
          if (text.length > 30) results.push({ text: text.substring(0, 600), link: a.href, img });
        });
        return results;
      }

      const seen = new Set();
      cards.slice(0, max).forEach(card => {
        const link = card.querySelector('a[href]')?.href || '';
        if (seen.has(link) && link) return;
        if (link) seen.add(link);
        const text = card.innerText?.trim() || '';
        const img = card.querySelector('img[src*="http"]')?.src || '';
        if (text.length > 30) results.push({ text: text.substring(0, 600), link, img });
      });

      return results;
    }, CONFIG.maxPerSource);

    log(`    ${items.length} items extraits`);
    return items.map(i => ({ ...i, sourceId: source.id, sourceName: source.name, sourceUrl: source.url }));

  } catch (e) {
    log(`    ✗ ${source.name}: ${e.message}`);
    return [];
  }
}

// ── SCRAPER IMMOSCOUT ────────────────────────────────────────────────
async function scrapeImmoScout(page, source) {
  log(`  → ${source.name}`);
  try {
    await page.goto(source.url, { waitUntil: 'networkidle', timeout: 40000 });
    await sleep(source.waitFor);

    try { await page.click('#onetrust-accept-btn-handler, button:has-text("Accepter")', { timeout: 3000 }); await sleep(1000); } catch {}

    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await sleep(1000);
    }

    const pageInfo = await page.evaluate(() => ({ title: document.title, length: document.body.innerText.length }));
    log(`    Page: "${pageInfo.title}" · ${pageInfo.length} chars`);

    const items = await page.evaluate((max) => {
      const results = [];
      const selectors = [
        '[data-test*="result"]',
        '[class*="ListItem"]',
        '[class*="ResultItem"]',
        '[class*="listing"]',
        'article',
        '[class*="PropertyCard"]',
        '[class*="HitItem"]',
      ];

      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel))
          .filter(el => el.innerText?.length > 40);
        if (cards.length > 3) break;
      }

      if (cards.length === 0) {
        // Fallback via liens
        const links = Array.from(document.querySelectorAll('a[href*="/fr/"]'))
          .filter(a => a.href.includes('louer') || a.href.includes('location') || a.href.match(/\/\d{8,}/));
        links.slice(0, max).forEach(a => {
          let el = a;
          for (let i = 0; i < 4; i++) {
            if (el.parentElement?.innerText?.length > 60) el = el.parentElement;
            else break;
          }
          const text = el.innerText?.trim() || '';
          if (text.length > 30) results.push({ text: text.substring(0, 600), link: a.href, img: el.querySelector('img')?.src || '' });
        });
        return results;
      }

      const seen = new Set();
      cards.slice(0, max).forEach(card => {
        const link = card.querySelector('a[href]')?.href || '';
        if (seen.has(link) && link) return;
        if (link) seen.add(link);
        const text = card.innerText?.trim() || '';
        const img = card.querySelector('img[src*="http"]')?.src || '';
        if (text.length > 30) results.push({ text: text.substring(0, 600), link, img });
      });

      return results;
    }, CONFIG.maxPerSource);

    log(`    ${items.length} items extraits`);
    return items.map(i => ({ ...i, sourceId: source.id, sourceName: source.name, sourceUrl: source.url }));

  } catch (e) {
    log(`    ✗ ${source.name}: ${e.message}`);
    return [];
  }
}

// ── SCRAPER PETITES ANNONCES ─────────────────────────────────────────
async function scrapePetitesAnnonces(page, source) {
  log(`  → ${source.name}`);
  try {
    await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(source.waitFor);

    const pageInfo = await page.evaluate(() => ({ title: document.title, length: document.body.innerText.length }));
    log(`    Page: "${pageInfo.title}" · ${pageInfo.length} chars`);

    const items = await page.evaluate((max) => {
      const results = [];
      const selectors = [
        '.announcement', '.ad', '[class*="listing"]', '[class*="ad-item"]',
        'article', 'li[class]', '.offer', '[class*="result"]',
        'table tr', '.classified',
      ];

      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel))
          .filter(el => el.innerText?.length > 30);
        if (cards.length > 3) break;
      }

      if (cards.length === 0) {
        // Extraire tout le texte en blocs
        const allText = document.body.innerText;
        // Diviser par doubles retours à la ligne
        const blocks = allText.split(/\n{2,}/).filter(b => b.trim().length > 30);
        blocks.slice(0, max).forEach(b => results.push({ text: b.trim().substring(0, 600), link: '', img: '' }));
        return results;
      }

      const seen = new Set();
      cards.slice(0, max).forEach(card => {
        const link = card.querySelector('a[href]')?.href || '';
        if (seen.has(link) && link) return;
        if (link) seen.add(link);
        const text = card.innerText?.trim() || '';
        const img = card.querySelector('img[src*="http"]')?.src || '';
        if (text.length > 30) results.push({ text: text.substring(0, 600), link, img });
      });

      return results;
    }, CONFIG.maxPerSource);

    log(`    ${items.length} items extraits`);
    return items.map(i => ({ ...i, sourceId: source.id, sourceName: source.name, sourceUrl: source.url }));

  } catch (e) {
    log(`    ✗ ${source.name}: ${e.message}`);
    return [];
  }
}

// ── LLM ─────────────────────────────────────────────────────────────
async function extractWithLLM(text, sourceName) {
  const prompt = `Extracteur d'annonces immobilières genevoises.
Source: "${sourceName}"
Texte: "${text.substring(0, 500)}"

Réponds UNIQUEMENT en JSON. Si pas une offre de location genevoise → type: "ignorer".

{
  "type": "logement" | "parking" | "ignorer",
  "raison_ignorer": null | "vente" | "cherche" | "sous-location" | "hors-zone" | "autre",
  "titre": "Xp · Quartier",
  "quartier": "quartier genevois",
  "pieces": null ou nombre,
  "prix": null ou CHF/mois entier,
  "charges": "incluses" | "non incluses" | "inconnues",
  "dispo": "Immédiat" | "date" | "inconnue",
  "details": ["max 3 items"],
  "confiance": 0-100
}`;

  try {
    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 350,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw = r.content.map(b => b.text || '').join('');
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
  if (match) return { lat: match[1].lat + (Math.random()-.5)*.003, lng: match[1].lng + (Math.random()-.5)*.005 };
  return { lat: 46.2044 + (Math.random()-.5)*.04, lng: 6.1432 + (Math.random()-.5)*.06 };
}

async function runCycle() {
  const start = Date.now();
  log('════════════════════════════');
  log(`Cycle · ${isDay() ? '1h · Journée' : '2h · Nuit'}`);

  const listings = loadJSON(CONFIG.dataFile, []);
  const seenIds = new Set(loadJSON(CONFIG.seenFile, []));
  let newCount = 0, dupCount = 0, ignoredCount = 0, expiredCount = 0;

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
    let blocks = [];
    if (source.id === 'anibis') blocks = await scrapeAnibis(page, source);
    else if (source.id === 'immoscout') blocks = await scrapeImmoScout(page, source);
    else blocks = await scrapePetitesAnnonces(page, source);

    await sleep(rand(3000, 5000));

    for (const block of blocks) {
      const itemId = Buffer.from((block.link || block.text || '').substring(0, 120)).toString('base64').substring(0, 32);
      if (seenIds.has(itemId)) continue;
      seenIds.add(itemId);

      await sleep(rand(400, 800));
      const ex = await extractWithLLM(block.text, source.name);
      if (!ex || ex.type === 'ignorer') { if (ex) ignoredCount++; continue; }
      if (ex.confiance < CONFIG.minConfidence) continue;

      const coords = geocode(ex.quartier);
      const listing = {
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        sourceItemId: itemId,
        status: 'active',
        type: ex.type,
        title: ex.titre || `${ex.pieces || '?'}p · ${ex.quartier || 'Genève'}`,
        quartier: ex.quartier || 'Genève',
        pieces: ex.pieces,
        prix: ex.prix || null,
        cc: ex.charges === 'incluses',
        charges: ex.charges,
        dispo: ex.dispo || 'inconnue',
        details: ex.details || [],
        desc: block.text.substring(0, 500),
        photos: block.img ? [block.img] : [],
        sourceUrl: block.link || source.url,
        sourceName: source.name,
        sourceId: source.id,
        lat: coords.lat, lng: coords.lng,
        confiance: ex.confiance,
        scrapedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + CONFIG.expiryDays * 86400000).toISOString(),
        ageHours: 0,
      };

      if (isDuplicate(listing, listings)) { dupCount++; continue; }
      listings.push(listing);
      newCount++;
      log(`    ✓ ${source.name}: ${listing.title} · CHF ${listing.prix || '?'}`);
    }
  }

  await browser.close();

  for (const l of listings) {
    if (l.status === 'active') l.ageHours = Math.round((Date.now() - new Date(l.scrapedAt).getTime()) / 3600000);
  }

  saveJSON(CONFIG.dataFile, listings);
  saveJSON(CONFIG.seenFile, [...seenIds].slice(-20000));

  const actives = listings.filter(l => l.status === 'active').length;
  log(`+${newCount} · ${dupCount} doublons · ${ignoredCount} ignorées · ${expiredCount} exp. · ${actives} actives · ${Math.round((Date.now()-start)/1000)}s`);
}

async function main() {
  log('NextCasa Bot v4 · Anibis · ImmoScout24 · PetitesAnnonces');
  while (true) {
    try { await runCycle(); } catch (e) { log(`✗ ${e.message}`); }
    const interval = getNextInterval();
    log(`Prochain cycle dans ${Math.round(interval/60000)} min…`);
    await sleep(interval);
  }
}

main().catch(e => { log(`✗ Fatal: ${e.message}`); process.exit(1); });
