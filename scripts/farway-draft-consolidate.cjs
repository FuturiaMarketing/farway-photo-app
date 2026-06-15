#!/usr/bin/env node
'use strict';

/**
 * farway-draft-consolidate.cjs
 *
 * Consolida i prodotti WooCommerce in `status=draft` (~293) generati dall'import ERP
 * in prodotti `variable` parent + variazioni, raggruppando per Modello.
 * Tutto resta in `draft`. I simple originali finiscono in `trash` con marker di riferimento al parent.
 *
 * Modi:
 *   - dry-run (default): legge WC, scrive report `.md` + payload JSON, nessuna scrittura API
 *   - apply: scrive su WC (richiede --confirm FARWAY_DRAFTS_CONSOLIDATED_APPROVED)
 *
 * Convenzioni (dal plan):
 *   - Attributi prodotto Farway: solo Colore e Taglia/Età (no `pa_genere`)
 *   - Genere = categoria WP (Maschio/Femmina/Unisex)
 *   - Anno, Stagione, Magazzino, is_campionatura, original_sku → ACF/meta `fw_erp_*`
 *   - Inferenza categorie mancanti: attiva aggressiva (default Unisex + Abbigliamento)
 *   - Idempotente: skip simple già trashed con `_fw_consolidated_into`, skip parent già creati
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

// ============================================================
// COSTANTI
// ============================================================

const APPLY_CONFIRMATION = 'FARWAY_DRAFTS_CONSOLIDATED_APPROVED';
const WC_API_TIMEOUT_MS = 60000;
const WC_WRITE_DELAY_MS = 200; // pausa tra scritture per non saturare IONOS

// Mappe (riprodotte da farway-erp-reconcile-products.cjs per indipendenza)
const SIZE_MAP = new Map([
  ['os', 'OS'], ['one size', 'OS'], ['unica', 'OS'],
  ['3 m', '3-6 mesi'], ['3m', '3-6 mesi'], ['3 mesi', '3-6 mesi'],
  ['6 m', '3-6 mesi'], ['6m', '3-6 mesi'], ['6 mesi', '3-6 mesi'],
  ['9 m', '1 anno'], ['9m', '1 anno'], ['9 mesi', '1 anno'],
  ['12 m', '1 anno'], ['12m', '1 anno'], ['12 mesi', '1 anno'],
  ['18 m', '2 anni'], ['18m', '2 anni'], ['18 mesi', '2 anni'],
  ['24 m', '2 anni'], ['24m', '2 anni'], ['24 mesi', '2 anni'],
  ['1 y', '1 anno'], ['1y', '1 anno'], ['1 anno', '1 anno'],
  ['2 y', '2 anni'], ['2y', '2 anni'], ['2 anni', '2 anni'],
  ['3 y', '3-4 anni'], ['3y', '3-4 anni'], ['3 anni', '3-4 anni'],
  ['4 y', '3-4 anni'], ['4y', '3-4 anni'], ['4 anni', '3-4 anni'],
  ['3-4 anni', '3-4 anni'], ['3-4 y', '3-4 anni'],
  ['5 y', '5-6 anni'], ['5y', '5-6 anni'], ['5 anni', '5-6 anni'],
  ['6 y', '5-6 anni'], ['6y', '5-6 anni'], ['6 anni', '5-6 anni'],
  ['5-6 anni', '5-6 anni'], ['5-6 y', '5-6 anni'],
  ['7 y', '7-8 anni'], ['7y', '7-8 anni'], ['7 anni', '7-8 anni'],
  ['8 y', '7-8 anni'], ['8y', '7-8 anni'], ['8 anni', '7-8 anni'],
  ['7-8 anni', '7-8 anni'], ['7-8 y', '7-8 anni'],
  ['9 y', '9-10 anni'], ['9y', '9-10 anni'], ['9 anni', '9-10 anni'],
  ['10 y', '9-10 anni'], ['10y', '9-10 anni'], ['10 anni', '9-10 anni'],
  ['9-10 anni', '9-10 anni'], ['9-10 y', '9-10 anni'],
  // Token "9-12 mesi" / "12mesi" — Farway ha una fascia "9-12 mesi" separata
  ['9-12 mesi', '9-12 mesi'], ['9-12mesi', '9-12 mesi'], ['9 12 mesi', '9-12 mesi'],
  ['12mesi', '9-12 mesi'],
  // "4ANNI" / "4 anni" / "4anni" → "3-4 anni"
  ['4anni', '3-4 anni'],
]);

// Whitelist esplicita di modelli "codice" che restano sempre simple in bozza,
// indipendentemente dal numero di varianti raggruppate.
const EXPLICIT_CODE_WHITELIST = new Set([
  'CAP01', 'SCI01', 'SCI02', 'CAPPELLO',
  'FARY-TSH01', 'FARY-TSH02', 'FARY-TSH03', 'FARY-TSH04', 'FARY-TSH05',
  'FARY-CAM06',
  'MCA02', 'PAN06', 'FCM01',
]);

// Pattern aggiuntivi: modelli alfanumerici / FARY- / single-word all-caps.
// Restano simple solo se il gruppo ha ≤2 varianti (singoli prototipi).
// Se hanno ≥3 varianti, vengono consolidati come parent variable.
const CODE_MODEL_PATTERNS = [
  /^[A-Z]+\d+$/,           // AB04, CAM06, CAM08, CAM11, ...
  /^FARY-[A-Z]+\d*$/,      // (riservato per future varianti)
  /^[A-Z]{6,12}$/,         // single word all-caps 6-12 char
];

function matchesCodePattern(modello) {
  const trimmed = String(modello || '').trim();
  if (!trimmed) return false;
  return CODE_MODEL_PATTERNS.some((re) => re.test(trimmed));
}

function shouldKeepSimple(modello, variationCount) {
  const m = String(modello).trim();
  if (EXPLICIT_CODE_WHITELIST.has(m)) return true;
  if (matchesCodePattern(m) && variationCount <= 2) return true;
  return false;
}

// Token che, se trovati come "colore" dal parser, vanno riclassificati in altro campo.
const COLOR_RECLASSIFY_RULES = [
  // Età travestite da colore
  { regex: /^4\s*anni?$/i, kind: 'eta', value: '3-4 anni' },
  { regex: /^9\s*-?\s*12\s*mes(e|i)?$/i, kind: 'eta', value: '9-12 mesi' },
  { regex: /^12\s*mes(e|i)?$/i, kind: 'eta', value: '9-12 mesi' },
  // Tessuti / materiali travestiti da colore
  { regex: /^mussolin[ae]?$/i, kind: 'tessuto', value: 'Mussolina' },
];

function reclassifyColorToken(token) {
  const raw = String(token || '').trim();
  if (!raw) return null;
  for (const rule of COLOR_RECLASSIFY_RULES) {
    if (rule.regex.test(raw)) return { kind: rule.kind, value: rule.value };
  }
  return null;
}

const COLOR_RULES = [
  { label: 'Giallo e ocra', slug: 'giallo-e-ocra', regex: /\b(giallo|yellow|chardonnay|chandonney|cedro|cdr|sudan|ocra|cream)\b/ },
  { label: 'Rosso e ciliegia', slug: 'rosso-e-ciliegia', regex: /\b(rosso|red|tango|amb|ciliegia|cherry)\b/ },
  { label: 'Azzurro polvere e denim', slug: 'azzurro-polvere-e-denim', regex: /\b(denim|azzurro|polvere|jeans)\b/ },
  { label: 'Verde bosco e scuri', slug: 'verde-bosco-e-scuri', regex: /\b(verde|green|cedar|mint|kaki|khaki|bosco)\b/ },
  { label: 'Rosa cipria e nude', slug: 'rosa-cipria-e-nude', regex: /\b(rosa|rose|pink|nude|cipria|sogno|renai|petunia|prugna)\b/ },
  { label: 'Panna e avorio', slug: 'panna-e-avorio', regex: /\b(panna|avorio|ivory|ecru|natur|natural|weiss|white)\b/ },
  { label: 'Fantasie animali', slug: 'fantasie-animali', regex: /\b(animali|gatti|cat|fantasia|flowers|floreale|tejido|mtd|sre|stampa|allover)\b/ },
  { label: 'Blu e azzurro intenso', slug: 'blu-e-azzurro-intenso', regex: /\b(blu|blue|bluette|bonnet|navy|notte)\b/ },
  { label: 'Marrone e mocha', slug: 'marrone-e-mocha', regex: /\b(marrone|brown|mocha)\b/ },
  { label: 'Lilla e lavanda', slug: 'lilla-e-lavanda', regex: /\b(lilla|lavanda|lavender|glicine|lil)\b/ },
];

const PRODUCT_KIND_RULES = [
  { kind: 'abito', regex: /\b(ab|abito|vestito|natalizio|scamiciata)\b/ },
  { kind: 'pantaloncino', regex: /\b(pantaloncino|pantaloncini|shorts|short)\b/ },
  { kind: 'pantalone', regex: /\b(pan|pt|pantalone|pantaloni)\b/ },
  { kind: 'camicia', regex: /\b(cam|cm|mca|camicia|camicie|blusa|coreana)\b/ },
  { kind: 'gonna', regex: /\b(gn|gonna|gonne)\b/ },
  { kind: 't-shirt', regex: /\b(ts|tsh|t-shirt|tshirt|maglietta)\b/ },
  { kind: 'felpa', regex: /\b(fel|felpa|felpe)\b/ },
  { kind: 'giacca', regex: /\b(giacca|giubbino|cardigan|sopravveste)\b/ },
  { kind: 'top', regex: /\b(top)\b/ },
  { kind: 'body', regex: /\b(body|tutina)\b/ },
  { kind: 'borsa', regex: /\b(bag|borsa|borse|raffia|yes)\b/ },
  { kind: 'scrunchies', regex: /\b(scrunch|elastico capelli|hair ties)\b/ },
  { kind: 'fiocco', regex: /\b(fiocco|fiocchi|bow|mollette|clip)\b/ },
  { kind: 'cerchietto', regex: /\b(cerchietto|cerchietti)\b/ },
  { kind: 'fermaglio', regex: /\b(fermaglio|fermagli)\b/ },
];

// Mappa kind → slug categoria WP attesa (per inferenza)
const KIND_TO_CATEGORY_SLUG = {
  abito: ['abiti'],
  pantalone: ['pantaloni'],
  pantaloncino: ['pantaloncini'],
  camicia: ['camicie'],
  gonna: ['gonne'],
  't-shirt': ['t-shirt'],
  felpa: ['felpe'],
  giacca: ['giacche'],
  top: ['top'],
  body: ['body-e-tutine', 'tutine'],
  borsa: ['borse'],
  scrunchies: ['scrunchies', 'accessori-capelli'],
  fiocco: ['fiocchi', 'accessori-capelli'],
  cerchietto: ['cerchietti', 'accessori-capelli'],
  fermaglio: ['fermagli', 'accessori-capelli'],
};

// Hint per inferenza genere
const FEMININE_KIND_HINTS = new Set(['abito', 'gonna', 'scrunchies', 'fiocco', 'cerchietto', 'fermaglio', 'top']);
const FEMININE_COLOR_RE = /\b(rosa|lilla|fucsia|cipria|petunia)\b/i;
const MASCULINE_HINTS_RE = /\b(maschio|bambino|boys?)\b/i;

// ============================================================
// PARSE ARGS
// ============================================================

function parseArgs(argv) {
  const args = {
    apply: false,
    confirm: '',
    outputDir: '',
    reuseDir: '',
    limitDrafts: 0,
    limitGroups: 0,
    skipBackup: false,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i] || '');
    if (a === '--apply') { args.apply = true; continue; }
    if (a === '--confirm') { args.confirm = String(argv[i + 1] || '').trim(); i += 1; continue; }
    if (a === '--output-dir') { args.outputDir = String(argv[i + 1] || '').trim(); i += 1; continue; }
    if (a === '--reuse-dir') { args.reuseDir = String(argv[i + 1] || '').trim(); i += 1; continue; }
    if (a === '--limit-drafts') { args.limitDrafts = Number(argv[i + 1] || 0); i += 1; continue; }
    if (a === '--limit-groups') { args.limitGroups = Number(argv[i + 1] || 0); i += 1; continue; }
    if (a === '--skip-backup') { args.skipBackup = true; continue; }
    if (a === '--verbose' || a === '-v') { args.verbose = true; continue; }
    if (a === '--dry-run') { /* esplicito ma è il default */ continue; }
  }

  return args;
}

