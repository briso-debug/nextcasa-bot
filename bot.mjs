/**
 * bot.mjs — NextCasa
 * Scrape les annonces de remise depuis les groupes Facebook genevois publics.
 * - Expire automatiquement après 14 jours
 * - Détecte "trouvé preneur" et clôture l'annonce
 * - Filtre sous-locations et demandes
 */

import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CONFIG ─────────────────────────────────────────────────────────
const CONFIG = {
  groups: [
    {
      id: '427260557756842',
      name: 'Remise GE · Logements à louer',
      url: 'https://www.facebook.com/groups/427260557756842/'
    },
    {
      id: '6589374757815649',
      name: 'Appartements Genève',
      url: 'https://www.facebook.com/groups/6589374757815649/'
    },
    {
      id: 'appartementgeneve',
      name: 'Appartement Genève (page)',
      url: 'https://www.facebook.com/appartementgeneve/'
    },
    {
      id: '855901884450191',
      name: 'Groupe immobilier GE 1',
      url: 'https://www.facebook.com/groups/855901884450191/'
    },
    {
      id: '1008325196003055',
      name: 'Groupe immobilier GE 2',
      url: 'https://www.facebook.com/groups/1008325196003055/'
    },
    {
      id: '1469906983121973',
      name: 'Groupe immobilier GE 3',
      url: 'https://www.facebook.com/groups/1469906983121973/'
    },
  ],

  scrolls: 6,
  delayMin: 2500,
  delayMax: 6000,
  minConfidence: 60,
  expiryDays: 14,

  // Mots-clés qui indiquent que l'annonce est pourvue
  closedKeywords: [
    'trouvé preneur', 'trouve preneur', 'trouvé quelqu\'un', 'trouve quelqu\'un',
    'c\'est pris', 'cest pris', 'plus disponible', 'plus dispo',
    'loué', 'loue', 'annonce clôturée', 'annonce cloturee',
    'bail signé', 'bail signe', 'dossier accepté', 'dossier accepte',
    'merci à tous', 'merci a tous', 'found someone', 'taken', 'rented',
    'reprise effectuée', 'reprise effectuee', 'c\'est bon merci',
  ],

  dataFile: path.join(__dirname, 'data', 'listings.json'),
  seenFile: path.join(__dirname, 'data', 'seen_posts.json'),
};

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── HELPERS ────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min) + min);
const delay = () => sleep(rand(CONFIG.delayMin, CONFIG.delayMax));

function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return fallback;
}

function saveJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function log(msg) {
  const ts = new Date().toLocaleTimeString('fr-CH');
  console.log(`[${ts}] ${msg}`);
}

function makePostId(text) {
  return Buffer.from(text.substring(0, 80)).toString('base64').substring(0, 24);
}

// ── DÉTECTION "TROUVÉ PRENEUR" ─────────────────────────────────────
function isClosed(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CONFIG.closedKeywords.some(kw => lower.includes(kw));
}

// ── EXPIRATION ─────────────────────────────────────────────────────
function isExpired(listing) {
  const age = Date.now() - new Date(listing.scrapedAt).getTime();
  return age > CONFIG.expiryDays * 24 * 60 * 60 * 1000;
}

