/**
 * bot.mjs — NextCasa v5
 * Sources: Anibis · ImmoScout24 · PetitesAnnonces · Rentola
 * - Pagination (3 pages max par source)
 * - Filtre 2 jours max
 * - Canton Genève
 * - Ouvre chaque annonce si infos manquantes
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
      pages: [
        'https://www.anibis.ch/fr/q/immobilier-geneve-appartements-maisons-louer/Ak8CqcmVhbEVzdGF0ZZSSkqtsaXN0aW5nVHlwZZKpYXBhcnRtZW50pWhvdXNlkqlwcmljZVR5cGWkUkVOVMDAkZOobG9jYXRpb26xZ2VvLWNhbnRvbi1nZW5ldmXA?sorting=newest&page=1',
        'https://www.anibis.ch/fr/q/immobilier-geneve-appartements-maisons-louer/Ak8CqcmVhbEVzdGF0ZZSSkqtsaXN0aW5nVHlwZZKpYXBhcnRtZW50pWhvdXNlkqlwcmljZVR5cGWkUkVOVMDAkZOobG9jYXRpb26xZ2VvLWNhbnRvbi1nZW5ldmXA?sorting=newest&page=2',
        'https://www.anibis.ch/fr/q/immobilier-geneve-appartements-maisons-louer/Ak8CqcmVhbEVzdGF0ZZSSkqtsaXN0aW5nVHlwZZKpYXBhcnRtZW50pWhvdXNlkqlwcmljZVR5cGWkUkVOVMDAkZOobG9jYXRpb26xZ2VvLWNhbnRvbi1nZW5ldmXA?sorting=newest&page=3',
      ],
      waitFor: 5000,
      type: 'anibis',
    },
    {
      id: 'immoscout',
      name: 'ImmoScout24.ch',
      pages: [
        'https://www.immoscout24.ch/fr/immobilier/louer/lieu-geneve?o=dateCreated-desc',
        'https://www.immoscout24.ch/fr/immobilier/louer/lieu-geneve?o=dateCreated-desc&pn=2',
        'https://www.immoscout24.ch/fr/immobilier/louer/lieu-geneve?o=dateCreated-desc&pn=3',
      ],
      waitFor: 6000,
      type: 'immoscout',
    },
    {
      id: 'petitesannonces',
      name: 'PetitesAnnonces.ch',
      pages: [
        'https://www.petitesannonces.ch/r/270608?od=desc&ob=submissionDate',
      ],
      waitFor: 3000,
      type: 'generic',
    },
    {
      id: 'rentola',
      name: 'Rentola.ch',
      pages: [
        'https://rentola.ch/fr/a-louer?location=geneve-region&order=desc&property_types=apartment',
        'https://rentola.ch/fr/a-louer?location=geneve-region&order=desc&property_types=apartment&page=2',
        'https://rentola.ch/fr/a-louer?location=geneve-region&order=desc&property_types=apartment&page=3',
      ],
      waitFor: 4000,
      type: 'generic',
    },
  ],

  maxAgeDays: 2,

  schedule: {
    dayStart: 6,
    dayEnd: 24,
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

// ── ACCEPTER COOKIES ─────────────────────────────────────────────────
async function acceptCookies(page) {
  try {
    await page.click([
      'button:has-text("Tout accepter")',
      'button:has-text("Accepter tout")',
      'button:has-text("Accept all")',
      'button:has-text("Accepter")',
      '#onetrust-accept-btn-handler',
      '[data-cy*="accept"]',
      '[class*="accept-all"]',
    ].join(', '), { timeout: 3000 });
    await sleep(800);
  } catch {}
}

// ── SCRAPER ANIBIS ───────────────────────────────────────────────────
async function scrapeAnibisPage(page, url, waitFor) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 40000 });
  await sleep(waitFor);
  await acceptCookies(page);
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await sleep(800);
  }

  const info = await page.evaluate(() => ({ title: document.title, len: document.body.innerText.length }));
  log(`    Page: "${info.title.substring(0, 60)}" · ${info.len} chars`);

  return await page.evaluate((max) => {
    const results = [];
    // Anibis: les annonces sont dans des liens /vi/
    const links = Array.from(document.querySelectorAll('a[href*="/vi/"]'));
    const seen = new Set();

    links.forEach(a => {
      if (seen.has(a.href)) return;
      seen.add(a.href);

      let el = a;
      // Remonter pour trouver le bloc complet
      for (let i = 0; i < 5; i++) {
        if (el.parentElement && el.parentElement.innerText?.length > 80 && el.parentElement.innerText?.length < 2000) {
          el = el.parentElement;
        } else break;
      }

      const text = el.innerText?.trim() || '';
      const img = el.querySelector('img[src*="http"]')?.src || el.querySelector('img')?.src || '';

      // Vérifier âge - chercher texte contenant "jour" ou "heure"
      const textLower = text.toLowerCase();
      const tooOld = textLower.match(/(\d+)\s*jour/) && parseInt(textLower.match(/(\d+)\s*jour/)[1]) > 2;
      if (tooOld) return;

      if (text.length > 40 && results.length < max) {
        results.push({ text: text.substring(0, 800), link: a.href, img });
      }
    });
    return results;
  }, max);
}

// ── SCRAPER IMMOSCOUT ────────────────────────────────────────────────
// ImmoScout n'a pas de dates → on prend les 3 premières pages
// Les nouvelles annonces apparaîtront à chaque cycle
async function scrapeImmoScoutPage(page, url, waitFor) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 40000 });
  await sleep(waitFor);
  await acceptCookies(page);
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await sleep(1000);
  }

  const info = await page.evaluate(() => ({ title: document.title, len: document.body.innerText.length }));
  log(`    Page: "${info.title.substring(0, 60)}" · ${info.len} chars`);

  if (info.len < 500) {
    // Page vide — ImmoScout bloque peut-être. Essayer de cliquer sur quelque chose
    log(`    ⚠ Page quasi-vide, tentative de chargement forcé…`);
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await sleep(4000);
    await acceptCookies(page);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await sleep(1200);
    }
  }

  return await page.evaluate((max) => {
    const results = [];
    // ImmoScout: chercher les liens d'annonces
    const linkPatterns = ['a[href*="/fr/"][href*="louer"]', 'a[href*="/annonce"]', 'a[href*="/listing"]', 'a[href*="/immobilier"]'];
    let links = [];
    for (const pat of linkPatterns) {
      links = Array.from(document.querySelectorAll(pat)).filter(a => a.href.match(/\/\d{6,}/));
      if (links.length > 3) break;
    }

    // Fallback: tous les liens avec des chiffres (IDs d'annonces)
    if (links.length === 0) {
      links = Array.from(document.querySelectorAll('a[href]')).filter(a => a.href.match(/\/\d{7,}/));
    }

    const seen = new Set();
    links.forEach(a => {
      if (seen.has(a.href)) return;
      seen.add(a.href);
      let el = a;
      for (let i = 0; i < 5; i++) {
        if (el.parentElement?.innerText?.length > 60 && el.parentElement?.innerText?.length < 2000) {
          el = el.parentElement;
        } else break;
      }
      const text = el.innerText?.trim() || '';
      const img = el.querySelector('img[src*="http"]')?.src || '';
      if (text.length > 40 && results.length < max) {
        results.push({ text: text.substring(0, 800), link: a.href, img });
      }
    });
    return results;
  }, max);
}

// ── SCRAPER GÉNÉRIQUE (PetitesAnnonces, Rentola) ──────────────────────
async function scrapeGenericPage(page, url, waitFor) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(waitFor);
  await acceptCookies(page);
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await sleep(800);
  }

  const info = await page.evaluate(() => ({ title: document.title, len: document.body.innerText.length }));
  log(`    Page: "${info.title.substring(0, 60)}" · ${info.len} chars`);

  return await page.evaluate((max) => {
    const results = [];
    const selectors = [
      '[class*="listing"]', '[class*="result"]', '[class*="article"]',
      '[class*="card"]', '[class*="offer"]', '[class*="property"]',
      'article', 'li[class]',
    ];

    let cards = [];
    for (const sel of selectors) {
      cards = Array.from(document.querySelectorAll(sel))
        .filter(el => el.innerText?.length > 40 && el.innerText?.length < 3000);
      if (cards.length > 3) break;
    }

    if (cards.length === 0) {
      // Fallback: liens
      const links = Array.from(document.querySelectorAll('a[href]'))
        .filter(a => {
          const h = a.href.toLowerCase();
          return h.includes('appart') || h.includes('louer') || h.includes('immo') || h.match(/\/\d{5,}/);
        });
      links.slice(0, max).forEach(a => {
        let el = a;
        for (let i = 0; i < 4; i++) {
          if (el.parentElement?.innerText?.length > 50) el = el.parentElement;
          else break;
        }
        const text = el.innerText?.trim() || '';
        if (text.length > 40) results.push({ text: text.substring(0, 600), link: a.href, img: el.querySelector('img')?.src || '' });
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
      if (text.length > 40) results.push({ text: text.substring(0, 600), link, img });
    });
    return results;
  }, max);
}

// ── OUVRIR ANNONCE POUR PLUS D'INFOS ─────────────────────────────────
async function enrichFromDetailPage(page, url) {
  if (!url || !url.startsWith('http')) return null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(1500);
    const text = await page.evaluate(() => document.body.innerText?.trim().substring(0, 1000) || '');
    const img = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img[src*="http"]'))
        .filter(i => i.naturalWidth > 200 || i.width > 200);
      return imgs[0]?.src || '';
    });
    return { text, img };
  } catch {
    return null;
  }
}

// ── LLM ──────────────────────────────────────────────────────────────
async function extractWithLLM(text, sourceName) {
  // Nettoyer le texte pour éviter les erreurs JSON
  const cleanText = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').substring(0, 500);

  const prompt = `Extracteur d'annonces immobilières genevoises.
Source: "${sourceName}"
Texte: "${cleanText}"

Réponds UNIQUEMENT en JSON sur une seule ligne.
Si pas une offre de location dans le canton de Genève → type: "ignorer".
Si info manquante → mets "/".

{"type":"logement|parking|ignorer","raison_ignorer":null,"titre":"string","quartier":"string","pieces":null,"prix":null,"charges":"incluses|non incluses|inconnues","dispo":"string","details":[],"confiance":0}`;

  try {
    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw = r.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    // Prendre uniquement la première ligne JSON valide
    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{')) {
        return JSON.parse(trimmed);
      }
    }
    return JSON.parse(raw);
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
  'thonet': { lat: 46.1972, lng: 6.2012 }, 'cologny': { lat: 46.2132, lng: 6.1882 },
  'pregny': { lat: 46.2382, lng: 6.1482 }, 'grand-saconnex': { lat: 46.2382, lng: 6.1182 },
  'geneve': { lat: 46.2044, lng: 6.1432 },
};

function geocode(quartier) {
  if (!quartier || quartier === '/') return { lat: 46.2044 + (Math.random()-.5)*.04, lng: 6.1432 + (Math.random()-.5)*.06 };
  const key = quartier.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const match = Object.entries(GEO).find(([k]) => key.includes(k));
  if (match) return { lat: match[1].lat + (Math.random()-.5)*.003, lng: match[1].lng + (Math.random()-.5)*.005 };
  return { lat: 46.2044 + (Math.random()-.5)*.04, lng: 6.1432 + (Math.random()-.5)*.06 };
}

// ── CYCLE ─────────────────────────────────────────────────────────────
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

  const listPage = await context.newPage();
  const detailPage = await context.newPage();

  for (const source of CONFIG.sources) {
    log(`  → ${source.name} (${source.pages.length} page(s))`);

    for (const pageUrl of source.pages) {
      let blocks = [];
      try {
        if (source.type === 'anibis') {
          blocks = await scrapeAnibisPage(listPage, pageUrl, source.waitFor);
        } else if (source.type === 'immoscout') {
          blocks = await scrapeImmoScoutPage(listPage, pageUrl, source.waitFor);
        } else {
          blocks = await scrapeGenericPage(listPage, pageUrl, source.waitFor);
        }
        log(`    ${blocks.length} blocs · page ${source.pages.indexOf(pageUrl) + 1}`);
      } catch (e) {
        log(`    ✗ page: ${e.message}`);
        continue;
      }

      await sleep(rand(2000, 4000));

      for (const block of blocks) {
        const itemId = Buffer.from((block.link || block.text || '').substring(0, 120)).toString('base64').substring(0, 32);
        if (seenIds.has(itemId)) continue;
        seenIds.add(itemId);

        let textToAnalyze = block.text;
        let photo = block.img;

        // Si le texte est trop court → ouvrir la page de l'annonce
        if (textToAnalyze.length < 80 && block.link) {
          log(`    → Enrichissement: ${block.link.substring(0, 60)}`);
          const detail = await enrichFromDetailPage(detailPage, block.link);
          if (detail) {
            textToAnalyze = (textToAnalyze + ' ' + detail.text).trim();
            if (!photo && detail.img) photo = detail.img;
          }
          await sleep(rand(800, 1500));
        }

        await sleep(rand(300, 700));
        const ex = await extractWithLLM(textToAnalyze, source.name);
        if (!ex || ex.type === 'ignorer') { if (ex) ignoredCount++; continue; }
        if (ex.confiance < CONFIG.minConfidence) continue;

        const coords = geocode(ex.quartier);
        const listing = {
          id: Date.now() + '_' + Math.random().toString(36).substr(2, 5),
          sourceItemId: itemId,
          status: 'active',
          type: ex.type,
          title: ex.titre && ex.titre !== '/' ? ex.titre : `${ex.pieces || '/'}p · ${ex.quartier || 'Genève'}`,
          quartier: (ex.quartier && ex.quartier !== '/') ? ex.quartier : 'Genève',
          pieces: ex.pieces !== '/' ? ex.pieces : null,
          prix: (ex.prix && ex.prix !== '/') ? ex.prix : null,
          cc: ex.charges === 'incluses',
          charges: ex.charges,
          dispo: (ex.dispo && ex.dispo !== '/') ? ex.dispo : '/',
          details: (ex.details || []).filter(d => d !== '/'),
          desc: textToAnalyze.substring(0, 500),
          photos: photo ? [photo] : [],
          sourceUrl: block.link || pageUrl,
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
        log(`    ✓ ${listing.title} · CHF ${listing.prix || '/'}`);
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
  log('NextCasa Bot v5 · Anibis · ImmoScout24 · PetitesAnnonces · Rentola');
  log(`Horaire: 1h/jour · 2h/nuit · Filtre: ${CONFIG.maxAgeDays}j · 3 pages/source`);
  while (true) {
    try { await runCycle(); } catch (e) { log(`✗ ${e.message}\n${e.stack?.substring(0, 200)}`); }
    const interval = getNextInterval();
    log(`Prochain cycle dans ${Math.round(interval/60000)} min…`);
    await sleep(interval);
  }
}

main().catch(e => { log(`✗ Fatal: ${e.message}`); process.exit(1); });

