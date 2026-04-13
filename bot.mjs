/**
 * bot.mjs — NextCasa v16
 * Fix: Rentola filtre les vraies annonces (URLs avec ID numérique)
 * Fix: PetitesAnnonces coupe la nav directement dans le texte
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
      ],
      waitFor: 5000,
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
  expiryDays: 5,
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
// Vérifier si une annonce Anibis est encore en ligne
async function isStillOnline(page, url) {
  if (!url || !url.includes('anibis.ch')) return true; // On ne vérifie que Anibis
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    if (!response) return false;
    const status = response.status();
    if (status === 404 || status === 410) return false;
    // Vérifier si la page contient "annonce introuvable" ou "n'existe plus"
    const text = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
    const notFound = text.match(/introuvable|n.existe plus|expired|not found|supprim/i);
    return !notFound;
  } catch { return true; } // En cas d'erreur, on garde l'annonce
}

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
  for (const sel of ['button:has-text("Tout accepter")', 'button:has-text("Accept all")', '#onetrust-accept-btn-handler']) {
    try { await page.click(sel, { timeout: 2000 }); await sleep(500); break; } catch {}
  }
}
async function scrollPage(page, n) {
  for (let i = 0; i < n; i++) { await page.evaluate(() => window.scrollBy(0, window.innerHeight)); await sleep(rand(700, 1000)); }
}

// ── NETTOYAGE TEXTE ────────────────────────────────
function cleanText(text, source) {
  let t = text || '';

  if (source === 'petitesannonces') {
    // Supprimer tout jusqu'après "Retour à la liste d'annonces"
    const markers = ["Retour à la liste d'annonces", '« Retour à la liste', 'Retour à la liste'];
    for (const marker of markers) {
      const idx = t.indexOf(marker);
      if (idx > 0) { t = t.substring(idx + marker.length).trim(); break; }
    }
    // Supprimer les patterns de nav restants
    t = t.replace(/Toutes les rubriques[\s\S]{0,150}Recherche avancée/g, '');
    t = t.replace(/« Précédent\s*Suivant »/g, '');
    t = t.replace(/S'inscrire.*?Se connecter/gs, '');
  }

  // Supprimer le header Anibis
  if (source === 'anibis') {
    t = t.replace(/^Messages\s+Insérer annonce\s+Gratuit\s*/i, '');
  }

  return t.replace(/\s{3,}/g, '\n').trim().substring(0, 1200);
}

// ── ENRICHISSEMENT PAGE DÉTAIL ─────────────────────
async function enrichDetail(page, url, source) {
  if (!url?.startsWith('http')) return null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(rand(1200, 2000));

    const rawText = await page.evaluate(() => document.body.innerText || '');
    const text = rawText;

    const img = await page.evaluate(() => {
      const selectors = [
        'img[class*="photo"]', 'img[class*="image-"]', 'img[class*="gallery"]',
        '[class*="gallery"] img', '[class*="photo"] img',
        '[class*="slider"] img', '.swiper-slide img',
        '[class*="carousel"] img', '[class*="images"] img',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el?.src?.startsWith('http') && !el.src.includes('logo') && !el.src.includes('icon')) return el.src;
      }
      const imgs = Array.from(document.querySelectorAll('img[src*="http"]'))
        .filter(i => (i.naturalWidth > 300 || i.width > 200) &&
          !i.src.includes('logo') && !i.src.includes('icon') && !i.src.includes('avatar'));
      return imgs[0]?.src || '';
    });

    return { text: cleanText(text, source), img };
  } catch (e) {
    return null;
  }
}

// ── ANIBIS ─────────────────────────────────────────
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
  return links.map((link, i) => ({ text: '', link, img: '', id: `anibis_${i}_${link.split('/').pop()}` }));
}