// ── EXTRACTION LLM ─────────────────────────────────────────────────
async function extractWithLLM(postText, groupName) {
  const prompt = `Tu es un extracteur d'annonces immobilières pour la région genevoise.
Analyse ce post Facebook et extrait les informations.

Groupe source: "${groupName}"
Post: "${postText}"

RÈGLES STRICTES:
1. Réponds UNIQUEMENT avec du JSON valide, aucun texte avant/après.
2. Ignore les posts qui CHERCHENT un logement.
3. Ignore les sous-locations (sauf parkings/boxes).
4. Inclus les parkings et boxes de garage.
5. "cc" ou "charges comprises" → charges: "incluses"
6. Quartiers genevois: Carouge, Plainpalais, Jonction, Eaux-Vives, Champel, Servette, Meyrin, Lancy, Vernier, Onex, Bernex, Pâquis, Saint-Gervais, Grottes, Charmilles, Châtelaine...
7. Ne mets JAMAIS le nom de famille — prénom uniquement.

Format JSON:
{
  "type": "logement" | "parking" | "ignorer",
  "raison_ignorer": null | "cherche logement" | "sous-location" | "autre",
  "titre": "Xp · Quartier",
  "prenom": "Prénom uniquement",
  "quartier": "nom du quartier",
  "ville": "Genève",
  "pieces": null ou nombre décimal,
  "prix": null ou entier CHF/mois,
  "charges": "incluses" | "non incluses" | "inconnues",
  "dispo": "Immédiat" | "date" | "inconnue",
  "details": ["liste", "de", "caractéristiques"],
  "confiance": 0-100
}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw = response.content.map(b => b.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    log(`  ⚠ Erreur LLM: ${e.message}`);
    return null;
  }
}

// ── GÉOCODAGE ──────────────────────────────────────────────────────
const GEO = {
  'carouge':       { lat: 46.1848, lng: 6.1425 },
  'plainpalais':   { lat: 46.1965, lng: 6.1412 },
  'jonction':      { lat: 46.2002, lng: 6.1302 },
  'eaux-vives':    { lat: 46.2018, lng: 6.1625 },
  'champel':       { lat: 46.1920, lng: 6.1530 },
  'servette':      { lat: 46.2198, lng: 6.1388 },
  'meyrin':        { lat: 46.2332, lng: 6.0798 },
  'lancy':         { lat: 46.1758, lng: 6.1195 },
  'vernier':       { lat: 46.2198, lng: 6.0932 },
  'onex':          { lat: 46.1832, lng: 6.1072 },
  'bernex':        { lat: 46.1702, lng: 6.0982 },
  'paquis':        { lat: 46.2105, lng: 6.1468 },
  'saint-gervais': { lat: 46.2072, lng: 6.1408 },
  'grottes':       { lat: 46.2115, lng: 6.1358 },
  'charmilles':    { lat: 46.2168, lng: 6.1248 },
  'chatelaine':    { lat: 46.2172, lng: 6.1082 },
  'geneve':        { lat: 46.2044, lng: 6.1432 },
};

function geocode(quartier) {
  if (!quartier) return { lat: 46.2044 + (Math.random()-.5)*.04, lng: 6.1432 + (Math.random()-.5)*.06 };
  const key = quartier.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const match = Object.entries(GEO).find(([k]) => key.includes(k));
  if (match) {
    return {
      lat: match[1].lat + (Math.random()-.5) * 0.004,
      lng: match[1].lng + (Math.random()-.5) * 0.006
    };
  }
  return { lat: 46.2044 + (Math.random()-.5)*.04, lng: 6.1432 + (Math.random()-.5)*.06 };
}

// ── SCRAPER ────────────────────────────────────────────────────────
async function scrapeGroup(page, group) {
  log(`→ Scraping: ${group.name}`);
  const posts = [];

  try {
    await page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay();

    // Fermer popups
    try { await page.click('[aria-label="Fermer"]', { timeout: 3000 }); await sleep(800); } catch {}
    try { await page.keyboard.press('Escape'); await sleep(500); } catch {}

    // Scroll
    for (let i = 0; i < CONFIG.scrolls; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
      await sleep(rand(1500, 3000));
      log(`  Scroll ${i+1}/${CONFIG.scrolls}…`);
    }

    // Extraire posts
    const rawPosts = await page.evaluate(() => {
      const results = [];
      const articles = document.querySelectorAll('[role="article"]');
      articles.forEach(article => {
        try {
          const textEl = article.querySelector('[data-ad-comet-preview="message"], [dir="auto"]');
          const text = textEl ? textEl.innerText.trim() : '';
          if (!text || text.length < 20) return;

          const links = article.querySelectorAll('a[href*="/groups/"]');
          let postUrl = '';
          links.forEach(a => {
            if (a.href.includes('/permalink/') || a.href.includes('?id=')) postUrl = a.href;
          });

          const imgs = [];
          article.querySelectorAll('img[src*="scontent"]').forEach(img => {
            if (img.src && img.naturalWidth > 200) imgs.push(img.src);
          });

          const timeEl = article.querySelector('abbr, [data-utime]');
          const age = timeEl ? timeEl.innerText || timeEl.getAttribute('title') : '';

          results.push({ text, postUrl, photos: imgs.slice(0, 5), age });
        } catch {}
      });
      return results;
    });

    log(`  ${rawPosts.length} posts bruts trouvés`);
    return rawPosts.map(p => ({ ...p, groupId: group.id, groupName: group.name, groupUrl: group.url }));

  } catch (e) {
    log(`  ✗ Erreur scraping ${group.name}: ${e.message}`);
    return [];
  }
}

// ── PIPELINE PRINCIPAL ─────────────────────────────────────────────
async function run() {
  log('════════════════════════════════');
  log('NextCasa Bot démarré');
  log(`${CONFIG.groups.length} groupes · expiry ${CONFIG.expiryDays}j`);
  log('════════════════════════════════');

  const listings = loadJSON(CONFIG.dataFile, []);
  const seenPosts = new Set(loadJSON(CONFIG.seenFile, []));

  // ── ÉTAPE 1 : Vérifier annonces existantes (trouvé preneur / expirées) ──
  log('Vérification des annonces existantes…');
  let closedCount = 0;
  let expiredCount = 0;

  for (const listing of listings) {
    if (listing.status === 'active') {
      if (isExpired(listing)) {
        listing.status = 'expired';
        expiredCount++;
        log(`  ⏱ Expirée: ${listing.title}`);
      }
    }
  }

  // ── ÉTAPE 2 : Scraper les nouveaux posts ──
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=fr-FR']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'fr-FR',
  });

  const page = await context.newPage();
  let newCount = 0;

  for (const group of CONFIG.groups) {
    const rawPosts = await scrapeGroup(page, group);
    await delay();

    for (const post of rawPosts) {
      const postId = makePostId(post.text);

      // Détecter "trouvé preneur" dans les posts existants
      if (isClosed(post.text)) {
        const existing = listings.find(l => l.postId === postId);
        if (existing && existing.status === 'active') {
          existing.status = 'closed';
          existing.closedAt = new Date().toISOString();
          closedCount++;
          log(`  ✓ Clôturée: ${existing.title}`);
        }
        continue;
      }

      if (seenPosts.has(postId)) continue;
      seenPosts.add(postId);

      log(`  Analyse: "${post.text.substring(0, 55)}…"`);
      await sleep(rand(800, 1500));

      const extracted = await extractWithLLM(post.text, post.groupName);
      if (!extracted) continue;

      if (extracted.type === 'ignorer') {
        log(`  → Ignoré: ${extracted.raison_ignorer}`);
        continue;
      }

      if (extracted.confiance < CONFIG.minConfidence) {
        log(`  → Rejeté: confiance ${extracted.confiance}%`);
        continue;
      }

      const coords = geocode(extracted.quartier);

      const listing = {
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        postId,
        status: 'active',
        type: extracted.type,
        title: extracted.titre || `${extracted.pieces || '?'}p · ${extracted.quartier || 'Genève'}`,
        prenom: extracted.prenom || '',
        quartier: extracted.quartier || 'Genève',
        ville: extracted.ville || 'Genève',
        pieces: extracted.pieces,
        prix: extracted.prix,
        cc: extracted.charges === 'incluses',
        charges: extracted.charges,
        dispo: extracted.dispo || 'inconnue',
        details: extracted.details || [],
        desc: post.text.substring(0, 500),
        photos: post.photos,
        postUrl: post.postUrl || post.groupUrl,
        groupId: post.groupId,
        groupName: post.groupName,
        groupUrl: post.groupUrl,
        lat: coords.lat,
        lng: coords.lng,
        confiance: extracted.confiance,
        scrapedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + CONFIG.expiryDays * 24 * 60 * 60 * 1000).toISOString(),
        age: post.age,
      };

      listings.push(listing);
      newCount++;
      log(`  ✓ Ajoutée: ${listing.title} · CHF ${listing.prix || '?'}`);
    }
  }

  await browser.close();

  // Sauvegarder
  saveJSON(CONFIG.dataFile, listings);
  saveJSON(CONFIG.seenFile, [...seenPosts].slice(-10000));

  log('════════════════════════════════');
  log(`Terminé:`);
  log(`  + ${newCount} nouvelles annonces`);
  log(`  ✗ ${closedCount} clôturées (trouvé preneur)`);
  log(`  ⏱ ${expiredCount} expirées (14j)`);
  log(`  Total actives: ${listings.filter(l => l.status === 'active').length}`);
  log('════════════════════════════════');
}

run().catch(e => {
  console.error('Erreur fatale:', e);
  process.exit(1);
});
