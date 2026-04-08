/**
 * bot.mjs — NextCasa v13
 * Fix: confiance min = 0, itemId unique avec index, visite pages annonces
 */

import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  maxPerPage: 20,
  sources: [
    {
      id: 'anibis', name: 'Anibis.ch', type: 'anibis',
      pages: ['https://www.anibis.ch/fr/q/immobilier-geneve-appartements-louer/Ak8CqcmVhbEVzdGF0ZZSSkqtsaXN0aW5nVHlwZalhcGFydG1lbnSSqXByaWNlVHlwZaRSRU5UwMCRk6hsb2NhdGlvbrFnZW8tY2FudG9uLWdlbmV2ZcA'],
      waitFor: 8000,
    },
    {
      id: 'rentola', name: 'Rentola.ch', type: 'rentola',
      pages: [
        'https://rentola.ch/fr/a-louer?location=geneve-region&order=desc&property_types=apartment',
        'https://rentola.ch/fr/a-louer?location=geneve-region&order=desc&property_types=apartment&page=2',
        'https://rentola.ch/fr/a-louer?location=geneve-region&order=desc&property_types=apartment&page=3',
      ],
      waitFor: 4000,
    },
    {
      id: 'petitesannonces', name: 'PetitesAnnonces.ch', type: 'petitesannonces',
      pages: ['https://www.petitesannonces.ch/r/270608?od=desc&ob=submissionDate'],
      waitFor: 3000,
    },
  ],
  schedule: {
    dayStart: 6, dayEnd: 24,
    dayInterval: 60 * 60 * 1000,
    nightInterval: 2 * 60 * 60 * 1000,
  },
  expiryDays: 14,
  dataFile: path.join(__dirname, 'data', 'listings.json'),
  seenFile: path.join(__dirname, 'data', 'seen.json'),
  logFile: path.join(__dirname, 'data', 'bot.log'),
};

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(Math.random() * (b - a) + a);

function loadJSON(f, fb) { try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {} return fb; }
function saveJSON(f, d) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d, null, 2)); }
function log(msg) {
  const ts = new Date().toLocaleString('fr-CH', { timeZone: 'Europe/Zurich' });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(path.dirname(CONFIG.logFile), { recursive: true }); fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch {}
}
function isDay() {
  const h = parseInt(new Date().toLocaleString('fr-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', hour12: false }));
  return h >= CONFIG.schedule.dayStart && h < CONFIG.schedule.dayEnd;
}
function getNextInterval() { return isDay() ? CONFIG.schedule.dayInterval : CONFIG.schedule.nightInterval; }
function isExpired(l) { return Date.now() - new Date(l.scrapedAt).getTime() > CONFIG.expiryDays * 86400000; }
function isDuplicate(listing, existing) {
  return existing.some(e => {
    if (e.status !== 'active') return false;
    if (listing.sourceUrl && e.sourceUrl && listing.sourceUrl === e.sourceUrl) return true;
    const samePrix = listing.prix && e.prix && Math.abs(listing.prix - e.prix) <= 100;
    const samePieces = listing.pieces && e.pieces && listing.pieces === e.pieces;
    const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const sameQ = norm(listing.quartier) && norm(e.quartier) &&
      (norm(listing.quartier).includes(norm(e.quartier)) || norm(e.quartier).includes(norm(listing.quartier)));
    return (samePrix && samePieces) || (samePrix && sameQ);
  });
}

async function acceptCookies(page) {
  for (const sel of ['button:has-text("Tout accepter")', 'button:has-text("Accept all")', '#onetrust-accept-btn-handler', '[data-cy*="accept"]']) {
    try { await page.click(sel, { timeout: 2000 }); await sleep(500); break; } catch {}
  }
}
async function scrollPage(page, n) {
  for (let i = 0; i < n; i++) { await page.evaluate(() => window.scrollBy(0, window.innerHeight)); await sleep(rand(700, 1100)); }
}

