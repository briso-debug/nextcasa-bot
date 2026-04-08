/**
 * bot.mjs — NextCasa v9
 * Approche: URLs simples indexées par Google + stealth mode
 * Anibis fonctionne avec ses URLs de catégorie /c/ non /q/
 * Rentola fonctionne déjà
 * PetitesAnnonces fonctionne déjà
 */

import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  maxPerPage: 25,
  sources: [
    // Anibis avec URLs simples de catégorie (indexées par Google)
    {
      id: 'anibis', name: 'Anibis.ch', type: 'anibis',
      pages: [
        'https://www.anibis.ch/fr/q/immobilier-geneve-appartements-louer/Ak8CqcmVhbEVzdGF0ZZSSkqtsaXN0aW5nVHlwZalhcGFydG1lbnSSqXByaWNlVHlwZaRSRU5UwMCRk6hsb2NhdGlvbrFnZW8tY2FudG9uLWdlbmV2ZcA',
      ],
      waitFor: 8000,
    },
    // Rentola fonctionne bien
    {
      id: 'rentola', name: 'Rentola.ch', type: 'rentola',
      pages: [
        'https://rentola.ch/fr/a-louer?location=geneve-region&order=desc&property_types=apartment',
        'https://rentola.ch/fr/a-louer?location=geneve-region&order=desc&property_types=apartment&page=2',
        'https://rentola.ch/fr/a-louer?location=geneve-region&order=desc&property_types=apartment&page=3',
      ],
      waitFor: 4000,
    },
    // PetitesAnnonces fonctionne bien
    {
      id: 'petitesannonces', name: 'PetitesAnnonces.ch', type: 'generic',
      pages: ['https://www.petitesannonces.ch/r/270608?od=desc&ob=submissionDate'],
      waitFor: 3000,
    },

  ],

  schedule: {
    dayStart: 6, dayEnd: 24,
    dayInterval: 60 * 60 * 1000,
    nightInterval: 2 * 60 * 60 * 1000,
  },
  minConfidence: 35,
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
  for (const sel of [
    'button:has-text("Tout accepter")', 'button:has-text("Accept all")',
    'button:has-text("Accepter")', '#onetrust-accept-btn-handler',
    '[data-cy*="accept"]', 'button[class*="accept"]',
  ]) {
    try { await page.click(sel, { timeout: 2000 }); await sleep(500); break; } catch {}
  }
}

async function scrollPage(page, times) {
  for (let i = 0; i < times; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await sleep(rand(700, 1200));
  }
}