// ── RENTOLA : seulement les vraies annonces ─────────
async function scrapeRentola(page, url, waitFor) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(waitFor);
  await acceptCookies(page);
  await scrollPage(page, 4);
  await sleep(1000);

  const info = await page.evaluate(() => ({ title: document.title.substring(0, 50), len: document.body.innerText.length }));
  log(`    ${info.title} · ${info.len}c`);

  // Les vraies annonces Rentola ont une URL avec un slug unique long
  // Ex: /fr/a-louer/appartement/carouge/appartement-3p-carouge-1234567
  // Les pages de filtres ont: /geneve-region/neuf, /1-chambre, /lausanne, /berne
  const links = await page.evaluate((max) => {
    const seen = new Set();
    const FILTER_PATTERNS = [
      '/neuf', '/meuble', '/avec-ascenseur', '/avec-balcon', '/avec-terrasse',
      '/avec-jardin', '/avec-garage', '/avec-parking', '/1-chambre', '/2-chambre',
      '/3-chambre', '/4-chambre', '/5-chambre', '/maison', '/studio',
      '/lausanne', '/berne', '/zurich', '/basel',
      'geneve-region', // page de résultats globale
    ];

    return Array.from(document.querySelectorAll('a[href]'))
      .filter(a => {
        const h = a.href || '';
        if (!h.includes('rentola.ch')) return false;
        if (!h.includes('/a-louer/')) return false;
        // Doit avoir au moins 6 segments de path
        const parts = new URL(h).pathname.split('/').filter(Boolean);
        if (parts.length < 5) return false;
        // Ne doit pas être une page de filtres
        if (FILTER_PATTERNS.some(p => h.includes(p))) return false;
        // Le dernier segment doit ressembler à un slug d'annonce (contient des chiffres ou est long)
        const lastPart = parts[parts.length - 1];
        if (lastPart.length < 10) return false;
        return true;
      })
      .map(a => a.href)
      .filter(h => { if (seen.has(h)) return false; seen.add(h); return true; })
      .slice(0, max);
  }, CONFIG.maxPerPage);

  log(`    ${links.length} vraies annonces Rentola (sur page)`);

  // Debug: afficher les URLs trouvées
  if (links.length > 0) log(`    Sample: ${links[0].substring(0, 80)}`);
  else {
    // Fallback: afficher tous les liens /a-louer/ pour debug
    const allLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="/a-louer/"]'))
        .slice(0, 5).map(a => a.href)
    );
    log(`    Debug liens /a-louer/: ${allLinks.join(' | ').substring(0, 200)}`);
  }

  return links.map((link, i) => ({ text: '', link, img: '', id: `rentola_${i}_${link.split('/').pop().substring(0,20)}` }));
}

// ── PETITES ANNONCES ────────────────────────────────
async function scrapePetitesAnnonces(page, url, waitFor) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(waitFor);

  const info = await page.evaluate(() => ({ title: document.title.substring(0, 50), len: document.body.innerText.length }));
  log(`    ${info.title} · ${info.len}c`);

  const links = await page.evaluate((max) => {
    const seen = new Set();
    return Array.from(document.querySelectorAll('a[href]'))
      .filter(a => {
        const h = a.href || '';
        return h.includes('petitesannonces.ch') && h.match(/\/a\/\d+/);
      })
      .map(a => a.href)
      .filter(h => { if (seen.has(h)) return false; seen.add(h); return true; })
      .slice(0, max);
  }, CONFIG.maxPerPage);

  log(`    ${links.length} liens PetitesAnnonces`);
  return links.map((link, i) => ({ text: '', link, img: '', id: `pa_${i}_${link.split('/').pop()}` }));
}