// ── ENRICHISSEMENT : supprime nav puis extrait contenu ────────────────
async function enrichDetail(page, url) {
  if (!url?.startsWith('http')) return null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(rand(1200, 2000));
    // Supprimer navigation
    await page.evaluate(() => {
      ['nav', 'header', 'footer', '[class*="nav"]', '[class*="header"]', '[class*="footer"]',
       '[class*="cookie"]', '[class*="menu"]', '[class*="sidebar"]'].forEach(sel => {
        try { document.querySelectorAll(sel).forEach(el => el.remove()); } catch {}
      });
    });
    const text = await page.evaluate(() => {
      const candidates = ['[class*="detail"]', '[class*="description"]', '[class*="content"]',
        '[class*="annonce"]', '[class*="listing"]', 'main', 'article', '#main'];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el && el.innerText?.trim().length > 100) return el.innerText.trim().substring(0, 1500);
      }
      return document.body.innerText?.trim().substring(0, 1500) || '';
    });
    const img = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img[src*="http"]'))
        .filter(i => (i.width > 200 || i.naturalWidth > 200) && !i.src.includes('logo') && !i.src.includes('icon'));
      return imgs[0]?.src || '';
    });
    return { text, img };
  } catch { return null; }
}

// ── ANIBIS ────────────────────────────────────────────────────────────
async function scrapeAnibis(page, url, waitFor) {
  try {
    await page.goto('https://www.anibis.ch/fr/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(rand(1500, 2500));
    await acceptCookies(page);
    await sleep(rand(800, 1500));
  } catch {}

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await sleep(waitFor);
  await scrollPage(page, 5);
  await sleep(2000);

  const links = await page.evaluate((max) => {
    const seen = new Set();
    return Array.from(document.querySelectorAll('a[href]'))
      .filter(a => a.href.startsWith('https://www.anibis.ch') && a.href.includes('/vi/'))
      .map(a => a.href)
      .filter(h => { if (seen.has(h)) return false; seen.add(h); return true; })
      .slice(0, max);
  }, CONFIG.maxPerPage);

  log(`    ${links.length} liens Anibis`);
  // Chaque lien = un bloc à enrichir
  return links.map((link, i) => ({ text: '', link, img: '', id: `anibis_${i}_${link.split('/').pop()}` }));
}

// ── RENTOLA : extrait les liens d'annonces individuelles ──────────────
async function scrapeRentola(page, url, waitFor) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(waitFor);
  await acceptCookies(page);
  await scrollPage(page, 3);

  const info = await page.evaluate(() => ({ title: document.title.substring(0, 50), len: document.body.innerText.length }));
  log(`    ${info.title} · ${info.len}c`);

  // Extraire les URLs d'annonces Rentola (on visitera chaque page)
  const links = await page.evaluate((max) => {
    const seen = new Set();
    return Array.from(document.querySelectorAll('a[href]'))
      .filter(a => {
        const h = a.href || '';
        // Lien annonce Rentola = contient /a-louer/ et un slug long
        return h.includes('rentola.ch') && h.includes('/a-louer/') &&
               h.length > 50 && h.split('/').length >= 7;
      })
      .map(a => a.href)
      .filter(h => { if (seen.has(h)) return false; seen.add(h); return true; })
      .slice(0, max);
  }, CONFIG.maxPerPage);

  log(`    ${links.length} liens Rentola`);
  if (links.length === 0) {
    // Debug: afficher des samples de liens trouvés
    const sample = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="rentola"]')).slice(0, 5).map(a => a.href)
    );
    if (sample.length) log(`    Sample liens: ${sample.slice(0, 3).join(' | ')}`);
  }

  return links.map((link, i) => ({ text: '', link, img: '', id: `rentola_${i}_${link.split('/').pop()}` }));
}