// ── ANIBIS avec stealth ───────────────────────────────────────────────
async function scrapeAnibis(page, url, waitFor, maxPerPage) {
  // Simuler navigation humaine - d'abord aller sur la homepage
  try {
    await page.goto('https://www.anibis.ch/fr/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(rand(1500, 2500));
    await acceptCookies(page);
    await sleep(rand(800, 1500));
  } catch {}

  // Puis naviguer vers la page cible
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await sleep(waitFor);
  await scrollPage(page, 5);
  await sleep(2000);

  const info = await page.evaluate(() => ({
    title: document.title.substring(0, 70),
    len: document.body.innerText.length,
    viLinks: document.querySelectorAll('a[href*="/vi/"]').length,
    allLinks: document.querySelectorAll('a[href]').length,
    sample: Array.from(document.querySelectorAll('a[href*="anibis"]')).slice(0, 5).map(a => a.href),
  }));
  log(`    "${info.title}" · ${info.len}c · /vi/: ${info.viLinks} · links: ${info.allLinks}`);
  if (info.sample.length) log(`    Sample: ${info.sample.slice(0,3).join(' | ')}`);

  const items = await page.evaluate((max) => {
    const results = [];
    const seen = new Set();

    // Uniquement vrais liens annonces anibis.ch (pas anibis.help)
    let links = Array.from(document.querySelectorAll('a[href]')).filter(a => {
      const h = a.href || '';
      return h.includes('anibis.ch') && h.includes('/vi/');
    });
    // Fallback: IDs numériques
    if (links.length === 0) {
      links = Array.from(document.querySelectorAll('a[href]')).filter(a => {
        const h = a.href || '';
        return h.includes('anibis.ch') && h.match(/\/\d{6,}/);
      });
    }

    // Fallback final: tous les blocs de texte substantiels
    if (links.length === 0) {
      const blocks = document.body.innerText.split(/\n{3,}/).filter(b => b.trim().length > 80);
      blocks.slice(0, max).forEach(b => results.push({ text: b.trim().substring(0, 700), link: '', img: '' }));
      return results;
    }

    // Debug: tailles des parents pour le premier lien
    if (links.length > 0) {
      const a0 = links[0];
      const sizes = [];
      let el0 = a0;
      for (let i = 0; i < 8; i++) {
        sizes.push(el0.innerText?.length || 0);
        if (!el0.parentElement) break;
        el0 = el0.parentElement;
      }
      window._anibisParentSizes = sizes.join(',');
    }

    links.forEach(a => {
      const href = a.href || '';
      if (!href || seen.has(href)) return;
      seen.add(href);

      // Remonter jusqu'au bon bloc : chercher le plus petit ancêtre
      // qui contient au moins prix ET (quartier OU pièces)
      let best = a;
      let el = a;
      for (let i = 0; i < 8; i++) {
        const p = el.parentElement;
        if (!p || p === document.body) break;
        const t = p.innerText || '';
        // Un bon bloc d'annonce contient CHF ou des pièces
        if ((t.includes('CHF') || t.match(/\d[,.]?\d?\s*p[iè]/i)) && t.length < 15000) {
          best = p;
          break;
        }
        el = p;
      }

      const text = best.innerText?.trim() || a.innerText?.trim() || href;
      const img = best.querySelector('img[src*="http"]')?.src || '';

      if (results.length < max) {
        results.push({ text: text.substring(0, 900), link: href, img });
      }
    });

    return results;
  }, maxPerPage);

  // Log tailles parents pour diagnostic
  const parentSizes = await page.evaluate(() => window._anibisParentSizes || '');
  if (parentSizes) log(`    Parent sizes du 1er lien: ${parentSizes}`);

  log(`    ${items.length} items`);
  return items;
}

// ── RENTOLA ──────────────────────────────────────────────────────────
async function scrapeRentola(page, url, waitFor, maxPerPage) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(waitFor);
  await acceptCookies(page);
  await scrollPage(page, 3);

  const info = await page.evaluate(() => ({ title: document.title.substring(0, 60), len: document.body.innerText.length }));
  log(`    ${info.title} · ${info.len}c`);

  const items = await page.evaluate((max) => {
    const results = [];
    const seen = new Set();

    // Rentola: chercher liens vers annonces individuelles
    const adLinks = Array.from(document.querySelectorAll('a[href]'))
      .filter(a => {
        const h = a.href || '';
        return h.includes('rentola') && h.match(/\/[a-z0-9-]{10,}/);
      });

    if (adLinks.length > 0) {
      adLinks.slice(0, max).forEach(a => {
        if (seen.has(a.href)) return; seen.add(a.href);
        let el = a;
        for (let i = 0; i < 6; i++) {
          const p = el.parentElement;
          if (p && p.innerText?.length > 60 && p.innerText?.length < 5000) el = p;
          else break;
        }
        const text = el.innerText?.trim() || a.innerText?.trim() || '';
        const img = el.querySelector('img[src*="http"]')?.src || '';
        if (text.length > 40) results.push({ text: text.substring(0, 700), link: a.href, img });
      });
    }

    // Fallback: blocs texte brut
    if (results.length === 0) {
      const blocks = document.body.innerText.split(/\n{2,}/).filter(b => b.trim().length > 80 && b.includes('CHF'));
      blocks.slice(0, max).forEach(b => results.push({ text: b.trim().substring(0, 600), link: '', img: '' }));
    }

    return results;
  }, maxPerPage);

  log(`    ${items.length} items`);
  return items;
}

// ── GÉNÉRIQUE ────────────────────────────────────────────────────────
async function scrapeGeneric(page, url, waitFor, maxPerPage) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(waitFor);
  await acceptCookies(page);
  await scrollPage(page, 2);

  const info = await page.evaluate(() => ({ title: document.title.substring(0, 60), len: document.body.innerText.length }));
  log(`    ${info.title} · ${info.len}c`);

  const items = await page.evaluate((maxItems) => {
    const results = [];
    const selectors = ['[class*="listing"]', '[class*="result"]', '[class*="card"]', '[class*="property"]', 'article', 'li[class]'];
    let cards = [];
    for (const sel of selectors) {
      cards = Array.from(document.querySelectorAll(sel)).filter(el => el.innerText?.length > 50 && el.innerText?.length < 3000);
      if (cards.length > 3) break;
    }

    if (cards.length === 0) {
      const blocks = document.body.innerText.split(/\n{2,}/).filter(b => b.trim().length > 60);
      blocks.slice(0, maxItems).forEach(b => results.push({ text: b.trim().substring(0, 600), link: '', img: '' }));
      return results;
    }

    const seen = new Set();
    cards.slice(0, maxItems).forEach(card => {
      const link = card.querySelector('a[href]')?.href || '';
      if (seen.has(link) && link) return;
      if (link) seen.add(link);
      const text = card.innerText?.trim() || '';
      const img = card.querySelector('img[src*="http"]')?.src || '';
      if (text.length > 50) results.push({ text: text.substring(0, 600), link, img });
    });
    return results;
  }, maxPerPage);

  log(`    ${items.length} items`);
  return items;
}

