/**
 * bot.mjs — NextCasa v3
 * Scraping robuste : attend le rendu JS, extrait tout le texte visible
 * Sources: Anibis · ImmoScout24 · Ricardo · PetitesAnnonces
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
      url: 'https://www.anibis.ch/fr/c/immobilier-immobilier-locations/geneve',
      waitFor: 3000,
    },
    {
      id: 'immoscout',
      name: 'ImmoScout24.ch',
      url: 'https://www.immoscout24.ch/fr/immobilier/louer/canton-geneve?sort=NewestFirstListing',
      waitFor: 4000,
    },
    {
      id: 'petitesannonces',
      name: 'PetitesAnnonces.ch',
      url: 'https://www.petitesannonces.ch/r/270108',
      waitFor: 2000,
    },
    {
      id: 'ricardo',
      name: 'Ricardo.ch',
      url: 'https://www.ricardo.ch/fr/s/?q=appartement+gen%C3%A8ve+louer&sort=newest',
      waitFor: 3000,
    },
  ],

  schedule: {
    dayStart: 6,
    dayEnd: 24,
    dayInterval: 60 * 60 * 1000,
    nightInterval: 2 * 60 * 60 * 1000,
  },

  minConfidence: 50,
  expiryDays: 14,
  maxListingsPerSource: 20,

  closedKeywords: [
    'trouvé preneur', 'trouve preneur', "c'est pris", 'plus disponible',
    'loué', 'bail signé', 'merci à tous', 'found someone', 'taken', 'rented',
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
    const samePrix = listing.prix && e.prix && Math.abs(listing.prix - e.prix) <= 80;
    const samePieces = listing.pieces && e.pieces && listing.pieces === e.pieces;
    const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const sameQ = norm(listing.quartier) && norm(e.quartier) &&
      (norm(listing.quartier).includes(norm(e.quartier)) || norm(e.quartier).includes(norm(listing.quartier)));
    return (samePrix && samePieces) || (samePrix && sameQ) || (samePieces && sameQ && samePrix);
  });
}

// ── SCRAPER ROBUSTE ─────────────────────────────────────────────────
// Stratégie : charger la page, attendre le JS, extraire les blocs de texte
// avec leurs liens et images associés
async function scrapePage(page, source) {
  log(`  → ${source.name}`);
  try {
    await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // Accepter les cookies si présents
    try {
      await page.click('button:has-text("Accepter"), button:has-text("Accept"), button:has-text("Tout accepter"), [id*="accept"], [class*="accept-all"]', { timeout: 4000 });
      await sleep(1000);
    } catch {}

    // Attendre que le contenu JS se charge
    await sleep(source.waitFor);

    // Scroll pour charger le contenu lazy
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await sleep(1500);
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await sleep(1000);

    // Extraire tous les blocs textuels avec liens et images
    const blocks = await page.evaluate((maxItems) => {
      const results = [];

      // Stratégie 1 : chercher des éléments avec des liens vers des annonces
      const linkSelectors = [
        'a[href*="/vi/"], a[href*="/listing/"], a[href*="/annonce/"], a[href*="/ad/"]',
        'a[href*="immobilier"], a[href*="appartement"], a[href*="logement"]',
        '[class*="listing"] a, [class*="result"] a, [class*="article"] a',
      ];

      let anchors = [];
      for (const sel of linkSelectors) {
        try {
          const found = Array.from(document.querySelectorAll(sel));
          if (found.length > 2) { anchors = found; break; }
        } catch {}
      }

      // Si pas de liens spécifiques, chercher des conteneurs génériques
      if (anchors.length === 0) {
        const containerSelectors = [
          '[class*="listing"]', '[class*="result"]', '[class*="article"]',
          '[class*="ad-item"]', '[class*="offer"]', 'li[class]', 'div[class*="item"]'
        ];
        let containers = [];
        for (const sel of containerSelectors) {
          try {
            containers = Array.from(document.querySelectorAll(sel))
              .filter(el => el.innerText && el.innerText.length > 30);
            if (containers.length > 2) break;
          } catch {}
        }
        containers.slice(0, maxItems).forEach(el => {
          const text = el.innerText?.trim() || '';
          const link = el.querySelector('a[href]')?.href || '';
          const img = el.querySelector('img[src*="http"]')?.src || '';
          if (text.length > 20) results.push({ text, link, img });
        });
        return results;
      }

      // Remonter au parent le plus pertinent pour chaque lien
      const seen = new Set();
      anchors.slice(0, maxItems * 3).forEach(a => {
        const href = a.href;
        if (seen.has(href) || !href) return;
        seen.add(href);

        // Remonter 3 niveaux max pour trouver le bloc parent
        let el = a;
        for (let i = 0; i < 3; i++) {
          if (el.parentElement && el.parentElement.innerText?.length > 50) el = el.parentElement;
          else break;
        }

        const text = el.innerText?.trim() || a.innerText?.trim() || '';
        const img = el.querySelector('img[src*="http"]')?.src || '';
        if (text.length > 20 && results.length < maxItems) {
          results.push({ text: text.substring(0, 600), link: href, img });
        }
      });

      return results;
    }, CONFIG.maxListingsPerSource);

    log(`    ${blocks.length} blocs extraits`);
    return blocks.map(b => ({ ...b, sourceId: source.id, sourceName: source.name, sourceUrl: source.url }));

  } catch (e) {
    log(`    ✗ ${source.name}: ${e.message}`);
    return [];
  }
}

// ── EXTRACTION LLM ──────────────────────────────────────────────────
async function extractWithLLM(text, sourceName) {
  const prompt = `Tu es un extracteur d'annonces immobilières pour la région genevoise.

Source: "${sourceName}"
Texte extrait: "${text.substring(0, 500)}"

Analyse ce texte et réponds UNIQUEMENT avec du JSON valide.
Si ce n'est pas une annonce de location (vente, recherche, colocation, hors Genève) → type: "ignorer".

{
  "type": "logement" | "parking" | "ignorer",
  "raison_ignorer": null | "vente" | "cherche" | "sous-location" | "hors-zone" | "autre",
  "titre": "Xp · Quartier ou type",
  "quartier": "nom du quartier genevois",
  "pieces": null ou nombre décimal (ex: 3.5),
  "prix": null ou entier CHF/mois (loyer mensuel uniquement),
  "charges": "incluses" | "non incluses" | "inconnues",
  "dispo": "Immédiat" | "date texte" | "inconnue",
  "details": ["max 3 caractéristiques courtes"],
  "confiance": 0-100
}

Quartiers genevois: Carouge, Plainpalais, Jonction, Eaux-Vives, Champel, Servette, Meyrin, Lancy, Vernier, Onex, Bernex, Pâquis, Saint-Gervais, Grottes, Charmilles, Châtelaine, Bachet, Avanchets, Conches, Cologny, Vandœuvres, Thônex, Chêne-Bougeries, Chêne-Bourg.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
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
  'thonet': { lat: 46.1972, lng: 6.2012 }, 'conches': { lat: 46.1918, lng: 6.1762 },
  'cologny': { lat: 46.2132, lng: 6.1882 }, 'geneve': { lat: 46.2044, lng: 6.1432 },
};

function geocode(quartier) {
  if (!quartier) return { lat: 46.2044 + (Math.random()-.5)*.04, lng: 6.1432 + (Math.random()-.5)*.06 };
  const key = quartier.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
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

  // Expirer
  for (const l of listings) {
    if (l.status === 'active' && isExpired(l)) { l.status = 'expired'; expiredCount++; }
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--lang=fr-FR', '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'fr-FR',
    timezoneId: 'Europe/Zurich',
    extraHTTPHeaders: { 'Accept-Language': 'fr-FR,fr;q=0.9' },
  });

  const page = await context.newPage();

  for (const source of CONFIG.sources) {
    const blocks = await scrapePage(page, source);
    await sleep(rand(3000, 6000));

    for (const block of blocks) {
      // ID unique basé sur le lien ou le texte
      const itemId = Buffer.from((block.link || block.text || '').substring(0, 120)).toString('base64').substring(0, 32);

      if (seenIds.has(itemId)) continue;
      seenIds.add(itemId);

      await sleep(rand(400, 900));
      const ex = await extractWithLLM(block.text, source.name);

      if (!ex) continue;
      if (ex.type === 'ignorer') { ignoredCount++; continue; }
      if (ex.confiance < CONFIG.minConfidence) {
        log(`    → Rejeté (${ex.confiance}%): ${block.text.substring(0, 40)}`);
        continue;
      }

      const coords = geocode(ex.quartier);
      const listing = {
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        sourceItemId: itemId,
        status: 'active',
        type: ex.type,
        title: ex.titre || `${ex.pieces || '?'}p · ${ex.quartier || 'Genève'}`,
        quartier: ex.quartier || 'Genève',
        pieces: ex.pieces,
        prix: ex.prix || parseInt((block.text.match(/(\d{3,5})\s*(?:chf|fr|.-)/i) || [])[1] || '0') || null,
        cc: ex.charges === 'incluses',
        charges: ex.charges,
        dispo: ex.dispo || 'inconnue',
        details: ex.details || [],
        desc: block.text.substring(0, 500),
        photos: block.img ? [block.img] : [],
        // URL source — visible uniquement dans le modal au clic
        sourceUrl: block.link || source.url,
        sourceName: source.name,
        sourceId: source.id,
        lat: coords.lat,
        lng: coords.lng,
        confiance: ex.confiance,
        scrapedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + CONFIG.expiryDays * 86400000).toISOString(),
        ageHours: 0,
      };

      if (isDuplicate(listing, listings)) {
        dupCount++;
        log(`    ≈ Doublon: ${listing.title}`);
        continue;
      }

      listings.push(listing);
      newCount++;
      log(`    ✓ ${source.name}: ${listing.title} · CHF ${listing.prix || '?'}`);
    }
  }

  await browser.close();

  // Mettre à jour ageHours
  for (const l of listings) {
    if (l.status === 'active') {
      l.ageHours = Math.round((Date.now() - new Date(l.scrapedAt).getTime()) / 3600000);
    }
  }

  saveJSON(CONFIG.dataFile, listings);
  saveJSON(CONFIG.seenFile, [...seenIds].slice(-20000));

  const actives = listings.filter(l => l.status === 'active').length;
  log(`Résultat: +${newCount} · ${dupCount} doublons · ${ignoredCount} ignorées · ${expiredCount} exp. · ${actives} actives · ${Math.round((Date.now()-start)/1000)}s`);
}

// ── MAIN ─────────────────────────────────────────────────────────────
async function main() {
  log('NextCasa Bot v3 — Anibis · ImmoScout24 · Ricardo · PetitesAnnonces');
  log(`Horaire: 1h/jour (${CONFIG.schedule.dayStart}h-${CONFIG.schedule.dayEnd}h) · 2h/nuit`);

  while (true) {
    try { await runCycle(); } catch (e) { log(`✗ Erreur: ${e.message}\n${e.stack}`); }
    const interval = getNextInterval();
    log(`Prochain cycle dans ${Math.round(interval/60000)} min…`);
    await sleep(interval);
  }
}

main().catch(e => { log(`✗ Fatal: ${e.message}`); process.exit(1); });