// ── PETITES ANNONCES ──────────────────────────────────────────────────
async function scrapePetitesAnnonces(page, url, waitFor) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(waitFor);

  const info = await page.evaluate(() => ({ title: document.title.substring(0, 50), len: document.body.innerText.length }));
  log(`    ${info.title} · ${info.len}c`);

  const links = await page.evaluate((max) => {
    const seen = new Set();
    // Liens vers annonces individuelles PetitesAnnonces
    return Array.from(document.querySelectorAll('a[href]'))
      .filter(a => {
        const h = a.href || '';
        return h.includes('petitesannonces.ch') && (
          h.match(/\/a\/\d+/) || h.match(/petitesannonces\.ch\/[^/]+\/[^/]+\/\d+/)
        );
      })
      .map(a => a.href)
      .filter(h => { if (seen.has(h)) return false; seen.add(h); return true; })
      .slice(0, max);
  }, CONFIG.maxPerPage);

  log(`    ${links.length} liens PetitesAnnonces`);

  if (links.length === 0) {
    // Fallback: extraire les blocs de texte avec prix directement de la page liste
    const blocks = await page.evaluate((max) => {
      const results = [];
      const seen = new Set();
      Array.from(document.querySelectorAll('tr, li, [class*="result"], [class*="ad"]')).forEach((el, i) => {
        const text = el.innerText?.trim() || '';
        const link = el.querySelector('a[href]')?.href || '';
        if (text.length > 40 && text.length < 1000 &&
            (text.includes('CHF') || text.includes('.-')) &&
            !text.includes("S'inscrire") && !text.includes('Toute reproduction') &&
            !text.includes('Toutes les rubriques')) {
          const key = link || `block_${i}`;
          if (seen.has(key)) return;
          seen.add(key);
          if (results.length < max) results.push({ text: text.substring(0, 600), link, img: '', id: `pa_${i}` });
        }
      });
      return results;
    }, CONFIG.maxPerPage);
    log(`    ${blocks.length} blocs fallback`);
    return blocks;
  }

  return links.map((link, i) => ({ text: '', link, img: '', id: `pa_${i}_${link.split('/').pop()}` }));
}