function nowCompact() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// ENV LOADING + WC SETTINGS
// ============================================================

async function loadEnvFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const sep = trimmed.indexOf('=');
      if (sep <= 0) continue;
      const key = trimmed.slice(0, sep).trim();
      if (!key || process.env[key]) continue;
      let v = trimmed.slice(sep + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[key] = v;
    }
  } catch {
    // env file is optional during testing
  }
}

async function resolveWooSettings(scriptDir) {
  const envPath = path.join(scriptDir, '..', '.env.local');
  await loadEnvFile(envPath);
  const storeUrl = String(process.env.WC_STORE_URL || '').trim().replace(/\/$/, '');
  const consumerKey = String(process.env.WC_CONSUMER_KEY || '').trim();
  const consumerSecret = String(process.env.WC_CONSUMER_SECRET || '').trim();
  if (!storeUrl || !consumerKey || !consumerSecret) {
    throw new Error(`Credenziali WooCommerce mancanti. Verificare ${envPath} (WC_STORE_URL, WC_CONSUMER_KEY, WC_CONSUMER_SECRET).`);
  }
  return { storeUrl, consumerKey, consumerSecret };
}

// ============================================================
// WC API CLIENT
// ============================================================

async function fetchWithTimeout(url, init = {}, timeoutMs = WC_API_TIMEOUT_MS) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(tid);
  }
}

function buildWooUrl(settings, endpoint) {
  const auth = `consumer_key=${encodeURIComponent(settings.consumerKey)}&consumer_secret=${encodeURIComponent(settings.consumerSecret)}`;
  const sep = endpoint.includes('?') ? '&' : '?';
  return `${settings.storeUrl}/wp-json/wc/v3/${endpoint}${sep}${auth}`;
}

async function wooRequest(settings, method, endpoint, body) {
  const res = await fetchWithTimeout(buildWooUrl(settings, endpoint), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const snippet = String(text).slice(0, 500);
    throw new Error(`Woo ${method} ${endpoint} -> HTTP ${res.status}: ${snippet}`);
  }
  return data;
}

