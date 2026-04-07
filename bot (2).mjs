/**
 * bot.mjs — NextCasa v6
 * Sources: Anibis (3 pages) · ImmoScout24 (par quartier) · PetitesAnnonces · Rentola
 * - Filtre 2 jours
 * - Dédoublonnage URL + prix/pièces
 * - Ouvre annonce si infos manquantes
 * - 1h/jour · 2h/nuit
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
    // ── ANIBIS 3 pages ──────────────────────────────────────────
    {
      id: 'anibis',
      name: 'Anibis.ch',
      type: 'anibis',
      pages: [
        'https://www.anibis.ch/fr/q/immobilier-geneve-appartements-maisons-louer/Ak8CqcmVhbEVzdGF0ZZSSkqtsaXN0aW5nVHlwZZKpYXBhcnRtZW50pWhvdXNlkqlwcmljZVR5cGWkUkVOVMDAkZOobG9jYXRpb26xZ2VvLWNhbnRvbi1nZW5ldmXA?sorting=newest&page=1',
        'https://www.anibis.ch/fr/q/immobilier-geneve-appartements-maisons-louer/Ak8CqcmVhbEVzdGF0ZZSSkqtsaXN0aW5nVHlwZZKpYXBhcnRtZW50pWhvdXNlkqlwcmljZVR5cGWkUkVOVMDAkZOobG9jYXRpb26xZ2VvLWNhbnRvbi1nZW5ldmXA?sorting=newest&page=2',
        'https://www.anibis.ch/fr/q/immobilier-geneve-appartements-maisons-louer/Ak8CqcmVhbEVzdGF0ZZSSkqtsaXN0aW5nVHlwZZKpYXBhcnRtZW50pWhvdXNlkqlwcmljZVR5cGWkUkVOVMDAkZOobG9jYXRpb26xZ2VvLWNhbnRvbi1nZW5ldmXA?sorting=newest&page=3',
      ],
      waitFor: 5000,
    },
    // ── IMMOSCOUT par quartier (évite le problème React SPA) ────
    {
      id: 'immoscout',
      name: 'ImmoScout24.ch',
      type: 'immoscout',
      pages: [
        'https://www.immoscout24.ch/fr/appartement/louer/canton-geneve',
        'https://www.immoscout24.ch/fr/appartement/louer/canton-geneve?pn=2',
        'https://www.immoscout24.ch/fr/appartement/louer/canton-geneve?pn=3',
      ],
      waitFor: 8000,
    },
    // ── PETITES ANNONCES ────────────────────────────────────────
    {
      id: 'petitesannonces',
      name: 'PetitesAnnonces.ch',
      type: 'generic',
      pages: [
        'https://www.petitesannonces.ch/r/270608?od=desc&ob=submissionDate',
      ],
      waitFor: 3000,
    },
    // ── RENTOLA ─────────────────────────────────────────────────
    {
      id: 'rentola',
      name: 'Rentola.ch',
      type: 'generic',
      pages: [
        'https://rentola.ch/fr/a-louer?location=geneve-region&order=desc&property_types=apartment',
        'https://rentola.ch/fr/a-louer?location=geneve-region&order=desc&property_types=apartment&page=2',
        'https://rentola.ch/fr/a-louer?location=geneve-region&order=desc&property_types=apartment&page=3',
      ],
      waitFor: 4000,
    },
  ],

  maxAgeDays: 2,
  schedule: {
    dayStart: 6, dayEnd: 24,
    dayInterval: 60 * 60 * 1000,
    nightInterval: 2 * 60 * 60 * 1000,
  },
  minConfidence: 40,
  expiryDays: 14,
  maxPerPage: 30,

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
  const btns = ['button:has-text("Tout accepter")', 'button:has-text("Accepter tout")', 'button:has-text("Accept all")', '#onetrust-accept-btn-handler', '[data-cy*="accept"]'];
  for (const btn of btns) {
    try { await page.click(btn, { timeout: 2000 }); await sleep(600); break; } catch {}
  }
}

// ── ANIBIS ──────────────────────────────────────────────────────────
async function scrapeAnibis(page, url, waitFor) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 40000 });
  await sleep(waitFor);
  await acceptCookies(page);
  for (let i = 0; i < 4; i++) { await page.evaluate(() => window.scrollBy(0, window.innerHeight)); await sleep(700); }

  const info = await page.evaluate(() => ({ title: document.title.substring(0, 60), len: document.body.innerText.length }));
  log(`    ${info.title} · ${info.len} chars`);

  return page.evaluate((max) => {
    const results = [];
    const links = Array.from(document.querySelectorAll('a[href*="/vi/"]'));
    const seen = new Set();
    links.forEach(a => {
      if (seen.has(a.href)) return; seen.add(a.href);
      let el = a;
      for (let i = 0; i < 5; i++) {
        if (el.parentElement?.innerText?.length > 80 && el.parentElement?.innerText?.length < 2000) el = el.parentElement;
        else break;
      }
      const text = el.innerText?.trim() || '';
      const textL = text.toLowerCase();
      // Filtre 2 jours
      const dayMatch = textL.match(/(\d+)\s*(?:jour|day)/);
      if (dayMatch && parseInt(dayMatch[1]) > 2) return;
      const img = el.querySelector('img[src*="http"]')?.src || '';
      if (text.length > 40 && results.length < max) results.push({ text: text.substring(0, 800), link: a.href, img });
    });
    return results;
  }, CONFIG.maxPerPage);
}

// ── IMMOSCOUT ────────────────────────────────────────────────────────
// Stratégie: charger la page, attendre JS, extraire les liens d'annonces
// puis visiter chaque annonce individuellement pour le texte complet
async function scrapeImmoScout(page, url, waitFor) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await sleep(waitFor);
  await acceptCookies(page);

  // Scroll agressif pour forcer le chargement React
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
    await sleep(1200);
  }

  const info = await page.evaluate(() => ({ title: document.title.substring(0, 60), len: document.body.innerText.length }));
  log(`    ${info.title} · ${info.len} chars`);

  // Extraire les liens d'annonces ImmoScout
  const links = await page.evaluate(() => {
    const seen = new Set();
    const results = [];
    // ImmoScout: liens avec /fr/ et des chiffres (IDs annonces)
    document.querySelectorAll('a[href]').forEach(a => {
      const h = a.href;
      if (!h.includes('immoscout24.ch')) return;
      if (!h.match(/\/\d{7,}/)) return;
      if (seen.has(h)) return;
      seen.add(h);
      // Prendre le bloc parent pour avoir le texte et l'image
      let el = a;
      for (let i = 0; i < 5; i++) {
        if (el.parentElement?.innerText?.length > 60 && el.parentElement?.innerText?.length < 3000) el = el.parentElement;
        else break;
      }
      const text = el.innerText?.trim() || a.innerText?.trim() || '';
      const img = el.querySelector('img[src*="http"]')?.src || '';
      results.push({ text: text.substring(0, 800), link: h, img });
    });
    return results.slice(0, 30);
  });

  log(`    ${links.length} annonces trouvées`);
  return links;
}

// ── GÉNÉRIQUE (PetitesAnnonces, Rentola) ─────────────────────────────
async function scrapeGeneric(page, url, waitFor) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(waitFor);
  await acceptCookies(page);
  for (let i = 0; i < 3; i++) { await page.evaluate(() => window.scrollBy(0, window.innerHeight)); await sleep(800); }

  const info = await page.evaluate(() => ({ title: document.title.substring(0, 60), len: document.body.innerText.length }));
  log(`    ${info.title} · ${info.len} chars`);

  return page.evaluate((max) => {
    const results = [];
    const selectors = ['[class*="listing"]', '[class*="result"]', '[class*="card"]', '[class*="property"]', 'article', 'li[class]'];
    let cards = [];
    for (const sel of selectors) {
      cards = Array.from(document.querySelectorAll(sel)).filter(el => el.innerText?.length > 40 && el.innerText?.length < 3000);
      if (cards.length > 3) break;
    }
    if (cards.length === 0) {
      // Fallback texte brut
      const blocks = document.body.innerText.split(/\n{2,}/).filter(b => b.trim().length > 40);
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
      if (text.length > 40) results.push({ text: text.substring(0, 600), link, img });
    });
    return results;
  }, max);
}

// ── ENRICHISSEMENT page détail ───────────────────────────────────────
async function enrichDetail(page, url) {
  if (!url?.startsWith('http')) return null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2000);
    const text = await page.evaluate(() => document.body.innerText?.trim().substring(0, 1000) || '');
    const img = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img[src*="http"]')).filter(i => i.width > 150);
      return imgs[0]?.src || '';
    });
    return { text, img };
  } catch { return null; }
}

// ── LLM ─────────────────────────────────────────────────────────────
async function extractWithLLM(text, sourceName) {
  const clean = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/"/g, "'").substring(0, 500);
  const prompt = `Extracteur annonces immobilières Genève. Source: ${sourceName}
Texte: ${clean}

JSON une ligne uniquement. Si pas offre location GE canton → type ignorer.
Info manquante → null.

{"type":"logement|parking|ignorer","raison_ignorer":null,"titre":"string","quartier":"string","pieces":null,"prix":null,"charges":"incluses|non incluses|inconnues","dispo":"string","details":[],"confiance":0}`;

  try {
    const r = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 300, messages: [{ role: 'user', content: prompt }] });
    const raw = r.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    const line = raw.split('\n').find(l => l.trim().startsWith('{')) || raw;
    return JSON.parse(line);
  } catch (e) { log(`    ⚠ LLM: ${e.message}`); return null; }
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
  'geneve': { lat: 46.2044, lng: 6.1432 },
};
function geocode(q) {
  if (!q) return { lat: 46.2044 + (Math.random()-.5)*.04, lng: 6.1432 + (Math.random()-.5)*.06 };
  const key = q.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const match = Object.entries(GEO).find(([k]) => key.includes(k));
  if (match) return { lat: match[1].lat + (Math.random()-.5)*.003, lng: match[1].lng + (Math.random()-.5)*.005 };
  return { lat: 46.2044 + (Math.random()-.5)*.04, lng: 6.1432 + (Math.random()-.5)*.06 };
}

// ── CYCLE ────────────────────────────────────────────────────────────
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
    viewport: { width: 1440, height: 900 }, locale: 'fr-FR', timezoneId: 'Europe/Zurich',
  });

  const listPage = await context.newPage();
  const detailPage = await context.newPage();

  for (const source of CONFIG.sources) {
    log(`  → ${source.name} (${source.pages.length} page(s))`);

    for (const pageUrl of source.pages) {
      let blocks = [];
      try {
        if (source.type === 'anibis') blocks = await scrapeAnibis(listPage, pageUrl, source.waitFor);
        else if (source.type === 'immoscout') blocks = await scrapeImmoScout(listPage, pageUrl, source.waitFor);
        else blocks = await scrapeGeneric(listPage, pageUrl, source.waitFor);
        log(`    ${blocks.length} blocs page ${source.pages.indexOf(pageUrl) + 1}`);
      } catch (e) { log(`    ✗ ${e.message}`); continue; }

      await sleep(rand(2000, 4000));

      for (const block of blocks) {
        const itemId = Buffer.from((block.link || block.text || '').substring(0, 120)).toString('base64').substring(0, 32);
        if (seenIds.has(itemId)) continue;
        seenIds.add(itemId);

        let text = block.text;
        let photo = block.img;

        // Enrichir si texte trop court ou pour ImmoScout (toujours enrichir)
        if ((text.length < 100 || source.type === 'immoscout') && block.link) {
          const detail = await enrichDetail(detailPage, block.link);
          if (detail) {
            if (detail.text.length > text.length) text = detail.text;
            if (!photo && detail.img) photo = detail.img;
          }
          await sleep(rand(600, 1200));
        }

        await sleep(rand(300, 600));
        const ex = await extractWithLLM(text, source.name);
        if (!ex || ex.type === 'ignorer') { if (ex) ignoredCount++; continue; }
        if (ex.confiance < CONFIG.minConfidence) continue;

        const coords = geocode(ex.quartier);
        const listing = {
          id: Date.now() + '_' + Math.random().toString(36).substr(2, 5),
          sourceItemId: itemId, status: 'active',
          type: ex.type,
          title: ex.titre || `${ex.pieces || '?'}p · ${ex.quartier || 'Genève'}`,
          quartier: ex.quartier || 'Genève',
          pieces: ex.pieces, prix: ex.prix,
          cc: ex.charges === 'incluses', charges: ex.charges,
          dispo: ex.dispo || null,
          details: ex.details || [],
          desc: text.substring(0, 500),
          photos: photo ? [photo] : [],
          sourceUrl: block.link || pageUrl,
          sourceName: source.name, sourceId: source.id,
          lat: coords.lat, lng: coords.lng,
          confiance: ex.confiance,
          scrapedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + CONFIG.expiryDays * 86400000).toISOString(),
          ageHours: 0,
        };

        if (isDuplicate(listing, listings)) { dupCount++; continue; }
        listings.push(listing);
        newCount++;
        log(`    ✓ ${listing.title} · CHF ${listing.prix || '?'}`);
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
  log(`+${newCount} · ${dupCount} doublons · ${ignoredCount} ignorées · ${expiredCount} exp. · ${actives} actives · ${Math.round((Date.now()-start)/1000)}s`);
}

async function main() {
  log('NextCasa Bot v6 · Anibis · ImmoScout24 · PetitesAnnonces · Rentola');
  log(`1h/jour (${CONFIG.schedule.dayStart}h-${CONFIG.schedule.dayEnd}h) · 2h/nuit · ${CONFIG.maxAgeDays}j filtre`);
  while (true) {
    try { await runCycle(); } catch (e) { log(`✗ ${e.message}`); }
    const i = getNextInterval();
    log(`Prochain cycle dans ${Math.round(i/60000)} min…`);
    await sleep(i);
  }
}

main().catch(e => { log(`✗ Fatal: ${e.message}`); process.exit(1); });