// ── LLM ───────────────────────────────────────────────────────────────
async function extractWithLLM(text, sourceName) {
  const clean = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').substring(0, 800);
  const prompt = `Tu extrais des données d'annonces immobilières pour la région genevoise.
Source: ${sourceName}
Texte: ${clean}

Règles:
- ACCEPTE toute offre de location dans canton Genève ou communes proches (Carouge, Lancy, Meyrin, Onex, Vernier, Bernex, Thônex, Plan-les-Ouates, etc.)
- ACCEPTE reprises de bail, sous-locations longue durée
- IGNORE uniquement: vente, offre hors Suisse romande, texte qui n'est pas une annonce (navigation, aide)
- Si une info manque, mets null

Réponds sur UNE SEULE LIGNE JSON:
{"type":"logement|parking|ignorer","raison_ignorer":null,"titre":"string","quartier":"string","pieces":null,"prix":null,"charges":"incluses|non incluses|inconnues","dispo":"string","details":[],"confiance":0}`;

  try {
    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = r.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    const line = raw.split('\n').find(l => l.trim().startsWith('{')) || raw;
    return JSON.parse(line);
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
  'petit-saconnex': { lat: 46.2282, lng: 6.1382 }, 'grand-saconnex': { lat: 46.2382, lng: 6.1182 },
  'acacias': { lat: 46.1935, lng: 6.1382 }, 'geneve': { lat: 46.2044, lng: 6.1432 },
};
function geocode(q) {
  if (!q) return { lat: 46.2044 + (Math.random() - .5) * .04, lng: 6.1432 + (Math.random() - .5) * .06 };
  const key = q.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const match = Object.entries(GEO).find(([k]) => key.includes(k));
  if (match) return { lat: match[1].lat + (Math.random() - .5) * .003, lng: match[1].lng + (Math.random() - .5) * .005 };
  return { lat: 46.2044 + (Math.random() - .5) * .04, lng: 6.1432 + (Math.random() - .5) * .06 };
}

// ── CYCLE ──────────────────────────────────────────────────────────────
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
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }, locale: 'fr-FR', timezoneId: 'Europe/Zurich',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const listPage = await context.newPage();
  const detailPage = await context.newPage();

  for (const source of CONFIG.sources) {
    log(`  → ${source.name}`);

    for (let pi = 0; pi < source.pages.length; pi++) {
      const pageUrl = source.pages[pi];
      let blocks = [];

      try {
        if (source.type === 'anibis') blocks = await scrapeAnibis(listPage, pageUrl, source.waitFor);
        else if (source.type === 'rentola') blocks = await scrapeRentola(listPage, pageUrl, source.waitFor);
        else blocks = await scrapePetitesAnnonces(listPage, pageUrl, source.waitFor);
      } catch (e) {
        log(`    ✗ ${e.message.substring(0, 80)}`);
        continue;
      }

      await sleep(rand(1500, 3000));

      for (const block of blocks) {
        // ID unique : priorité au champ id explicite, sinon lien, sinon lien+texte
        const rawId = block.id || block.link || (block.link + '|' + (block.text || '').substring(0, 40));
        const itemId = Buffer.from(rawId).toString('base64').substring(0, 32);
        if (seenIds.has(itemId)) continue;
        seenIds.add(itemId);

        let text = block.text || '';
        let photo = block.img || '';

        // Visiter la page détail si pas de texte ou texte court
        if (text.length < 150 && block.link?.startsWith('http')) {
          log(`    ↗ Visite: ${block.link.substring(0, 60)}`);
          const detail = await enrichDetail(detailPage, block.link);
          if (detail) {
            if (detail.text.length > text.length) text = detail.text;
            if (!photo && detail.img) photo = detail.img;
          }
          await sleep(rand(500, 1000));
        }

        if (text.length < 30) { log(`    → texte trop court, skip`); continue; }

        log(`    LLM ← "${text.substring(0, 80).replace(/\n/g, ' ')}…"`);
        await sleep(rand(200, 400));
        const ex = await extractWithLLM(text, source.name);
        if (!ex) continue;
        log(`    LLM → ${ex.type} · ${ex.confiance}% · CHF ${ex.prix} · ${ex.quartier}`);

        if (ex.type === 'ignorer') { ignoredCount++; continue; }
        // Accepter si c'est clairement un logement/parking même avec confiance faible
        // Rejeter seulement si confiance = 0 ET pas de prix ET pas de quartier
        if (ex.confiance === 0 && !ex.prix && !ex.quartier) { ignoredCount++; continue; }

        const coords = geocode(ex.quartier);
        const listing = {
          id: Date.now() + '_' + Math.random().toString(36).substr(2, 5),
          sourceItemId: itemId, status: 'active', type: ex.type,
          title: ex.titre || `${ex.pieces || '?'}p · ${ex.quartier || 'Genève'}`,
          quartier: ex.quartier || 'Genève', pieces: ex.pieces, prix: ex.prix,
          cc: ex.charges === 'incluses', charges: ex.charges,
          dispo: ex.dispo || null, details: ex.details || [],
          desc: text.substring(0, 500), photos: photo ? [photo] : [],
          sourceUrl: block.link || pageUrl,
          sourceName: source.name, sourceId: source.id,
          lat: coords.lat, lng: coords.lng, confiance: ex.confiance,
          scrapedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + CONFIG.expiryDays * 86400000).toISOString(),
          ageHours: 0,
        };

        if (isDuplicate(listing, listings)) { dupCount++; log(`    ≈ doublon`); continue; }
        listings.push(listing);
        newCount++;
        log(`    ✓ SAUVÉ: ${listing.title} · CHF ${listing.prix || '?'}`);
      }
    }
  }

  await browser.close();

  for (const l of listings) {
    if (l.status === 'active') l.ageHours = Math.round((Date.now() - new Date(l.scrapedAt).getTime()) / 3600000);
  }

  saveJSON(CONFIG.dataFile, listings);
  saveJSON(CONFIG.seenFile, [...seenIds].slice(-30000));

  const actives = listings.filter(l => l.status === 'active').length;
  log(`+${newCount} · ${dupCount} dup · ${ignoredCount} ignorées · ${expiredCount} exp · ${actives} actives · ${Math.round((Date.now() - start) / 1000)}s`);
}

async function main() {
  log('NextCasa Bot v13 · Anibis · Rentola · PetitesAnnonces');
  while (true) {
    try { await runCycle(); } catch (e) { log(`✗ ${e.message}`); }
    const i = getNextInterval();
    log(`Prochain cycle dans ${Math.round(i / 60000)} min…`);
    await sleep(i);
  }
}

main().catch(e => { log(`✗ Fatal: ${e.message}`); process.exit(1); });