// ── ENRICHISSEMENT ───────────────────────────────────────────────────
async function enrichDetail(page, url) {
  if (!url?.startsWith('http')) return null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(1500);
    const text = await page.evaluate(() => document.body.innerText?.trim().substring(0, 1200) || '');
    const img = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img[src*="http"]')).filter(i => i.width > 150 || i.naturalWidth > 150);
      return imgs[0]?.src || '';
    });
    return { text, img };
  } catch { return null; }
}

// ── LLM ─────────────────────────────────────────────────────────────
async function extractWithLLM(text, sourceName) {
  const clean = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\\/g, '/').substring(0, 600);
  const prompt = `Extracteur annonces immobilières Genève. Source: ${sourceName}
Texte: ${clean}

Accepte si: offre location appartement/maison/parking dans canton Genève ou communes proches (Carouge, Meyrin, Lancy, Onex, Vernier, etc.). Accepte reprises de bail.
Ignore uniquement: vente, cherche à louer (pas offre), hors région genevoise.

UNE SEULE LIGNE JSON:
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
  'acacias': { lat: 46.1935, lng: 6.1382 }, 'thonet': { lat: 46.1972, lng: 6.2012 },
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
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--lang=fr-FR',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'fr-FR',
    timezoneId: 'Europe/Zurich',
    extraHTTPHeaders: {
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    },
  });

  // Masquer l'automatisation
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const listPage = await context.newPage();
  const detailPage = await context.newPage();

  for (const source of CONFIG.sources) {
    log(`  → ${source.name} (${source.pages.length} page(s))`);

    for (let pi = 0; pi < source.pages.length; pi++) {
      const pageUrl = source.pages[pi];
      let blocks = [];

      try {
        if (source.type === 'anibis') blocks = await scrapeAnibis(listPage, pageUrl, source.waitFor, CONFIG.maxPerPage);
        else if (source.type === 'rentola') blocks = await scrapeRentola(listPage, pageUrl, source.waitFor, CONFIG.maxPerPage);
        else blocks = await scrapeGeneric(listPage, pageUrl, source.waitFor, CONFIG.maxPerPage);
        log(`    ${blocks.length} blocs page ${pi + 1}`);
      } catch (e) {
        log(`    ✗ page ${pi + 1}: ${e.message.substring(0, 80)}`);
        continue;
      }

      await sleep(rand(2000, 4000));

      for (const block of blocks) {
        const itemId = Buffer.from((block.link || block.text || '').substring(0, 120)).toString('base64').substring(0, 32);
        if (seenIds.has(itemId)) continue;
        seenIds.add(itemId);

        let text = block.text;
        let photo = block.img;

        if (text.length < 120 && block.link?.startsWith('http')) {
          const detail = await enrichDetail(detailPage, block.link);
          if (detail) {
            if (detail.text.length > text.length) text = detail.text;
            if (!photo && detail.img) photo = detail.img;
          }
          await sleep(rand(400, 800));
        }

        await sleep(rand(200, 500));
        const ex = await extractWithLLM(text, source.name);
        if (!ex) continue;
        if (ex.type === 'ignorer') { ignoredCount++; continue; }
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
  log('NextCasa Bot v9 · Anibis · Rentola · PetitesAnnonces');
  log(`1h/jour · 2h/nuit · confiance: ${CONFIG.minConfidence}%`);
  while (true) {
    try { await runCycle(); } catch (e) { log(`✗ ${e.message}`); }
    const i = getNextInterval();
    log(`Prochain cycle dans ${Math.round(i / 60000)} min…`);
    await sleep(i);
  }
}

main().catch(e => { log(`✗ Fatal: ${e.message}`); process.exit(1); });