async function wooFetchAll(settings, endpoint, extraQuery = '') {
  const rows = [];
  let page = 1;
  while (true) {
    const baseSep = endpoint.includes('?') ? '&' : '?';
    const qs = `per_page=100&page=${page}${extraQuery ? '&' + extraQuery : ''}`;
    const batch = await wooRequest(settings, 'GET', `${endpoint}${baseSep}${qs}`);
    if (!Array.isArray(batch)) throw new Error(`Risposta Woo inattesa per ${endpoint}`);
    rows.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return rows;
}

// ============================================================
// UTILITY
// ============================================================

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(value) {
  return normalizeText(value).replace(/\s+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

function normalizeSize(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const compact = raw
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\banni?\b/g, 'anni')
    .replace(/\byears?\b/g, 'y')
    .replace(/\byr\b/g, 'y')
    .replace(/\bmonths?\b/g, 'm')
    .replace(/\bmesi?\b/g, 'mesi')
    .replace(/\s+/g, ' ')
    .trim();
  if (SIZE_MAP.has(compact)) return SIZE_MAP.get(compact);
  const yearMatch = compact.match(/^(\d{1,2})\s*y$/);
  if (yearMatch) {
    const y = Number(yearMatch[1]);
    if (y === 1) return '1 anno';
    if (y === 2) return '2 anni';
    if (y === 3 || y === 4) return '3-4 anni';
    if (y === 5 || y === 6) return '5-6 anni';
    if (y === 7 || y === 8) return '7-8 anni';
    if (y === 9 || y === 10) return '9-10 anni';
  }
  const plain = compact.match(/^(\d{1,2})$/);
  if (plain) return normalizeSize(`${plain[1]}y`);
  return '';
}

function normalizeColor(value) {
  const raw = String(value ?? '').trim();
  const n = normalizeText(raw);
  if (!n) return { label: '', slug: '' };
  for (const rule of COLOR_RULES) {
    if (rule.regex.test(n)) return { label: rule.label, slug: rule.slug };
  }
  return { label: raw, slug: slugify(raw) };
}

function inferProductKind(...values) {
  const text = normalizeText(values.filter(Boolean).join(' '));
  for (const rule of PRODUCT_KIND_RULES) {
    if (rule.regex.test(text)) return rule.kind;
  }
  return '';
}

function getMetaValue(metaData, key) {
  if (!Array.isArray(metaData)) return undefined;
  for (const m of metaData) {
    if (m && m.key === key) return m.value;
  }
  return undefined;
}

// ============================================================
// PARSING NOME PRODOTTO DRAFT
// ============================================================

/**
 * Parse del nome draft seguendo pattern Farway:
 *   "<Modello> – <Colore> – <Età> – <Anno> [(<Magazzino>)]"
 *
 * Esempi:
 *   "Pantaloncino Capri – Blu navy e notte – 7-8 anni – 2025 (Doha)"
 *   "Abito Anjeliy – Verde bosco – 5-6 anni – 2023"
 *
 * Strategia: split sui separator dash (– — -), poi identifica i token in coda.
 */
function parseDraftName(name) {
  const result = {
    raw_name: String(name || ''),
    modello: '',
    colore_label: '',
    colore_slug: '',
    eta: '',
    anno: '',
    location: '',
    confidence: 'ok', // 'ok' | 'partial' | 'needs_review'
    notes: [],
  };

  let raw = String(name || '').trim();
  if (!raw) {
    result.confidence = 'needs_review';
    result.notes.push('empty_name');
    return result;
  }

  // Estrai eventuale "(Magazzino)" finale
  const locMatch = raw.match(/\s*\(([^)]+)\)\s*$/);
  if (locMatch) {
    result.location = locMatch[1].trim();
    raw = raw.slice(0, raw.length - locMatch[0].length).trim();
  }

  // Split su dash con spazi attorno
  const tokens = raw.split(/\s+[–—\-]\s+/).map((t) => t.trim()).filter(Boolean);

  // Pop year (4 cifre 20xx) dalla coda
  if (tokens.length > 0 && /^20\d{2}$/.test(tokens[tokens.length - 1])) {
    result.anno = tokens.pop();
  }

  // Pop size dalla coda
  if (tokens.length > 0) {
    const sizeNorm = normalizeSize(tokens[tokens.length - 1]);
    if (sizeNorm) {
      result.eta = sizeNorm;
      tokens.pop();
    }
  }

  // tokens rimanenti: [modello, ..., colore]
  if (tokens.length >= 2) {
    const lastToken = tokens[tokens.length - 1];

    // PRIMA controlla se il "colore" è in realtà età o tessuto travestito
    const reclass = reclassifyColorToken(lastToken);
    if (reclass) {
      if (reclass.kind === 'eta') {
        if (!result.eta) result.eta = reclass.value;
        result.notes.push(`reclassified_${lastToken}_as_eta_${reclass.value}`);
      } else if (reclass.kind === 'tessuto') {
        result.tessuto = reclass.value;
        result.notes.push(`reclassified_${lastToken}_as_tessuto_${reclass.value}`);
      }
      // Colore resta vuoto: il token è stato riassegnato.
      result.modello = tokens.slice(0, -1).join(' – ').trim();
    } else {
      const colNorm = normalizeColor(lastToken);
      if (colNorm.label) {
        result.colore_label = colNorm.label;
        result.colore_slug = colNorm.slug;
        result.modello = tokens.slice(0, -1).join(' – ').trim();
      } else {
        // colore non riconosciuto, includilo nel modello
        result.modello = tokens.join(' – ').trim();
        result.notes.push('color_token_not_recognized');
      }
    }
  } else if (tokens.length === 1) {
    result.modello = tokens[0].trim();
  }

  // Confidence
  if (!result.modello) {
    result.confidence = 'needs_review';
    result.notes.push('missing_modello');
  } else if (!result.colore_label || !result.eta) {
    result.confidence = 'partial';
    if (!result.colore_label) result.notes.push('missing_colore');
    if (!result.eta) result.notes.push('missing_eta');
  }

  return result;
}

/**
 * Estende un parsing con i meta `fw_erp_*` del draft come fallback.
 */
function enrichParseWithMeta(parsed, metaData) {
  const seasonMeta = getMetaValue(metaData, 'fw_erp_season');
  const yearMeta = getMetaValue(metaData, 'fw_erp_year');
  const locationMeta = getMetaValue(metaData, 'fw_erp_location');
  const isCampMeta = getMetaValue(metaData, 'fw_erp_is_campionatura');
  const originalSku = getMetaValue(metaData, 'fw_erp_original_sku');

  if (!parsed.anno && yearMeta) {
    parsed.anno = String(yearMeta).trim();
  }
  if (!parsed.location && locationMeta) {
    parsed.location = String(locationMeta).trim();
  }

  parsed.season = seasonMeta ? String(seasonMeta).trim() : '';
  parsed.is_campionatura = String(isCampMeta || '').toLowerCase() === 'true' || isCampMeta === 1 || isCampMeta === '1';
  parsed.original_sku = originalSku ? String(originalSku).trim() : '';

  // Location default
  if (!parsed.location) {
    parsed.location = 'Milano';
  }

  return parsed;
}

// ============================================================
// CANONICAL KEY (chiave gruppo parent)
// ============================================================

/**
 * Chiave canonica del parent: modello normalizzato + flag campionatura.
 * Magazzino/anno NON entrano (sono ACF varianti).
 */
function buildParentCanonicalKey(parsed) {
  const modelloSlug = slugify(parsed.modello);
  const campSuffix = parsed.is_campionatura ? '__camp' : '';
  return `${modelloSlug}${campSuffix}`;
}

/**
 * Chiave variante: per detect duplicati esatti.
 */
function buildVariationKey(parsed) {
  return [
    parsed.colore_slug || 'no-color',
    slugify(parsed.eta) || 'no-eta',
    slugify(parsed.location) || 'milano',
    parsed.anno || 'no-year',
    parsed.is_campionatura ? 'camp' : 'pf',
    parsed.original_sku || 'no-sku',
  ].join('|');
}

// ============================================================
// PHASE 0 — DISCOVERY
// ============================================================

async function discoverWooState(settings, outputDir, args) {
  console.log('[phase 0] discovery WooCommerce...');

  // Fetch all drafts
  console.log('  - fetch prodotti status=draft...');
  let drafts = await wooFetchAll(settings, 'products', 'status=draft');
  console.log(`  ✓ ${drafts.length} prodotti draft trovati`);

  if (args.limitDrafts > 0 && drafts.length > args.limitDrafts) {
    console.log(`  - applico --limit-drafts=${args.limitDrafts}, riduco`);
    drafts = drafts.slice(0, args.limitDrafts);
  }

  // Fetch attributi globali
  console.log('  - fetch attributi globali...');
  const attributes = await wooFetchAll(settings, 'products/attributes');
  console.log(`  ✓ ${attributes.length} attributi globali`);

  // Fetch termini per ogni attributo
  console.log('  - fetch termini attributi...');
  const attributeTerms = {};
  for (const attr of attributes) {
    const terms = await wooFetchAll(settings, `products/attributes/${attr.id}/terms`);
    attributeTerms[attr.id] = terms;
    console.log(`    · attr ${attr.slug} (id ${attr.id}): ${terms.length} termini`);
  }

  // Fetch categorie WC
  console.log('  - fetch categorie prodotto...');
  const categories = await wooFetchAll(settings, 'products/categories');
  console.log(`  ✓ ${categories.length} categorie`);

  // Fetch alcuni prodotti pubblicati di riferimento (per shape)
  console.log('  - fetch sample prodotti pubblicati (variable, top 5)...');
  const referencePublished = await wooFetchAll(
    settings,
    'products',
    'status=publish&type=variable'
  );
  const sampleRef = referencePublished.slice(0, 5);
  console.log(`  ✓ ${sampleRef.length}/${referencePublished.length} sample salvati`);

  // Backup
  if (!args.skipBackup) {
    await fs.writeFile(path.join(outputDir, 'backup-drafts.json'), JSON.stringify(drafts, null, 2), 'utf8');
    await fs.writeFile(
      path.join(outputDir, 'backup-attributes.json'),
      JSON.stringify({ attributes, terms: attributeTerms }, null, 2),
      'utf8'
    );
    await fs.writeFile(path.join(outputDir, 'backup-categories.json'), JSON.stringify(categories, null, 2), 'utf8');
    await fs.writeFile(path.join(outputDir, 'reference-published.json'), JSON.stringify(sampleRef, null, 2), 'utf8');
    console.log(`  ✓ backup scritti in ${outputDir}`);
  }

  // Identifica attributi rilevanti: Colore e Taglia/Età
  const attrColore = attributes.find((a) => /color/i.test(a.slug) || /color/i.test(a.name));
  const attrEta = attributes.find((a) => /taglia|eta|et[àa]/i.test(a.slug) || /taglia|et[àa]/i.test(a.name));

  if (!attrColore) console.warn('  ⚠ attributo "Colore" NON trovato tra globali');
  if (!attrEta) console.warn('  ⚠ attributo "Taglia/Età" NON trovato tra globali');

  // Identifica categorie genere
  const categoriesBySlug = new Map(categories.map((c) => [c.slug, c]));
  const categoriesByNameNorm = new Map(categories.map((c) => [normalizeText(c.name), c]));
  const genderCats = {
    maschio: categoriesByNameNorm.get('maschio') || categoriesBySlug.get('maschio'),
    femmina: categoriesByNameNorm.get('femmina') || categoriesBySlug.get('femmina'),
    unisex: categoriesByNameNorm.get('unisex') || categoriesBySlug.get('unisex'),
  };

  return {
    drafts,
    attributes,
    attributeTerms,
    attrColore,
    attrEta,
    categories,
    categoriesBySlug,
    categoriesByNameNorm,
    genderCats,
    referencePublished: sampleRef,
  };
}

// ============================================================
// PHASE 1 — PARSE + GROUP
// ============================================================

function findCategoryByCandidateSlugs(categoriesBySlug, candidates) {
  for (const slug of candidates) {
    const c = categoriesBySlug.get(slug);
    if (c) return c;
  }
  return null;
}

function inferGenderFromName(parsed) {
  const text = normalizeText([parsed.modello, parsed.colore_label].filter(Boolean).join(' '));
  const kind = inferProductKind(parsed.modello, parsed.colore_label);
  if (MASCULINE_HINTS_RE.test(text)) return 'maschio';
  if (FEMININE_KIND_HINTS.has(kind)) return 'femmina';
  if (FEMININE_COLOR_RE.test(text)) return 'femmina';
  return 'unisex'; // default conservativo
}

function inferTypeCategorySlugs(parsed) {
  const kind = inferProductKind(parsed.modello, parsed.colore_label);
  if (kind && KIND_TO_CATEGORY_SLUG[kind]) return KIND_TO_CATEGORY_SLUG[kind];
  return ['abbigliamento']; // fallback root
}

function unionArray(target, items) {
  for (const it of items || []) {
    if (!target.some((t) => t.id === it.id)) target.push(it);
  }
}

async function parseAndGroup(state) {
  console.log('[phase 1] parsing nomi + raggruppamento...');

  const groups = new Map(); // canonicalKey -> group object
  const manualReview = []; // drafts che non riusciamo a classificare
  const conflicts = []; // accumulator per conflicts.md

  for (const draft of state.drafts) {
    // Skip se già processato (idempotenza)
    const consolidatedInto = getMetaValue(draft.meta_data, '_fw_consolidated_into');
    if (consolidatedInto) {
      conflicts.push({
        type: 'already_consolidated',
        draft_id: draft.id,
        name: draft.name,
        consolidated_into: consolidatedInto,
      });
      continue;
    }

    const parsed = parseDraftName(draft.name);
    enrichParseWithMeta(parsed, draft.meta_data);
    parsed.source_id = draft.id;
    parsed.source_sku = draft.sku || '';
    parsed.source_price = draft.regular_price || draft.price || '';
    parsed.source_status = draft.status;

    if (parsed.confidence === 'needs_review') {
      manualReview.push({
        draft_id: draft.id,
        name: draft.name,
        notes: parsed.notes,
        parsed,
      });
      continue;
    }

    const canonKey = buildParentCanonicalKey(parsed);
    if (!groups.has(canonKey)) {
      groups.set(canonKey, {
        canonical_key: canonKey,
        modello: parsed.modello,
        is_campionatura: !!parsed.is_campionatura,
        variations: [], // {parsed, draft}
        variation_keys: new Set(),
        source_simple_ids: [],
        duplicate_simple_ids: [], // duplicati esatti, trashati al pari di source_simple_ids
        // raccolta dati da consolidare sul parent
        categories_union_by_id: [],
        images_union_by_id: [],
        descriptions: [], // {id, html_len, html}
        short_descriptions: [],
        tags_union_by_id: [],
        prices_seen: new Set(),
      });
    }

    const group = groups.get(canonKey);
    const varKey = buildVariationKey(parsed);
    if (group.variation_keys.has(varKey)) {
      // Duplicato puro: stesso modello+colore+età+location+anno+camp+original_sku.
      // Lo aggiungo a duplicate_simple_ids per trasharlo in apply, mantenendo
      // il primo come variante canonica.
      const canonicalVariation = group.variations.find((v) => buildVariationKey(v.parsed) === varKey);
      group.duplicate_simple_ids.push({
        draft_id: draft.id,
        duplicate_of: canonicalVariation ? canonicalVariation.draft.id : null,
        name: draft.name,
      });
      conflicts.push({
        type: 'duplicate_variation_key',
        canonical_key: canonKey,
        variation_key: varKey,
        new_draft_id: draft.id,
        new_name: draft.name,
        kept_canonical: canonicalVariation ? canonicalVariation.draft.id : null,
      });
      continue;
    }
    group.variation_keys.add(varKey);

    group.variations.push({ parsed, draft });
    group.source_simple_ids.push(draft.id);

    // Union categorie/immagini/tags
    unionArray(group.categories_union_by_id, draft.categories || []);
    unionArray(group.images_union_by_id, draft.images || []);
    unionArray(group.tags_union_by_id, draft.tags || []);

    if (draft.description) {
      group.descriptions.push({
        id: draft.id,
        len: String(draft.description).length,
        html: draft.description,
      });
    }
    if (draft.short_description) {
      group.short_descriptions.push({
        id: draft.id,
        len: String(draft.short_description).length,
        html: draft.short_description,
      });
    }
    if (draft.regular_price) group.prices_seen.add(String(draft.regular_price));
  }

  // Per ogni gruppo, scegli canonical (id più basso), risolvi descrizioni, calcola categorie finali
  const groupList = [];
  for (const group of groups.values()) {
    // Filtro modelli codice: se whitelist esplicita OR pattern + ≤2 varianti → resta simple
    if (shouldKeepSimple(group.modello, group.variations.length)) {
      for (const v of group.variations) {
        conflicts.push({
          type: 'skipped_code_model',
          draft_id: v.draft.id,
          name: v.draft.name,
          modello: group.modello,
          variation_count_in_group: group.variations.length,
          reason: EXPLICIT_CODE_WHITELIST.has(group.modello)
            ? 'whitelist esplicita'
            : 'pattern codice + ≤2 varianti',
        });
      }
      continue;
    }

    // sort source ids ascending
    group.source_simple_ids.sort((a, b) => a - b);
    const canonicalDraftId = group.source_simple_ids[0];
    const canonicalEntry = group.variations.find((v) => v.draft.id === canonicalDraftId) || group.variations[0];
    group.canonical_simple_id = canonicalDraftId;
    group.canonical_parsed = canonicalEntry.parsed;
    group.canonical_draft = canonicalEntry.draft;

    // Descrizione finale: canonical se >=200 char, altrimenti la più lunga
    let chosenDescription = '';
    if (group.descriptions.length > 0) {
      const canonDesc = group.descriptions.find((d) => d.id === canonicalDraftId);
      if (canonDesc && canonDesc.len >= 200) {
        chosenDescription = canonDesc.html;
      } else {
        const longest = [...group.descriptions].sort((a, b) => b.len - a.len)[0];
        chosenDescription = longest.html;
        if (canonDesc && canonDesc.len !== longest.len) {
          conflicts.push({
            type: 'description_swap',
            canonical_key: group.canonical_key,
            canonical_id: canonicalDraftId,
            chosen_id: longest.id,
            reason: 'canonical too short or empty',
          });
        }
      }
    }
    group.chosen_description = chosenDescription;

    let chosenShort = '';
    if (group.short_descriptions.length > 0) {
      const canonShort = group.short_descriptions.find((d) => d.id === canonicalDraftId);
      const longest = [...group.short_descriptions].sort((a, b) => b.len - a.len)[0];
      chosenShort = canonShort && canonShort.len >= 80 ? canonShort.html : longest.html;
    }
    group.chosen_short_description = chosenShort;

    // === Categorie del parent ===
    // Union già raccolta in categories_union_by_id, ma facciamo split tipo/genere.
    // Escludiamo "Senza categoria" / "uncategorized" — non sono categorie tipo valide.
    const EXCLUDED_TYPE_SLUGS = new Set(['uncategorized', 'senza-categoria', 'senza-categoria-1', 'senza-categoria-2']);
    const allCatsRaw = group.categories_union_by_id;
    const allCats = allCatsRaw.filter((c) => !EXCLUDED_TYPE_SLUGS.has(c.slug) && normalizeText(c.name) !== 'senza categoria');
    const genderCatSlugs = new Set(
      [state.genderCats.maschio?.slug, state.genderCats.femmina?.slug, state.genderCats.unisex?.slug]
        .filter(Boolean)
    );
    const typeCats = allCats.filter((c) => !genderCatSlugs.has(c.slug));
    const genderCats = allCats.filter((c) => genderCatSlugs.has(c.slug));

    // Se manca categoria tipo → inferenza aggressiva (PRODUCT_KIND_RULES, fallback Abbigliamento)
    if (typeCats.length === 0) {
      const candidateSlugs = inferTypeCategorySlugs(group.canonical_parsed);
      const inferred = findCategoryByCandidateSlugs(state.categoriesBySlug, candidateSlugs);
      if (inferred) {
        typeCats.push(inferred);
        conflicts.push({
          type: 'inferred_type_category',
          canonical_key: group.canonical_key,
          modello: group.modello,
          inferred_slug: inferred.slug,
          confidence: 'kind_rule_match',
        });
      } else {
        const fallback = state.categoriesBySlug.get('abbigliamento');
        if (fallback) {
          typeCats.push(fallback);
          conflicts.push({
            type: 'inferred_type_category_fallback',
            canonical_key: group.canonical_key,
            modello: group.modello,
            inferred_slug: 'abbigliamento',
            confidence: 'fallback',
          });
        } else {
          conflicts.push({
            type: 'missing_type_category_no_fallback',
            canonical_key: group.canonical_key,
            modello: group.modello,
          });
        }
      }
    }

    // Se manca categoria genere → inferenza aggressiva (fallback Unisex)
    if (genderCats.length === 0) {
      const guessed = inferGenderFromName(group.canonical_parsed);
      const cat = state.genderCats[guessed];
      if (cat) {
        genderCats.push(cat);
        conflicts.push({
          type: 'inferred_gender_category',
          canonical_key: group.canonical_key,
          modello: group.modello,
          inferred: guessed,
          confidence: guessed === 'unisex' ? 'fallback_default' : 'rule_match',
        });
      } else {
        conflicts.push({
          type: 'missing_gender_category_no_fallback',
          canonical_key: group.canonical_key,
          modello: group.modello,
          guessed,
        });
      }
    } else if (genderCats.length > 1) {
      // Conflitto: multi-genere. Manteniamo come union, segnaliamo.
      conflicts.push({
        type: 'multiple_gender_categories',
        canonical_key: group.canonical_key,
        modello: group.modello,
        genders: genderCats.map((c) => c.slug),
      });
    }

    group.final_categories = [...typeCats, ...genderCats].map((c) => ({ id: c.id, slug: c.slug, name: c.name }));

    // === Attributi parent ===
    // Includiamo "Colore" come variation solo se TUTTE le varianti hanno un colore.
    // Includiamo "Età" come variation solo se TUTTE le varianti hanno un'età.
    // Se entrambi mancano (es. prodotto standalone storico), il gruppo NON va consolidato.
    const colorOptions = new Set();
    const sizeOptions = new Set();
    let allHaveColor = true;
    let allHaveSize = true;
    for (const v of group.variations) {
      if (v.parsed.colore_label) colorOptions.add(v.parsed.colore_label);
      else allHaveColor = false;
      if (v.parsed.eta) sizeOptions.add(v.parsed.eta);
      else allHaveSize = false;
    }
    group.attribute_colore_options = allHaveColor ? [...colorOptions] : [];
    group.attribute_eta_options = allHaveSize ? [...sizeOptions] : [];
    group.has_colore_variation = allHaveColor && colorOptions.size > 0;
    group.has_eta_variation = allHaveSize && sizeOptions.size > 0;

    // Se nessun attributo è variation E c'è 1 sola variante → non consolidare (è già un simple standalone)
    if (!group.has_colore_variation && !group.has_eta_variation && group.variations.length === 1) {
      conflicts.push({
        type: 'skipped_standalone_no_attributes',
        canonical_key: group.canonical_key,
        modello: group.modello,
        draft_id: group.variations[0].draft.id,
        reason: '1 variante senza colore né età — resta simple in draft',
      });
      continue;
    }

    groupList.push(group);
  }

  // Sort gruppi per nome modello
  groupList.sort((a, b) => a.modello.localeCompare(b.modello));

  console.log(`  ✓ ${groupList.length} gruppi proposti`);
  console.log(`  ✓ ${manualReview.length} draft in needs_manual_review`);
  console.log(`  ✓ ${conflicts.length} conflitti/note totali`);

  return { groups: groupList, manualReview, conflicts };
}

// ============================================================
// PHASE 1 — OUTPUT REPORTS
// ============================================================

async function writeReports(outputDir, state, groups, conflicts, manualReview, args) {
  // groups.json — payload pronto per apply
  const groupsPayload = groups.map((g) => ({
    canonical_key: g.canonical_key,
    parent_name: g.modello,
    is_campionatura: g.is_campionatura,
    variation_count: g.variations.length,
    source_simple_ids: g.source_simple_ids,
    duplicate_simple_ids: g.duplicate_simple_ids,
    canonical_simple_id: g.canonical_simple_id,
    final_categories: g.final_categories,
    images: g.images_union_by_id.map((i) => ({ id: i.id, src: i.src, alt: i.alt, name: i.name })),
    tags: g.tags_union_by_id.map((t) => ({ id: t.id, slug: t.slug, name: t.name })),
    description_chosen_len: (g.chosen_description || '').length,
    short_description_chosen_len: (g.chosen_short_description || '').length,
    attribute_colore_options: g.attribute_colore_options,
    attribute_eta_options: g.attribute_eta_options,
    variations: g.variations.map((v) => ({
      source_id: v.draft.id,
      sku: v.draft.sku,
      regular_price: v.draft.regular_price,
      sale_price: v.draft.sale_price,
      weight: v.draft.weight,
      dimensions: v.draft.dimensions,
      stock_status: v.draft.stock_status,
      stock_quantity: v.draft.stock_quantity,
      manage_stock: v.draft.manage_stock,
      colore_label: v.parsed.colore_label,
      eta: v.parsed.eta,
      location: v.parsed.location,
      anno: v.parsed.anno,
      season: v.parsed.season || '',
      is_campionatura: !!v.parsed.is_campionatura,
      original_sku: v.parsed.original_sku || '',
      tessuto: v.parsed.tessuto || '',
      raw_name: v.parsed.raw_name,
    })),
  }));
  await fs.writeFile(path.join(outputDir, 'groups.json'), JSON.stringify(groupsPayload, null, 2), 'utf8');

  // manual-review.json
  await fs.writeFile(
    path.join(outputDir, 'manual-review.json'),
    JSON.stringify(manualReview, null, 2),
    'utf8'
  );

  // ===== report.md =====
  const lines = [];
  lines.push('# Farway — Consolidamento bozze: dry-run report');
  lines.push('');
  lines.push(`Generato: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Sintesi');
  lines.push('');
  const totalSourceSimples = groups.reduce((s, g) => s + g.source_simple_ids.length, 0);
  const totalDuplicates = groups.reduce((s, g) => s + g.duplicate_simple_ids.length, 0);
  const totalToTrash = totalSourceSimples + totalDuplicates;
  const totalAlreadyConsolidated = conflicts.filter((c) => c.type === 'already_consolidated').length;
  const totalSkippedStandalone = conflicts.filter((c) => c.type === 'skipped_standalone_no_attributes').length;
  const totalSkippedCodeModel = conflicts.filter((c) => c.type === 'skipped_code_model').length;
  const finalDraftCount = groups.length + manualReview.length + totalSkippedStandalone + totalSkippedCodeModel;
  lines.push(`- Draft totali analizzati: **${state.drafts.length}**`);
  lines.push(`- Già consolidati (skip): **${totalAlreadyConsolidated}**`);
  lines.push(`- Standalone senza attributi (restano simple in draft): **${totalSkippedStandalone}**`);
  lines.push(`- Modelli codice/prototipo (restano simple in draft): **${totalSkippedCodeModel}**`);
  lines.push(`- Gruppi (parent variable) proposti: **${groups.length}**`);
  lines.push(`- Varianti totali (uniche): **${groups.reduce((s, g) => s + g.variations.length, 0)}**`);
  lines.push(`- Source simple (canonical varianti) da trashare: **${totalSourceSimples}**`);
  lines.push(`- Duplicati esatti da trashare: **${totalDuplicates}**`);
  lines.push(`- **Totale draft da trashare = ${totalToTrash}**`);
  lines.push(`- Draft `+'`needs_manual_review`'+` (restano in draft): **${manualReview.length}**`);
  lines.push(`- Conflitti/note: **${conflicts.length}**`);
  lines.push('');
  lines.push('### Conteggio bozze post-apply');
  lines.push('');
  lines.push(`- Prima: ${state.drafts.length} draft`);
  lines.push(`- Dopo: **${groups.length} parent variable + ${totalSkippedStandalone + totalSkippedCodeModel} simple residui + ${manualReview.length} `+'`needs_manual_review`'+`** = ${finalDraftCount} totale draft`);
  lines.push(`- Riduzione: **${state.drafts.length - finalDraftCount} draft in meno** (-${Math.round((1 - finalDraftCount / state.drafts.length) * 100)}%)`);
  lines.push('');
  lines.push('## Gruppi proposti');
  lines.push('');
  lines.push('| Modello (parent) | Camp | # var. | Colori | Età | Categorie | Source IDs |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const g of groups) {
    const colors = g.attribute_colore_options.join(', ');
    const sizes = g.attribute_eta_options.join(', ');
    const cats = g.final_categories.map((c) => c.name).join(', ');
    const ids = g.source_simple_ids.length <= 6
      ? g.source_simple_ids.join(', ')
      : `${g.source_simple_ids.slice(0, 5).join(', ')}, … (+${g.source_simple_ids.length - 5})`;
    lines.push(`| ${escapeMd(g.modello)} | ${g.is_campionatura ? 'sì' : ''} | ${g.variations.length} | ${escapeMd(colors)} | ${escapeMd(sizes)} | ${escapeMd(cats)} | ${ids} |`);
  }
  lines.push('');

  // Distribuzioni
  lines.push('## Distribuzione');
  lines.push('');
  const locDist = new Map();
  const yearDist = new Map();
  const campCount = { si: 0, no: 0 };
  for (const g of groups) {
    if (g.is_campionatura) campCount.si += g.variations.length; else campCount.no += g.variations.length;
    for (const v of g.variations) {
      locDist.set(v.parsed.location || 'Milano', (locDist.get(v.parsed.location || 'Milano') || 0) + 1);
      yearDist.set(v.parsed.anno || 'n/d', (yearDist.get(v.parsed.anno || 'n/d') || 0) + 1);
    }
  }
  lines.push('### Per magazzino');
  lines.push('');
  lines.push('| Location | Varianti |');
  lines.push('|---|---|');
  for (const [k, v] of [...locDist].sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  lines.push('### Per anno');
  lines.push('');
  lines.push('| Anno | Varianti |');
  lines.push('|---|---|');
  for (const [k, v] of [...yearDist].sort((a, b) => String(b[0]).localeCompare(String(a[0])))) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  lines.push('### Campionatura');
  lines.push('');
  lines.push(`- Varianti campionatura: ${campCount.si}`);
  lines.push(`- Varianti PF: ${campCount.no}`);
  lines.push('');

  // Needs manual review
  lines.push('## Draft `needs_manual_review`');
  lines.push('');
  if (manualReview.length === 0) {
    lines.push('_Nessun draft non parsabile._');
  } else {
    lines.push('| ID | Nome | Note |');
    lines.push('|---|---|---|');
    for (const m of manualReview) {
      lines.push(`| ${m.draft_id} | ${escapeMd(m.name)} | ${escapeMd((m.notes || []).join(', '))} |`);
    }
  }
  lines.push('');

  await fs.writeFile(path.join(outputDir, 'report.md'), lines.join('\n'), 'utf8');

  // ===== conflicts.md =====
  const cf = [];
  cf.push('# Farway — Consolidamento bozze: conflitti e note');
  cf.push('');
  cf.push(`Totale: ${conflicts.length}`);
  cf.push('');
  const byType = new Map();
  for (const c of conflicts) {
    if (!byType.has(c.type)) byType.set(c.type, []);
    byType.get(c.type).push(c);
  }
  for (const [type, items] of [...byType].sort((a, b) => b[1].length - a[1].length)) {
    cf.push(`## \`${type}\` (${items.length})`);
    cf.push('');
    cf.push('```json');
    cf.push(JSON.stringify(items, null, 2));
    cf.push('```');
    cf.push('');
  }
  await fs.writeFile(path.join(outputDir, 'conflicts.md'), cf.join('\n'), 'utf8');

  // ===== attributes-mapping.md =====
  const am = [];
  am.push('# Farway — Mapping attributi globali');
  am.push('');
  am.push(`Attributo Colore: \`${state.attrColore?.slug || 'NON TROVATO'}\` (id ${state.attrColore?.id || '?'})`);
  am.push(`Attributo Età/Taglia: \`${state.attrEta?.slug || 'NON TROVATO'}\` (id ${state.attrEta?.id || '?'})`);
  am.push('');
  am.push('## Termini Colore richiesti dai gruppi');
  am.push('');
  const allColors = new Set();
  for (const g of groups) for (const c of g.attribute_colore_options) allColors.add(c);
  const existingColorNames = new Set((state.attributeTerms[state.attrColore?.id] || []).map((t) => t.name));
  am.push('| Termine richiesto | Esiste in WC? |');
  am.push('|---|---|');
  for (const c of [...allColors].sort()) {
    am.push(`| ${escapeMd(c)} | ${existingColorNames.has(c) ? '✓' : 'da creare'} |`);
  }
  am.push('');
  am.push('## Termini Età/Taglia richiesti dai gruppi');
  am.push('');
  const allSizes = new Set();
  for (const g of groups) for (const s of g.attribute_eta_options) allSizes.add(s);
  const existingSizeNames = new Set((state.attributeTerms[state.attrEta?.id] || []).map((t) => t.name));
  am.push('| Termine richiesto | Esiste in WC? |');
  am.push('|---|---|');
  for (const s of [...allSizes].sort()) {
    am.push(`| ${escapeMd(s)} | ${existingSizeNames.has(s) ? '✓' : 'da creare'} |`);
  }
  am.push('');
  await fs.writeFile(path.join(outputDir, 'attributes-mapping.md'), am.join('\n'), 'utf8');

  // ===== categories-mapping.md =====
  const cm = [];
  cm.push('# Farway — Mapping categorie WC sui parent');
  cm.push('');
  cm.push('## Per gruppo: categorie tipo + genere applicate (union sorgente o inferite)');
  cm.push('');
  cm.push('| Modello | Categorie applicate | Source / inferenza |');
  cm.push('|---|---|---|');
  for (const g of groups) {
    const conflictsForGroup = conflicts.filter((c) =>
      ['inferred_type_category', 'inferred_type_category_fallback', 'inferred_gender_category',
       'missing_type_category_no_fallback', 'missing_gender_category_no_fallback', 'multiple_gender_categories']
        .includes(c.type) && c.canonical_key === g.canonical_key
    );
    const notes = conflictsForGroup.map((c) => `${c.type}:${c.inferred_slug || c.inferred || c.guessed || ''}`).join('; ');
    cm.push(`| ${escapeMd(g.modello)} | ${escapeMd(g.final_categories.map((c) => c.name).join(', '))} | ${escapeMd(notes || 'source')} |`);
  }
  cm.push('');
  await fs.writeFile(path.join(outputDir, 'categories-mapping.md'), cm.join('\n'), 'utf8');

  // ===== actions.json (alias di groups.json per compat plan) =====
  // Già scritto come groups.json; lasciamo come riferimento
  console.log(`[phase 1] report scritti:`);
  console.log(`  - ${path.join(outputDir, 'report.md')}`);
  console.log(`  - ${path.join(outputDir, 'conflicts.md')}`);
  console.log(`  - ${path.join(outputDir, 'attributes-mapping.md')}`);
  console.log(`  - ${path.join(outputDir, 'categories-mapping.md')}`);
  console.log(`  - ${path.join(outputDir, 'groups.json')}`);
  console.log(`  - ${path.join(outputDir, 'manual-review.json')}`);
}

function escapeMd(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ============================================================
// PHASE 2 — APPLY
// ============================================================

async function ensureAttributeTerm(settings, attrId, name, existingTerms, createdCache) {
  const slug = slugify(name);
  if (existingTerms.has(name) || existingTerms.has(slug)) return;
  if (createdCache.has(slug)) return;
  // Crea termine
  try {
    await wooRequest(settings, 'POST', `products/attributes/${attrId}/terms`, { name, slug });
    createdCache.add(slug);
    console.log(`    ✓ termine creato (attr ${attrId}): ${name}`);
    await sleep(WC_WRITE_DELAY_MS);
  } catch (err) {
    // Se "term exists" 400/409, ignora
    if (/exists|already/i.test(err.message)) {
      createdCache.add(slug);
    } else {
      throw err;
    }
  }
}

async function activateAcfSnippet(scriptDir) {
  console.log('[acf] deploy + attivazione snippet ACF "Farway ERP – Dati interni"...');
  const snippetPath = path.join(scriptDir, '..', '..', 'wordpress-site', 'snippets', 'farway-erp-acf-fields-snippet.php');
  let code;
  try {
    code = await fs.readFile(snippetPath, 'utf8');
  } catch {
    throw new Error(`Snippet ACF non trovato: ${snippetPath}`);
  }
  // WP Code Snippets aggiunge <?php automaticamente
  const cleanCode = code.replace(/^\s*<\?php\s*/, '').trim();

  const wpUser = String(process.env.WP_USERNAME || '').trim();
  const wpPwd = String(process.env.WP_APP_PASSWORD || '').trim();
  const storeUrl = String(process.env.WC_STORE_URL || '').trim().replace(/\/$/, '');
  if (!wpUser || !wpPwd) {
    throw new Error('Credenziali WP REST mancanti (WP_USERNAME / WP_APP_PASSWORD).');
  }

  const auth = 'Basic ' + Buffer.from(`${wpUser}:${wpPwd}`).toString('base64');
  const baseHeaders = { Authorization: auth, 'Content-Type': 'application/json' };

  // Cerca snippet esistente per nome
  const listRes = await fetchWithTimeout(`${storeUrl}/wp-json/code-snippets/v1/snippets`, {
    headers: baseHeaders,
  });
  if (!listRes.ok) {
    throw new Error(`WP Code Snippets list HTTP ${listRes.status}`);
  }
  const all = await listRes.json();
  // Match per group key nel codice (robusto a rename del snippet) o per pattern nel nome.
  const existing = (Array.isArray(all) ? all : []).find((s) => {
    const name = s.name || '';
    const code = s.code || '';
    if (/group_farway_erp_internal_product_fields/.test(code)) return true;
    return /Farway ERP/i.test(name) && /ACF/i.test(name);
  });

  const snippetName = 'FW | ERP | ACF Dati interni prodotti';
  const payload = {
    name: snippetName,
    code: cleanCode,
    scope: 'global',
    active: true,
    priority: 20,
    description: 'Registra il gruppo ACF "Farway ERP - Dati interni" con i field fw_erp_*.',
  };

  if (existing) {
    console.log(`  - snippet trovato (id ${existing.id}, active=${existing.active}), update + attiva`);
    const upd = await fetchWithTimeout(`${storeUrl}/wp-json/code-snippets/v1/snippets/${existing.id}`, {
      method: 'PUT',
      headers: baseHeaders,
      body: JSON.stringify(payload),
    });
    if (!upd.ok) throw new Error(`WP Code Snippets PUT HTTP ${upd.status}: ${(await upd.text()).slice(0, 300)}`);
    console.log(`  ✓ snippet ACF aggiornato e attivo (id ${existing.id})`);
  } else {
    console.log('  - snippet non trovato, creazione');
    const cr = await fetchWithTimeout(`${storeUrl}/wp-json/code-snippets/v1/snippets`, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify(payload),
    });
    if (!cr.ok) throw new Error(`WP Code Snippets POST HTTP ${cr.status}: ${(await cr.text()).slice(0, 300)}`);
    const created = await cr.json();
    console.log(`  ✓ snippet ACF creato e attivo (id ${created.id})`);
  }
}

async function applyConsolidation(settings, outputDir, state, groups, args) {
  console.log('[phase 2] APPLY consolidamento...');

  // Pre-flight: backup esiste?
  const backupPath = path.join(outputDir, 'backup-drafts.json');
  try {
    await fs.access(backupPath);
  } catch {
    throw new Error(`Backup mancante: ${backupPath}. Annullo per sicurezza.`);
  }

  // Attiva snippet ACF se richiesto
  if (args.activateAcfSnippet) {
    await activateAcfSnippet(__dirname);
  }

  // Ensure attribute terms
  if (!state.attrColore) throw new Error('Attributo Colore non trovato — impossibile creare parent variable.');
  if (!state.attrEta) throw new Error('Attributo Età/Taglia non trovato — impossibile creare parent variable.');

  console.log('  - creo termini Colore mancanti...');
  const colorTermNames = new Set((state.attributeTerms[state.attrColore.id] || []).map((t) => t.name));
  const colorCreated = new Set();
  const allColorsNeeded = new Set();
  for (const g of groups) for (const c of g.attribute_colore_options) allColorsNeeded.add(c);
  for (const c of allColorsNeeded) await ensureAttributeTerm(settings, state.attrColore.id, c, colorTermNames, colorCreated);

  console.log('  - creo termini Età mancanti...');
  const etaTermNames = new Set((state.attributeTerms[state.attrEta.id] || []).map((t) => t.name));
  const etaCreated = new Set();
  const allEtaNeeded = new Set();
  for (const g of groups) for (const s of g.attribute_eta_options) allEtaNeeded.add(s);
  for (const s of allEtaNeeded) await ensureAttributeTerm(settings, state.attrEta.id, s, etaTermNames, etaCreated);

  // Eventuale limit-groups per test
  let groupsToProcess = groups;
  if (args.limitGroups > 0) {
    groupsToProcess = groups.slice(0, args.limitGroups);
    console.log(`  ! --limit-groups=${args.limitGroups}, processo solo i primi ${groupsToProcess.length} gruppi`);
  }

  // applied summary
  const runId = nowCompact();
  const appliedSummary = {
    run_id: runId,
    started_at: new Date().toISOString(),
    groups_total: groupsToProcess.length,
    parents_created: [],
    failures: [],
  };

  let idx = 0;
  for (const group of groupsToProcess) {
    idx += 1;
    console.log(`  [${idx}/${groupsToProcess.length}] ${group.modello} (${group.variations.length} var.) ...`);

    const appliedPath = path.join(outputDir, `applied-${slugify(group.canonical_key)}.json`);
    // Resume: se applied- esiste già, skippo
    try {
      const existing = JSON.parse(await fs.readFile(appliedPath, 'utf8'));
      if (existing && existing.parent_id) {
        console.log(`    ↺ già applicato (parent ${existing.parent_id}), skip`);
        appliedSummary.parents_created.push({ canonical_key: group.canonical_key, parent_id: existing.parent_id, resumed: true });
        continue;
      }
    } catch {
      // not applied yet
    }

    try {
      // === 1. Crea parent variable ===
      const parentName = group.modello;
      const parentPayload = {
        name: parentName,
        type: 'variable',
        status: 'draft',
        catalog_visibility: 'hidden', // restano nascosti dal catalogo finché draft
        description: group.chosen_description || '',
        short_description: group.chosen_short_description || '',
        categories: group.final_categories.map((c) => ({ id: c.id })),
        tags: group.tags_union_by_id.map((t) => ({ id: t.id })),
        images: group.images_union_by_id.map((img) => ({
          id: img.id,
          src: img.src,
          alt: img.alt,
        })),
        attributes: (() => {
          const attrs = [];
          let pos = 0;
          if (group.has_colore_variation) {
            attrs.push({
              id: state.attrColore.id,
              name: state.attrColore.name,
              position: pos++,
              visible: true,
              variation: true,
              options: group.attribute_colore_options,
            });
          }
          if (group.has_eta_variation) {
            attrs.push({
              id: state.attrEta.id,
              name: state.attrEta.name,
              position: pos++,
              visible: true,
              variation: true,
              options: group.attribute_eta_options,
            });
          }
          return attrs;
        })(),
        meta_data: (() => {
          const md = [
            { key: '_fw_consolidated_from', value: JSON.stringify(group.source_simple_ids) },
            { key: '_fw_consolidate_run_id', value: runId },
            { key: '_fw_consolidate_canonical_key', value: group.canonical_key },
            // ACF true_false richiede '1'/'0' (qualsiasi stringa non-empty è truthy in PHP)
            { key: 'fw_erp_is_campionatura', value: group.is_campionatura ? '1' : '0' },
          ];
          // Se tutte le varianti hanno lo stesso tessuto (o solo alcune), settalo sul parent
          const tessutoSet = new Set(group.variations.map((v) => v.parsed.tessuto).filter(Boolean));
          if (tessutoSet.size === 1) {
            md.push({ key: 'fw_erp_tessuto', value: [...tessutoSet][0] });
          }
          return md;
        })(),
      };

      const createdParent = await wooRequest(settings, 'POST', 'products', parentPayload);
      console.log(`    ✓ parent creato: id ${createdParent.id}`);
      await sleep(WC_WRITE_DELAY_MS);

      // === 2. Crea variazioni ===
      const createdVariations = [];
      for (const v of group.variations) {
        const variationPayload = {
          status: 'private', // restano hidden nel parent, ereditano draft via parent
          regular_price: v.draft.regular_price || '',
          sale_price: v.draft.sale_price || '',
          sku: v.draft.sku || '',
          weight: v.draft.weight || '',
          dimensions: v.draft.dimensions || {},
          stock_status: v.draft.stock_status || 'instock',
          manage_stock: v.draft.manage_stock || false,
          stock_quantity: v.draft.stock_quantity ?? null,
          attributes: (() => {
            const attrs = [];
            if (group.has_colore_variation) {
              attrs.push({ id: state.attrColore.id, option: v.parsed.colore_label });
            }
            if (group.has_eta_variation) {
              attrs.push({ id: state.attrEta.id, option: v.parsed.eta });
            }
            return attrs;
          })(),
          meta_data: (() => {
            const md = [
              { key: 'fw_erp_location', value: v.parsed.location || 'Milano' },
              { key: 'fw_erp_year', value: v.parsed.anno || '' },
              { key: 'fw_erp_season', value: v.parsed.season || '' },
              // ACF true_false: '1'/'0' (NON 'true'/'false' che PHP legge come truthy)
              { key: 'fw_erp_is_campionatura', value: v.parsed.is_campionatura ? '1' : '0' },
              { key: 'fw_erp_original_sku', value: v.parsed.original_sku || v.draft.sku || '' },
              { key: 'fw_erp_original_simple_id', value: String(v.draft.id) },
            ];
            if (v.parsed.tessuto) md.push({ key: 'fw_erp_tessuto', value: v.parsed.tessuto });
            return md;
          })(),
        };

        try {
          const createdVar = await wooRequest(settings, 'POST', `products/${createdParent.id}/variations`, variationPayload);
          createdVariations.push({ source_id: v.draft.id, variation_id: createdVar.id, sku: createdVar.sku });
          await sleep(WC_WRITE_DELAY_MS);
        } catch (varErr) {
          // Se SKU collision, retry con suffisso -V2
          if (/sku|invalid_sku_count|product_invalid_sku/i.test(varErr.message)) {
            const newSku = (v.draft.sku || '') + '-V2';
            console.log(`    ⚠ SKU collision per ${v.draft.sku}, retry con ${newSku}`);
            variationPayload.sku = newSku;
            const createdVar2 = await wooRequest(settings, 'POST', `products/${createdParent.id}/variations`, variationPayload);
            createdVariations.push({ source_id: v.draft.id, variation_id: createdVar2.id, sku: createdVar2.sku, sku_renamed: true });
            await sleep(WC_WRITE_DELAY_MS);
          } else {
            throw varErr;
          }
        }
      }
      console.log(`    ✓ ${createdVariations.length} variazioni create`);

      // === 3. Trash dei simple originali ===
      for (const sourceId of group.source_simple_ids) {
        try {
          await wooRequest(settings, 'PUT', `products/${sourceId}`, {
            status: 'trash',
            meta_data: [
              { key: '_fw_consolidated_into', value: String(createdParent.id) },
              { key: '_fw_consolidated_at', value: new Date().toISOString() },
              { key: '_fw_consolidate_run_id', value: runId },
            ],
          });
          await sleep(WC_WRITE_DELAY_MS);
        } catch (trashErr) {
          console.log(`    ⚠ trash fallito per ${sourceId}: ${trashErr.message}`);
        }
      }
      console.log(`    ✓ ${group.source_simple_ids.length} simple in trash`);

      // === 3b. Trash dei duplicati esatti ===
      for (const dup of group.duplicate_simple_ids) {
        try {
          await wooRequest(settings, 'PUT', `products/${dup.draft_id}`, {
            status: 'trash',
            meta_data: [
              { key: '_fw_consolidated_into', value: String(createdParent.id) },
              { key: '_fw_consolidated_at', value: new Date().toISOString() },
              { key: '_fw_consolidate_run_id', value: runId },
              { key: '_fw_duplicate_of', value: dup.duplicate_of ? String(dup.duplicate_of) : '' },
            ],
          });
          await sleep(WC_WRITE_DELAY_MS);
        } catch (trashErr) {
          console.log(`    ⚠ trash fallito per dup ${dup.draft_id}: ${trashErr.message}`);
        }
      }
      if (group.duplicate_simple_ids.length > 0) {
        console.log(`    ✓ ${group.duplicate_simple_ids.length} duplicati esatti in trash`);
      }

      // === 4. Snapshot applied ===
      const appliedSnapshot = {
        run_id: runId,
        canonical_key: group.canonical_key,
        parent_name: group.modello,
        parent_id: createdParent.id,
        source_simple_ids: group.source_simple_ids,
        variations_created: createdVariations,
        applied_at: new Date().toISOString(),
      };
      await fs.writeFile(appliedPath, JSON.stringify(appliedSnapshot, null, 2), 'utf8');
      appliedSummary.parents_created.push({ canonical_key: group.canonical_key, parent_id: createdParent.id, variations_count: createdVariations.length });
    } catch (groupErr) {
      console.error(`    ✗ FALLITO ${group.modello}: ${groupErr.message}`);
      appliedSummary.failures.push({ canonical_key: group.canonical_key, modello: group.modello, error: groupErr.message });
    }
  }

  appliedSummary.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(outputDir, 'applied-summary.json'), JSON.stringify(appliedSummary, null, 2), 'utf8');
  console.log(`[phase 2] completata: ${appliedSummary.parents_created.length} parent creati, ${appliedSummary.failures.length} falliti`);
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const scriptDir = __dirname;
  const args = parseArgs(process.argv.slice(2));

  console.log('========================================');
  console.log(' Farway — Consolidamento bozze');
  console.log(`  Modalità: ${args.apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log('========================================');

  if (args.apply && args.confirm !== APPLY_CONFIRMATION) {
    throw new Error(`Apply richiede --confirm ${APPLY_CONFIRMATION}`);
  }

  const settings = await resolveWooSettings(scriptDir);
  console.log(`[setup] store: ${settings.storeUrl}`);

  // Output dir
  const baseDataDir = path.join(scriptDir, '..', 'data');
  let outputDir = args.outputDir;
  if (args.reuseDir) outputDir = args.reuseDir;
  if (!outputDir) outputDir = path.join(baseDataDir, `farway-draft-consolidate-${nowCompact()}`);
  await fs.mkdir(outputDir, { recursive: true });
  console.log(`[setup] output dir: ${outputDir}`);

  // Phase 0: Discovery (sempre, sia in dry-run sia in apply)
  // In apply riusato output (--reuse-dir), salta la discovery e legge da backup-drafts.json + groups.json
  let state;
  let groups;
  let manualReview;
  let conflicts;

  if (args.reuseDir) {
    console.log('[phase 0] riuso output esistente, leggo da backup...');
    const draftsBackup = JSON.parse(await fs.readFile(path.join(outputDir, 'backup-drafts.json'), 'utf8'));
    const attrBackup = JSON.parse(await fs.readFile(path.join(outputDir, 'backup-attributes.json'), 'utf8'));
    const catBackup = JSON.parse(await fs.readFile(path.join(outputDir, 'backup-categories.json'), 'utf8'));
    state = {
      drafts: draftsBackup,
      attributes: attrBackup.attributes,
      attributeTerms: attrBackup.terms,
      attrColore: attrBackup.attributes.find((a) => /color/i.test(a.slug) || /color/i.test(a.name)),
      attrEta: attrBackup.attributes.find((a) => /taglia|eta|et[àa]/i.test(a.slug) || /taglia|et[àa]/i.test(a.name)),
      categories: catBackup,
      categoriesBySlug: new Map(catBackup.map((c) => [c.slug, c])),
      categoriesByNameNorm: new Map(catBackup.map((c) => [normalizeText(c.name), c])),
      genderCats: {
        maschio: catBackup.find((c) => normalizeText(c.name) === 'maschio' || c.slug === 'maschio'),
        femmina: catBackup.find((c) => normalizeText(c.name) === 'femmina' || c.slug === 'femmina'),
        unisex: catBackup.find((c) => normalizeText(c.name) === 'unisex' || c.slug === 'unisex'),
      },
      referencePublished: [],
    };
    ({ groups, manualReview, conflicts } = await parseAndGroup(state));
  } else {
    state = await discoverWooState(settings, outputDir, args);
    ({ groups, manualReview, conflicts } = await parseAndGroup(state));
    await writeReports(outputDir, state, groups, conflicts, manualReview, args);
  }

  if (!args.apply) {
    console.log('');
    console.log('==========================================');
    console.log(`[ok] DRY-RUN completato.`);
    console.log(`     Rileggi: ${path.join(outputDir, 'report.md')}`);
    console.log(`     Per applicare:`);
    console.log(`       node scripts/farway-draft-consolidate.cjs --apply --confirm ${APPLY_CONFIRMATION} --reuse-dir "${outputDir}"`);
    console.log('==========================================');
    return;
  }

  // Phase 2: apply
  await applyConsolidation(settings, outputDir, state, groups, args);
  console.log('');
  console.log('==========================================');
  console.log('[ok] APPLY completato.');
  console.log(`     Riepilogo: ${path.join(outputDir, 'applied-summary.json')}`);
  console.log('==========================================');
}

main().catch((err) => {
  console.error('');
  console.error('[ERRORE FATALE]', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