// ── LLM ────────────────────────────────────────────
async function extractWithLLM(text, sourceName) {
  const clean = text.substring(0, 900);

  const prompt = `Tu extrais des données d'annonces immobilières pour la région genevoise.
Source: ${sourceName}
Texte: ${clean}

RÈGLES STRICTES:
ACCEPTE: appartements entiers à LOUER dans le canton de Genève ou communes suisses proches (Carouge, Lancy, Meyrin, Vernier, Onex, Thônex, Bernex, Veyrier, Versoix, Plan-les-Ouates)
IGNORE si:
- Vente (pas location)
- Cherche à louer (pas une offre)
- Échange d'appartement
- Chambre seule en colocation
- Hors Suisse (France, Haute-Savoie, Ain, Annemasse, Saint-Julien, Ferney-Voltaire)
- Texte de navigation ou d'interface (pas une annonce)

Réponds sur UNE SEULE LIGNE JSON:
{"type":"logement|ignorer","raison_ignorer":null,"titre":"string","quartier":"string","pieces":null,"prix":null,"charges":"incluses|non incluses|inconnues","dispo":"string","details":[],"confiance":0}`;

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

// Géocodage Nominatim - coordonnées précises depuis l'adresse
async function geocodeWithNominatim(address, quartier) {
  const query = address || (quartier + ', Genève, Suisse');
  try {
    const url = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(query) + '&format=json&limit=1&countrycodes=ch';
    const res = await fetch(url, { headers: { 'User-Agent': 'NextCasa/1.0' } });
    const data = await res.json();
    if (data && data[0]) {
      return {
        lat: parseFloat(data[0].lat) + (Math.random()-.5)*.0003,
        lng: parseFloat(data[0].lon) + (Math.random()-.5)*.0003,
      };
    }
  } catch {}
  return null;
}

const GEO = {
  'carouge': { lat: 46.1848, lng: 6.1425 }, 'plainpalais': { lat: 46.1965, lng: 6.1412 },
  'jonction': { lat: 46.2002, lng: 6.1302 }, 'eaux-vives': { lat: 46.2018, lng: 6.1625 },
  'champel': { lat: 46.1920, lng: 6.1530 }, 'servette': { lat: 46.2198, lng: 6.1388 },
  'meyrin': { lat: 46.2332, lng: 6.0798 }, 'lancy': { lat: 46.1758, lng: 6.1195 },
  'vernier': { lat: 46.2198, lng: 6.0932 }, 'onex': { lat: 46.1832, lng: 6.1072 },
  'bernex': { lat: 46.1702, lng: 6.0982 }, 'paquis': { lat: 46.2105, lng: 6.1468 },
  'charmilles': { lat: 46.2168, lng: 6.1248 }, 'petit-saconnex': { lat: 46.2282, lng: 6.1382 },
  'grand-saconnex': { lat: 46.2382, lng: 6.1182 }, 'acacias': { lat: 46.1935, lng: 6.1382 },
  'thonet': { lat: 46.1882, lng: 6.1948 }, 'veyrier': { lat: 46.1482, lng: 6.1862 },
  'geneve': { lat: 46.2044, lng: 6.1432 },
};

function geocode(q) {
  if (!q) return { lat: 46.2044 + (Math.random() - .5) * .04, lng: 6.1432 + (Math.random() - .5) * .06 };
  const key = q.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const match = Object.entries(GEO).find(([k]) => key.includes(k));
  if (match) return { lat: match[1].lat + (Math.random() - .5) * .003, lng: match[1].lng + (Math.random() - .5) * .005 };
  return { lat: 46.2044 + (Math.random() - .5) * .04, lng: 6.1432 + (Math.random() - .5) * .06 };
}

// ── CYCLE ──────────────────────────────────────────
async function runCycle() {
  const start = Date.now();
  log('════════════════════════════');
  log(`Cycle · ${isDay() ? '1h · Journée' : '2h · Nuit'}`);

  const listings = loadJSON(CONFIG.dataFile, []);
  const seenIds = new Set(loadJSON(CONFIG.seenFile, []));
  let newCount = 0, dupCount = 0, ignoredCount = 0, expiredCount = 0;
  const newListingsForAlerts = [];

  for (const l of listings) {
    if (l.status === 'active' && isExpired(l)) { l.status = 'expired'; expiredCount++; }
  }

  // Vérifier les annonces actives Anibis (max 10 par cycle pour ne pas ralentir)
  const toCheck = listings.filter(l => l.status === 'active' && l.sourceId === 'anibis' && l.sourceUrl).slice(0, 10);
  if (toCheck.length > 0) {
    log(`  → Vérification de ${toCheck.length} annonces Anibis…`);
    const checkBrowser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const checkPage = await checkBrowser.newPage();
    for (const l of toCheck) {
      const online = await isStillOnline(checkPage, l.sourceUrl);
      if (!online) {
        l.status = 'expired';
        expiredCount++;
        log(`    ✗ Expirée: ${l.title}`);
      }
      await sleep(500);
    }
    await checkBrowser.close();
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
        const rawId = block.id || block.link;
        const itemId = Buffer.from(rawId).toString('base64').substring(0, 32);
        if (seenIds.has(itemId)) continue;
        seenIds.add(itemId);

        let text = block.text || '';
        let photo = block.img || '';

        if (text.length < 150 && block.link?.startsWith('http')) {
          log(`    ↗ Visite: ${block.link.substring(0, 65)}`);
          const detail = await enrichDetail(detailPage, block.link, source.type);
          if (detail) {
            if (detail.text.length > text.length) text = detail.text;
            if (!photo && detail.img) photo = detail.img;
          }
          await sleep(rand(500, 1000));
        }

        // Nettoyer le texte
        text = cleanText(text, source.type);

        if (text.length < 30) { log(`    → texte trop court après nettoyage`); continue; }

        log(`    LLM ← "${text.substring(0, 80).replace(/\n/g, ' ')}…"`);
        await sleep(rand(200, 400));
        const ex = await extractWithLLM(text, source.name);
        if (!ex) continue;

        log(`    LLM → ${ex.type} · ${ex.confiance}% · CHF ${ex.prix} · ${ex.quartier}`);

        if (ex.type === 'ignorer') { ignoredCount++; continue; }
        if (ex.confiance === 0 && !ex.prix && !ex.quartier) { ignoredCount++; continue; }

        // Géocodage: essayer Nominatim d'abord, fallback sur dictionnaire
        let coords = await geocodeWithNominatim(null, ex.quartier);
        if (!coords) coords = geocode(ex.quartier);
        await sleep(1100); // Respecter le rate limit Nominatim (1 req/sec)
        const listing = {
          id: Date.now() + '_' + Math.random().toString(36).substr(2, 5),
          sourceItemId: itemId, status: 'active', type: ex.type,
          title: ex.titre || `${ex.pieces || '?'}p · ${ex.quartier || 'Genève'}`,
          quartier: ex.quartier || 'Genève', pieces: ex.pieces, prix: ex.prix,
          cc: ex.charges === 'incluses', charges: ex.charges,
          dispo: ex.dispo || null, details: ex.details || [],
          desc: text.substring(0, 500),
          photos: photo ? [photo] : [],
          sourceUrl: block.link || pageUrl,
          sourceName: source.name, sourceId: source.id,
          lat: coords.lat, lng: coords.lng, confiance: ex.confiance,
          scrapedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + CONFIG.expiryDays * 86400000).toISOString(),
          ageHours: 0,
        };

        if (isDuplicate(listing, listings)) { dupCount++; log(`    ≈ doublon`); continue; }
        listings.push(listing);
        newListingsForAlerts.push(listing);
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

  // Notifier les alertes si nouvelles annonces
  if (newCount > 0 && newListingsForAlerts.length > 0) {
    try {
      const r = await fetch('http://localhost:3001/check-alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newListings: newListingsForAlerts }),
      });
      log(`  → Alertes vérifiées (${newListingsForAlerts.length} nouvelles)`);
    } catch(e) { log(`  ⚠ Check-alerts: ${e.message}`); }
  }
}

async function main() {
  log('NextCasa Bot v15 · Anibis · Rentola · PetitesAnnonces');
  while (true) {
    try { await runCycle(); } catch (e) { log(`✗ ${e.message}`); }
    const i = getNextInterval();
    log(`Prochain cycle dans ${Math.round(i / 60000)} min…`);
    await sleep(i);
  }
}

main().catch(e => { log(`✗ Fatal: ${e.message}`); process.exit(1); });
