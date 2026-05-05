#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');

const readExcelFileModule = require('read-excel-file/node');
const readExcelFile = readExcelFileModule.default || readExcelFileModule;

const DEFAULT_EXCEL_PATH = 'C:\\Users\\fabri\\Downloads\\Magazzino Farway 31.12.24.xlsx';
const APPLY_CONFIRMATION = 'FARWAY_ERP_IMPORT_APPROVED';
const DEFAULT_LEGEND_PACK_PATH = path.join('data', 'farway-erp-legends-approved-pack.json');

const ERP_FIELDS = [
  { name: 'fw_erp_season', key: 'field_fw_erp_season' },
  { name: 'fw_erp_year', key: 'field_fw_erp_year' },
  { name: 'fw_erp_is_campionatura', key: 'field_fw_erp_is_campionatura' },
  { name: 'fw_erp_location', key: 'field_fw_erp_location' },
  { name: 'fw_erp_original_sku', key: 'field_fw_erp_original_sku' },
  { name: 'fw_erp_unit_cost_sartoria', key: 'field_fw_erp_unit_cost_sartoria' },
  { name: 'fw_erp_unit_cost_tessuto', key: 'field_fw_erp_unit_cost_tessuto' },
  { name: 'fw_erp_unit_cost_fodera', key: 'field_fw_erp_unit_cost_fodera' },
  { name: 'fw_erp_unit_cost_accessori', key: 'field_fw_erp_unit_cost_accessori' },
  { name: 'fw_erp_unit_cost_etichetta_logo', key: 'field_fw_erp_unit_cost_etichetta_logo' },
];

const SIZE_MAP = new Map([
  ['os', 'OS'],
  ['one size', 'OS'],
  ['unica', 'OS'],
  ['3 m', '3-6 mesi'],
  ['3m', '3-6 mesi'],
  ['3 mesi', '3-6 mesi'],
  ['6 m', '3-6 mesi'],
  ['6m', '3-6 mesi'],
  ['6 mesi', '3-6 mesi'],
  ['9 m', '1 anno'],
  ['9m', '1 anno'],
  ['9 mesi', '1 anno'],
  ['12 m', '1 anno'],
  ['12m', '1 anno'],
  ['12 mesi', '1 anno'],
  ['18 m', '2 anni'],
  ['18m', '2 anni'],
  ['18 mesi', '2 anni'],
  ['24 m', '2 anni'],
  ['24m', '2 anni'],
  ['24 mesi', '2 anni'],
  ['1 y', '1 anno'],
  ['1y', '1 anno'],
  ['1 anno', '1 anno'],
  ['2 y', '2 anni'],
  ['2y', '2 anni'],
  ['2 anni', '2 anni'],
  ['3 y', '3-4 anni'],
  ['3y', '3-4 anni'],
  ['3 anni', '3-4 anni'],
  ['4 y', '3-4 anni'],
  ['4y', '3-4 anni'],
  ['4 anni', '3-4 anni'],
  ['5 y', '5-6 anni'],
  ['5y', '5-6 anni'],
  ['5 anni', '5-6 anni'],
  ['6 y', '5-6 anni'],
  ['6y', '5-6 anni'],
  ['6 anni', '5-6 anni'],
  ['7 y', '7-8 anni'],
  ['7y', '7-8 anni'],
  ['7 anni', '7-8 anni'],
  ['8 y', '7-8 anni'],
  ['8y', '7-8 anni'],
  ['8 anni', '7-8 anni'],
  ['9 y', '9-10 anni'],
  ['9y', '9-10 anni'],
  ['9 anni', '9-10 anni'],
  ['10 y', '9-10 anni'],
  ['10y', '9-10 anni'],
  ['10 anni', '9-10 anni'],
]);

const COLOR_RULES = [
  { label: 'Giallo e ocra', slug: 'giallo-e-ocra', regex: /\b(giallo|yellow|chardonnay|chandonney|cedro|cdr|sudan|ocra|cream)\b/ },
  { label: 'Rosso e ciliegia', slug: 'rosso-e-ciliegia', regex: /\b(rosso|red|tango|amb|ciliegia|cherry)\b/ },
  { label: 'Azzurro polvere e denim', slug: 'azzurro-polvere-e-denim', regex: /\b(denim|azzurro|polvere|jeans)\b/ },
  { label: 'Verde bosco e scuri', slug: 'verde-bosco-e-scuri', regex: /\b(verde|green|cedar|sea green|mint|kaki|khaki|bosco)\b/ },
  { label: 'Rosa cipria e nude', slug: 'rosa-cipria-e-nude', regex: /\b(rosa|rose|pink|nude|cipria|sogno|renai|petunia|prugna)\b/ },
  { label: 'Panna e avorio', slug: 'panna-e-avorio', regex: /\b(panna|avorio|ivory|ecru|natur|natural|weiss|white)\b/ },
  { label: 'Fantasie animali', slug: 'fantasie-animali', regex: /\b(animali|gatti|cat|fantasia|flowers|floreale|tejido|mtd|sre|stampa|allover)\b/ },
  { label: 'Blu e azzurro intenso', slug: 'blu-e-azzurro-intenso', regex: /\b(blu|blue|bluette|bonnet)\b/ },
  { label: 'Marrone e mocha', slug: 'marrone-e-mocha', regex: /\b(marrone|brown|mocha)\b/ },
  { label: 'Lilla e lavanda', slug: 'lilla-e-lavanda', regex: /\b(lilla|lavanda|lavender|glicine|lil)\b/ },
];

const PRODUCT_KIND_RULES = [
  { kind: 'abito', regex: /\b(ab|abito|vestito|natalizio)\b/ },
  { kind: 'pantalone', regex: /\b(pan|pt|pantalone|pantaloncino|shorts)\b/ },
  { kind: 'camicia', regex: /\b(cam|cm|mca|camicia|blusa|coreana)\b/ },
  { kind: 'gonna', regex: /\b(gn|gonna)\b/ },
  { kind: 't-shirt', regex: /\b(ts|tsh|t-shirt|tshirt|maglietta)\b/ },
  { kind: 'felpa', regex: /\b(fel|felpa)\b/ },
  { kind: 'borsa', regex: /\b(bag|borsa|borse|raffia|yes)\b/ },
  { kind: 'scrunchies', regex: /\b(scrunch|elastico capelli|hair ties)\b/ },
  { kind: 'fiocco', regex: /\b(fiocco|bow|mollette|clip)\b/ },
  { kind: 'cerchietto', regex: /\b(cerchietto)\b/ },
];

let legendMaps = {
  loaded: false,
  color: new Map(),
  size: new Map(),
  pendingSize: new Set(),
  currentColors: new Map(),
  currentSizes: new Map(),
};

function parseArgs(argv) {
  const args = {
    excelPath: DEFAULT_EXCEL_PATH,
    outputDir: '',
    apply: false,
    applyCreateMissing: false,
    confirmApply: '',
    offlineWooJson: '',
    legendPackPath: DEFAULT_LEGEND_PACK_PATH,
    limitProducts: 0,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || '');

    if (value === '--excel') {
      args.excelPath = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }

    if (value === '--output-dir') {
      args.outputDir = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }

    if (value === '--offline-woo-json') {
      args.offlineWooJson = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }

    if (value === '--legend-pack') {
      args.legendPackPath = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }

    if (value === '--limit-products') {
      const parsed = Number(argv[index + 1] || 0);
      if (Number.isFinite(parsed) && parsed > 0) args.limitProducts = Math.round(parsed);
      index += 1;
      continue;
    }

    if (value === '--apply') {
      args.apply = true;
      continue;
    }

    if (value === '--apply-create-missing') {
      args.applyCreateMissing = true;
      continue;
    }

    if (value === '--confirm-apply') {
      args.confirmApply = String(argv[index + 1] || '').trim();
      index += 1;
    }
  }

  return args;
}

function nowCompact() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function loadEnvFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex <= 0) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      if (!key || process.env[key]) continue;
      let envValue = trimmed.slice(separatorIndex + 1).trim();
      if (
        (envValue.startsWith('"') && envValue.endsWith('"')) ||
        (envValue.startsWith("'") && envValue.endsWith("'"))
      ) {
        envValue = envValue.slice(1, -1);
      }
      process.env[key] = envValue;
    }
  } catch {
    // Optional local env file.
  }
}

async function resolveWooSettings() {
  await loadEnvFile(path.join(process.cwd(), '.env.local'));

  const settingsPath = path.join(process.cwd(), 'data', 'woocommerce-settings.json');
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.storeUrl && parsed.consumerKey && parsed.consumerSecret) {
      return {
        storeUrl: String(parsed.storeUrl).replace(/\/$/, ''),
        consumerKey: String(parsed.consumerKey),
        consumerSecret: String(parsed.consumerSecret),
      };
    }
  } catch {
    // Fallback to env.
  }

  const storeUrl = String(process.env.WC_STORE_URL || '').trim().replace(/\/$/, '');
  const consumerKey = String(process.env.WC_CONSUMER_KEY || '').trim();
  const consumerSecret = String(process.env.WC_CONSUMER_SECRET || '').trim();

  if (!storeUrl || !consumerKey || !consumerSecret) {
    throw new Error('Credenziali WooCommerce mancanti: configura .env.local oppure data/woocommerce-settings.json.');
  }

  return { storeUrl, consumerKey, consumerSecret };
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildWooUrl(settings, endpointPath) {
  const authQuery = `consumer_key=${encodeURIComponent(settings.consumerKey)}&consumer_secret=${encodeURIComponent(
    settings.consumerSecret
  )}`;
  const separator = endpointPath.includes('?') ? '&' : '?';
  return `${settings.storeUrl}/wp-json/wc/v3/${endpointPath}${separator}${authQuery}`;
}

async function wooRequest(settings, method, endpointPath, body) {
  const response = await fetchWithTimeout(buildWooUrl(settings, endpointPath), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`Woo API ${method} ${endpointPath} -> ${response.status}: ${String(text).slice(0, 300)}`);
  }

  return data;
}

async function wooFetchAll(settings, endpointPath) {
  const rows = [];
  let page = 1;

  while (true) {
    const separator = endpointPath.includes('?') ? '&' : '?';
    const batch = await wooRequest(settings, 'GET', `${endpointPath}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) {
      throw new Error(`Risposta Woo inattesa per ${endpointPath}`);
    }
    rows.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }

  return rows;
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLegendKey(value) {
  return normalizeText(value);
}

function addLegendDestination(map, value) {
  const label = String(value || '').trim();
  if (!label) return;
  map.set(normalizeLegendKey(label), label);
}

async function loadLegendMaps(legendPackPath) {
  const resolvedPath = path.isAbsolute(legendPackPath)
    ? legendPackPath
    : path.join(process.cwd(), legendPackPath);

  try {
    const pack = JSON.parse(await fs.readFile(resolvedPath, 'utf8'));
    const rows = pack.rows || {};
    const colorRows = Array.isArray(rows.color) ? rows.color : [];
    const sizeRows = Array.isArray(rows.size) ? rows.size : [];
    const color = new Map();
    const size = new Map();
    const pendingSize = new Set();
    const currentColors = new Map();
    const currentSizes = new Map();

    for (const value of pack.destinations?.color || []) addLegendDestination(currentColors, value);
    for (const value of pack.destinations?.size || []) addLegendDestination(currentSizes, value);

    for (const row of colorRows) {
      const sourceValue = String(row.sourceValue || '').trim();
      const selectedValue = String(row.selectedValue || '').trim();
      if (sourceValue && selectedValue && row.status === 'approved') {
        color.set(normalizeLegendKey(sourceValue), selectedValue);
      }
    }

    for (const row of sizeRows) {
      const sourceValue = String(row.sourceValue || '').trim();
      const selectedValue = String(row.selectedValue || '').trim();
      if (!sourceValue) continue;
      if (selectedValue && row.status === 'approved') {
        size.set(normalizeLegendKey(sourceValue), selectedValue);
      } else {
        pendingSize.add(normalizeLegendKey(sourceValue));
      }
    }

    return {
      loaded: true,
      color,
      size,
      pendingSize,
      currentColors,
      currentSizes,
    };
  } catch {
    return {
      loaded: false,
      color: new Map(),
      size: new Map(),
      pendingSize: new Set(),
      currentColors: new Map(),
      currentSizes: new Map(),
    };
  }
}

function normalizeHeader(value) {
  return normalizeText(value).replace(/\s+/g, '_');
}

function sanitizeSku(value) {
  return String(value || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
}

function slugify(value) {
  return normalizeText(value).replace(/\s+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const normalized = String(value)
    .replace(/\s/g, '')
    .replace(/[^0-9,.-]/g, '')
    .replace(/\.(?=\d{3}(?:\D|$))/g, '')
    .replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundQty(value) {
  const n = toNumber(value);
  if (n === null) return 0;
  return Math.max(0, Math.round(n));
}

function normalizeSizeDetailed(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { label: '', confidence: 'missing' };
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

  const legendKey = normalizeLegendKey(compact);
  const approvedLegend = legendMaps.size.get(legendKey);
  if (approvedLegend) {
    return {
      label: approvedLegend === 'Nessuna taglia' ? '' : approvedLegend,
      confidence: 'approved_legend',
    };
  }

  if (legendMaps.pendingSize.has(legendKey)) {
    return { label: '', confidence: 'pending_legend' };
  }

  const currentSize = legendMaps.currentSizes.get(legendKey);
  if (currentSize) {
    return {
      label: currentSize === 'Nessuna taglia' ? '' : currentSize,
      confidence: 'current_exact',
    };
  }

  if (SIZE_MAP.has(compact)) return { label: SIZE_MAP.get(compact), confidence: 'legacy_rule' };

  const yearMatch = compact.match(/^(\d{1,2})\s*y$/);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    if (year === 1) return { label: '1 anno', confidence: 'legacy_rule' };
    if (year === 2) return { label: '2 anni', confidence: 'legacy_rule' };
    if (year === 3 || year === 4) return { label: '3-4 anni', confidence: 'legacy_rule' };
    if (year === 5 || year === 6) return { label: '5-6 anni', confidence: 'legacy_rule' };
    if (year === 7 || year === 8) return { label: '7-8 anni', confidence: 'legacy_rule' };
    if (year === 9 || year === 10) return { label: '9-10 anni', confidence: 'legacy_rule' };
    if (year >= 13) return { label: '', confidence: 'unsupported_size' };
  }

  const plainNumber = compact.match(/^(\d{1,2})$/);
  if (plainNumber) {
    return normalizeSizeDetailed(`${plainNumber[1]}y`);
  }

  return { label: raw, confidence: 'source' };
}

function normalizeSize(value) {
  return normalizeSizeDetailed(value).label;
}

function normalizeColor(value) {
  const raw = String(value ?? '').trim();
  const normalized = normalizeText(raw);
  if (!normalized) return { label: '', slug: '', confidence: 'missing' };

  const approvedLegend = legendMaps.color.get(normalized);
  if (approvedLegend) {
    return { label: approvedLegend, slug: slugify(approvedLegend), confidence: 'approved_legend' };
  }

  const currentColor = legendMaps.currentColors.get(normalized);
  if (currentColor) {
    return { label: currentColor, slug: slugify(currentColor), confidence: 'current_exact' };
  }

  for (const rule of COLOR_RULES) {
    if (rule.regex.test(normalized)) {
      return { label: rule.label, slug: rule.slug, confidence: 'mapped' };
    }
  }

  return { label: raw, slug: slugify(raw), confidence: 'source' };
}

function inferProductKind(...values) {
  const text = normalizeText(values.filter(Boolean).join(' '));
  for (const rule of PRODUCT_KIND_RULES) {
    if (rule.regex.test(text)) return rule.kind;
  }
  return '';
}

function isProductSheet(sheetName) {
  const upper = sheetName.toUpperCase();
  if (!upper.includes('MAGAZZINO')) return false;
  if (upper.includes('RIEPILOGO') || upper.includes('MATERIE PRIME')) return false;
  return upper.includes('PF') || upper.includes('T-SHIRT') || upper.includes('VESTITI') || upper.includes('CAMPIONAT');
}

function inferSeasonYear(sheetName) {
  const upper = sheetName.toUpperCase();
  let season = '';
  if (/\b(SS|PE)\s*\d{2}\b/.test(upper)) season = 'SS';
  if (/\b(AI|FW)\s*\d{2}\b/.test(upper)) season = 'AI';

  const twoDigitMatch = upper.match(/\b(?:SS|PE|AI|FW)\s*(\d{2})\b/);
  const fourDigitMatch = upper.match(/\b(20\d{2})\b/);
  let year = '';
  if (twoDigitMatch) {
    year = `20${twoDigitMatch[1]}`;
  } else if (fourDigitMatch) {
    year = fourDigitMatch[1];
  }

  return { season, year };
}

function headerScore(row) {
  const known = [
    'codice',
    'cod',
    'modello',
    'modelli',
    'colore',
    'colori',
    'taglia',
    'taglie',
    'magazzino',
    'doha',
    'tisha',
    'vendut',
    'sartoria',
    'tessuto',
    'fodera',
    'accessori',
    'etichetta',
  ];
  return row.reduce((score, cell) => {
    const normalized = normalizeText(cell);
    if (!normalized) return score;
    return score + (known.some((token) => normalized.includes(token)) ? 1 : 0);
  }, 0);
}

function findHeaderRow(rows) {
  let best = { index: 0, score: -1, filled: 0 };
  const max = Math.min(rows.length, 8);
  for (let index = 0; index < max; index += 1) {
    const row = rows[index] || [];
    const score = headerScore(row);
    const filled = row.filter((cell) => String(cell ?? '').trim()).length;
    if (score > best.score || (score === best.score && filled > best.filled)) {
      best = { index, score, filled };
    }
  }
  return best.index;
}

function buildHeaderMap(headerRow) {
  const map = {
    code: -1,
    model: -1,
    description: -1,
    color: -1,
    size: -1,
    qtyStock: -1,
    doha: [],
    returned: [],
    costSartoria: -1,
    costTessuto: -1,
    costFodera: -1,
    costAccessori: -1,
    costEtichettaLogo: -1,
  };

  for (let index = 0; index < headerRow.length; index += 1) {
    const raw = String(headerRow[index] ?? '').trim();
    const header = normalizeHeader(raw);
    if (!header) continue;

    if (
      map.code === -1 &&
      (header === 'codice' ||
        header.startsWith('codice_') ||
        header.startsWith('cod_') ||
        /^cod\b/.test(normalizeText(raw))) &&
      header !== 'codice_tessuto' &&
      header !== 'cod_tessuto' &&
      !header.startsWith('cod_tessuto_')
    ) {
      map.code = index;
      continue;
    }

    if (map.model === -1 && (header === 'modello' || header === 'modelli' || header.startsWith('modello_'))) {
      map.model = index;
      continue;
    }

    if (map.description === -1 && header.includes('descrizione')) {
      map.description = index;
      continue;
    }

    if (map.color === -1 && (header === 'colore' || header === 'colori' || header.startsWith('colore_'))) {
      map.color = index;
      continue;
    }

    if (map.size === -1 && (header.includes('taglia') || header.includes('taglie'))) {
      map.size = index;
      continue;
    }

    if (map.qtyStock === -1 && header.includes('magazzino') && header.includes('quant')) {
      map.qtyStock = index;
      continue;
    }

    const hasDoha = header.includes('doha');
    const hasTisha = header.includes('tisha');
    const isReturned =
      hasTisha ||
      header.includes('conto_vendita') ||
      header.includes('c_vendita') ||
      header.includes('coccole') ||
      (hasDoha && hasTisha);

    if (hasDoha && !hasTisha) {
      map.doha.push(index);
      continue;
    }

    if (isReturned) {
      map.returned.push(index);
      continue;
    }

    if (map.costSartoria === -1 && header.includes('costo') && (header.includes('sartoria') || header.includes('lab'))) {
      map.costSartoria = index;
      continue;
    }

    if (map.costTessuto === -1 && ((header.includes('costo') && header.includes('tessuto')) || header === 'tessuto' || header.includes('costo_tes'))) {
      map.costTessuto = index;
      continue;
    }

    if (map.costFodera === -1 && header.includes('fodera')) {
      map.costFodera = index;
      continue;
    }

    if (map.costAccessori === -1 && (header.includes('accessori') || header.includes('bottoni'))) {
      map.costAccessori = index;
      continue;
    }

    if (map.costEtichettaLogo === -1 && header.includes('etichetta') && header.includes('logo')) {
      map.costEtichettaLogo = index;
    }
  }

  return map;
}

function valueAt(row, index) {
  return index >= 0 && index < row.length ? row[index] : null;
}

function sumAt(row, indices) {
  return indices.reduce((sum, index) => sum + roundQty(valueAt(row, index)), 0);
}

function hasMeaningfulSourceCode(value) {
  const normalized = sanitizeSku(value);
  return normalized.length >= 3 && /[A-Z]/.test(normalized);
}

function isLikelyDataRow(row, map) {
  const code = valueAt(row, map.code);
  const model = valueAt(row, map.model);
  const size = valueAt(row, map.size);
  const qtyStock = roundQty(valueAt(row, map.qtyStock));
  const doha = sumAt(row, map.doha);
  const returned = sumAt(row, map.returned);
  const anyCost = [
    map.costSartoria,
    map.costTessuto,
    map.costFodera,
    map.costAccessori,
    map.costEtichettaLogo,
  ].some((index) => toNumber(valueAt(row, index)) !== null);

  if (!hasMeaningfulSourceCode(code) && !String(model ?? '').trim()) return false;
  if (!String(size ?? '').trim() && qtyStock === 0 && doha === 0 && returned === 0 && !anyCost) return false;
  return true;
}

function isTishaLost(row) {
  const text = normalizeText(
    [
      row.sourceCode,
      row.sourceModel,
      row.sourceDescription,
      row.sourceColor,
      row.sourceSize,
    ].join(' ')
  );
  const model = normalizeText(row.sourceModel);
  const description = normalizeText(row.sourceDescription);
  const color = normalizeText(row.sourceColor);

  if (model === 'yes' && /\b(yellow|giallo|chardonnay|chandonney|cedro|cdr)\b/.test(text)) {
    return 'tisha_lost_yellow_yes_bag';
  }

  if (
    /\b(fiocco|fiocchi|bow|mollette|clip)\b/.test(text) &&
    (/\b(green|verde|cedar)\b/.test(text) || description.includes('verde menta') || color === 'fsk')
  ) {
    return 'tisha_lost_green_bow_with_clip';
  }

  if (
    /\b(scrunch|elastico capelli)\b/.test(text) &&
    /\b(yellow|giallo|chardonnay|chandonney|chd)\b/.test(text)
  ) {
    return 'tisha_lost_yellow_scrunchies';
  }

  if (/\b(raffia|rafia)\b/.test(text) && /\b(verde|green)\b/.test(text) && /\b(borsa|borse|capri)\b/.test(text)) {
    return 'tisha_lost_capri_green_raffia_bag';
  }

  return '';
}

function parseWorkbookRows(sheets) {
  const rows = [];
  const skippedSheets = [];

  for (const sheet of sheets) {
    if (!isProductSheet(sheet.sheet)) {
      skippedSheets.push(sheet.sheet);
      continue;
    }

    const headerIndex = findHeaderRow(sheet.data);
    const headerRow = sheet.data[headerIndex] || [];
    const map = buildHeaderMap(headerRow);
    const { season, year } = inferSeasonYear(sheet.sheet);
    const isCampionatura = /CAMPIONAT/i.test(sheet.sheet);

    for (let rowIndex = headerIndex + 1; rowIndex < sheet.data.length; rowIndex += 1) {
      const row = sheet.data[rowIndex] || [];
      if (!isLikelyDataRow(row, map)) continue;

      const sourceCode = String(valueAt(row, map.code) ?? '').trim();
      const sourceModel = String(valueAt(row, map.model) ?? '').trim();
      const sourceDescription = String(valueAt(row, map.description) ?? '').trim();
      let sourceColor = String(valueAt(row, map.color) ?? '').trim();
      if (/^\d+(\.0+)?$/.test(sourceColor) && map.color + 1 < row.length) {
        const fallbackColor = String(row[map.color + 1] ?? '').trim();
        if (fallbackColor) sourceColor = fallbackColor;
      }
      const sourceSize = String(valueAt(row, map.size) ?? '').trim();
      const color = normalizeColor(sourceColor || sourceDescription);
      const productKind = inferProductKind(sourceCode, sourceModel, sourceDescription);
      const size = normalizeSizeDetailed(sourceSize);
      let canonicalSize = size.label;
      if (!canonicalSize && ['borsa', 'scrunchies', 'fiocco', 'cerchietto'].includes(productKind)) {
        canonicalSize = 'OS';
      }
      const qtyStock = roundQty(valueAt(row, map.qtyStock));
      const dohaQty = sumAt(row, map.doha);
      const returnedQty = sumAt(row, map.returned);
      const location = dohaQty >= 1 ? 'Doha' : 'Milano';
      const stockQuantity = dohaQty >= 1 ? dohaQty : qtyStock + returnedQty;

      const normalizedRow = {
        sourceSheet: sheet.sheet,
        sourceRow: rowIndex + 1,
        sourceCode,
        sourceModel,
        sourceDescription,
        sourceColor,
        sourceSize,
        canonicalColor: color.label,
        canonicalColorSlug: color.slug,
        colorMappingConfidence: color.confidence,
        canonicalSize,
        sizeMappingConfidence: size.confidence,
        sizeMappingBlocked: size.confidence === 'pending_legend' || size.confidence === 'unsupported_size',
        productKind,
        season,
        year,
        isCampionatura,
        location,
        stockQuantity,
        sourceQtyStock: qtyStock,
        sourceQtyDoha: dohaQty,
        sourceQtyReturned: returnedQty,
        unitCostSartoria: toNumber(valueAt(row, map.costSartoria)),
        unitCostTessuto: toNumber(valueAt(row, map.costTessuto)),
        unitCostFodera: toNumber(valueAt(row, map.costFodera)),
        unitCostAccessori: toNumber(valueAt(row, map.costAccessori)),
        unitCostEtichettaLogo: toNumber(valueAt(row, map.costEtichettaLogo)),
        excludedReason: '',
        notes: [],
      };

      normalizedRow.excludedReason = isTishaLost(normalizedRow);
      if (map.doha.length === 0 && /DOHA/i.test(headerRow.join(' '))) {
        normalizedRow.notes.push('doha_column_combined_or_ambiguous_treated_as_milano_returned');
      }
      if (!canonicalSize) normalizedRow.notes.push('missing_size');
      if (normalizedRow.sizeMappingBlocked) normalizedRow.notes.push('size_not_available_in_current_site');
      if (!normalizedRow.canonicalColor) normalizedRow.notes.push('missing_color');
      if (color.confidence === 'source') normalizedRow.notes.push('color_mapping_requires_review');
      if (!season) normalizedRow.notes.push('missing_or_nonseasonal_season');
      if (!year) normalizedRow.notes.push('missing_year');

      rows.push(normalizedRow);
    }
  }

  return { rows, skippedSheets };
}

function buildErpMetaData(row) {
  const values = {
    fw_erp_season: row.season,
    fw_erp_year: row.year,
    fw_erp_is_campionatura: row.isCampionatura ? '1' : '0',
    fw_erp_location: row.location,
    fw_erp_original_sku: row.erpOriginalSku,
    fw_erp_unit_cost_sartoria: row.unitCostSartoria,
    fw_erp_unit_cost_tessuto: row.unitCostTessuto,
    fw_erp_unit_cost_fodera: row.unitCostFodera,
    fw_erp_unit_cost_accessori: row.unitCostAccessori,
    fw_erp_unit_cost_etichetta_logo: row.unitCostEtichettaLogo,
  };

  const meta = [];
  for (const field of ERP_FIELDS) {
    const value = values[field.name];
    if (value === null || value === undefined || value === '') continue;
    meta.push({ key: field.name, value: String(value) });
    meta.push({ key: `_${field.name}`, value: field.key });
  }
  return meta;
}

function extractAttributeValue(attributes, names) {
  const normalizedNames = names.map((name) => normalizeText(name));
  for (const attribute of attributes || []) {
    const label = normalizeText(attribute.name || attribute.slug || '');
    if (!normalizedNames.some((name) => label.includes(name))) continue;
    const value = attribute.option || (Array.isArray(attribute.options) ? attribute.options[0] : '');
    if (value) return String(value);
  }
  return '';
}

function buildCatalogRecord(product, variation = null) {
  const attrs = variation ? variation.attributes || [] : product.attributes || [];
  const rawColor = extractAttributeValue(attrs, ['colore', 'color']);
  const rawSize = extractAttributeValue(attrs, ['taglia', 'size']);
  const normalizedColor = normalizeColor(rawColor);
  const normalizedSize = normalizeSize(rawSize);
  const searchable = [
    product.name,
    product.sku,
    variation?.sku,
    rawColor,
    rawSize,
    ...(product.categories || []).map((category) => category.name || category.slug || ''),
  ].join(' ');

  return {
    productId: product.id,
    productName: product.name || '',
    productType: product.type || 'simple',
    productStatus: product.status || '',
    catalogVisibility: product.catalog_visibility || '',
    productSku: product.sku || '',
    variationId: variation ? variation.id : null,
    variationSku: variation ? variation.sku || '' : '',
    sku: variation ? variation.sku || '' : product.sku || '',
    rawColor,
    rawSize,
    canonicalColor: normalizedColor.label,
    canonicalColorSlug: normalizedColor.slug,
    canonicalSize: normalizedSize,
    productKind: inferProductKind(searchable),
    searchText: normalizeText(searchable),
    isVariation: Boolean(variation),
  };
}

async function loadWooCatalog(args) {
  if (args.offlineWooJson) {
    const raw = await fs.readFile(args.offlineWooJson, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.records)) {
      throw new Error('Il file offline Woo deve avere shape { records: [...] }.');
    }
    return parsed.records;
  }

  const settings = await resolveWooSettings();
  const products = await wooFetchAll(
    settings,
    'products?status=any&_fields=id,name,type,sku,status,catalog_visibility,attributes,categories,manage_stock,stock_quantity'
  );
  const selectedProducts = args.limitProducts ? products.slice(0, args.limitProducts) : products;
  const records = [];

  for (let index = 0; index < selectedProducts.length; index += 1) {
    const product = selectedProducts[index];
    if (product.type === 'variable') {
      const variations = await wooFetchAll(
        settings,
        `products/${product.id}/variations?_fields=id,sku,attributes,manage_stock,stock_quantity,status`
      );
      if (variations.length === 0) {
        records.push(buildCatalogRecord(product));
      } else {
        for (const variation of variations) {
          records.push(buildCatalogRecord(product, variation));
        }
      }
    } else {
      records.push(buildCatalogRecord(product));
    }
  }

  return records;
}

function buildSkuIndex(records) {
  const index = new Map();
  for (const record of records) {
    const sku = sanitizeSku(record.sku);
    if (!sku) continue;
    if (!index.has(sku)) index.set(sku, []);
    index.get(sku).push(record);
  }
  return index;
}

function isHiddenInventoryRow(row) {
  return row.location === 'Doha' || Boolean(row.isCampionatura);
}

function hiddenInventoryLabel(row) {
  if (row.location === 'Doha' && row.isCampionatura) return 'Doha campionatura';
  if (row.location === 'Doha') return 'Doha';
  if (row.isCampionatura) return 'Campionatura';
  return '';
}

function findAttributeCandidates(row, catalog, { ignoreSize = false } = {}) {
  return catalog.filter((record) => {
    if (row.canonicalColorSlug && record.canonicalColorSlug && row.canonicalColorSlug !== record.canonicalColorSlug) {
      return false;
    }
    if (!ignoreSize && row.canonicalSize && record.canonicalSize && row.canonicalSize !== record.canonicalSize) {
      return false;
    }
    if (row.productKind && record.productKind && row.productKind !== record.productKind) {
      return false;
    }
    return row.canonicalColorSlug || (!ignoreSize && row.canonicalSize) || row.productKind;
  });
}

function findMatch(row, catalog, skuIndex) {
  const sourceSku = sanitizeSku(row.sourceCode);
  if (sourceSku && skuIndex.has(sourceSku)) {
    const matches = skuIndex.get(sourceSku);
    if (isHiddenInventoryRow(row)) {
      return { status: 'review_hidden_inventory_reference', record: null, candidates: matches };
    }

    if (matches.length === 1) {
      const match = matches[0];
      const sizeConflict = row.canonicalSize && match.canonicalSize && row.canonicalSize !== match.canonicalSize;
      const colorConflict =
        row.canonicalColorSlug &&
        match.canonicalColorSlug &&
        row.colorMappingConfidence === 'mapped' &&
        row.canonicalColorSlug !== match.canonicalColorSlug;

      if (sizeConflict || colorConflict) {
        return { status: 'review_sku_attribute_conflict', record: null, candidates: matches };
      }

      return { status: 'matched_auto_sku', record: match, candidates: matches };
    }
    return { status: 'review_duplicate_sku', record: null, candidates: matches };
  }

  if (row.sizeMappingBlocked) {
    const candidates = findAttributeCandidates(row, catalog, { ignoreSize: true });
    return { status: 'review_unmapped_size', record: null, candidates };
  }

  const candidates = findAttributeCandidates(row, catalog);

  if (isHiddenInventoryRow(row)) {
    return {
      status: candidates.length > 0 ? 'review_hidden_inventory_reference' : 'review_hidden_inventory_new',
      record: null,
      candidates,
    };
  }

  if (candidates.length === 1 && row.canonicalColorSlug && row.canonicalSize && row.productKind) {
    return { status: 'matched_auto_attributes', record: candidates[0], candidates };
  }

  if (candidates.length > 1) {
    return { status: 'review_multiple_candidates', record: null, candidates };
  }

  return { status: 'review_missing_non_hidden_product', record: null, candidates: [] };
}

function uniqueSku(base, usedSkus) {
  const sanitizedBase = sanitizeSku(base) || 'FW-ERP';
  let candidate = sanitizedBase;
  let suffix = 2;
  while (usedSkus.has(candidate)) {
    candidate = `${sanitizedBase}-${suffix}`;
    suffix += 1;
  }
  usedSkus.add(candidate);
  return candidate;
}

function proposeSku(row, match, usedSkus) {
  if (isHiddenInventoryRow(row)) {
    const suffix = row.location === 'Doha' ? 'DOHA' : 'CAMP';
    const base =
      sanitizeSku(match.record?.sku) ||
      sanitizeSku(row.sourceCode) ||
      [
        'FW',
        row.year || 'ERP',
        row.season || 'NA',
        row.productKind || 'PRODOTTO',
        row.canonicalColorSlug,
        slugify(row.canonicalSize),
        row.sourceRow,
      ].join('-');
    return uniqueSku(`${base}-${suffix}`, usedSkus);
  }

  if (match.record?.sku) return sanitizeSku(match.record.sku);

  if (match.record) {
    const source = sanitizeSku(row.sourceCode);
    if (source) return uniqueSku(source, usedSkus);
    if (match.record.variationId) return uniqueSku(`FW-V${match.record.variationId}`, usedSkus);
    return uniqueSku(`FW-P${match.record.productId}`, usedSkus);
  }

  const source = sanitizeSku(row.sourceCode);
  if (source) return uniqueSku(source, usedSkus);

  return uniqueSku(
    [
      'FW',
      row.year || 'ERP',
      row.season || 'NA',
      row.productKind || 'PRODOTTO',
      row.canonicalColorSlug,
      slugify(row.canonicalSize),
      row.sourceRow,
    ].join('-'),
    usedSkus
  );
}

function buildCreatePayload(row, sku, match = { record: null }) {
  const hiddenLabel = hiddenInventoryLabel(row);
  const baseName = match.record?.productName || row.sourceModel || row.productKind || 'Prodotto Farway';
  const nameParts = [
    baseName,
    row.canonicalColor || row.sourceColor,
    row.canonicalSize,
    row.year,
  ].filter(Boolean);
  const name = hiddenLabel ? `${nameParts.join(' - ')} (${hiddenLabel})` : nameParts.join(' - ');
  const erpOriginalSku = sanitizeSku(match.record?.sku) || sanitizeSku(row.sourceCode);

  return {
    name,
    type: 'simple',
    sku,
    status: 'draft',
    catalog_visibility: 'hidden',
    manage_stock: true,
    stock_quantity: row.stockQuantity,
    stock_status: row.stockQuantity > 0 ? 'instock' : 'outofstock',
    meta_data: buildErpMetaData({ ...row, erpOriginalSku }),
  };
}

function buildUpdatePayload(row, match, sku) {
  const payload = {
    meta_data: buildErpMetaData(row),
  };

  if (!match.record.sku && sku) {
    payload.sku = sku;
  }

  return payload;
}

function reconcileRows(rows, catalog) {
  const skuIndex = buildSkuIndex(catalog);
  const usedSkus = new Set(catalog.map((record) => sanitizeSku(record.sku)).filter(Boolean));
  const reconciled = [];
  const actions = [];

  for (const row of rows) {
    if (row.excludedReason) {
      const record = {
        ...row,
        matchStatus: 'excluded_tisha_lost',
        action: 'exclude',
        proposedSku: '',
        wooProductId: '',
        wooVariationId: '',
        wooSku: '',
        candidateCount: 0,
      };
      reconciled.push(record);
      actions.push({
        type: 'exclude_tisha_lost',
        reason: row.excludedReason,
        source: pickSource(record),
      });
      continue;
    }

    const match = findMatch(row, catalog, skuIndex);
    const proposedSku = proposeSku(row, match, usedSkus);
    const isMatched = Boolean(match.record);
    const hiddenInventory = isHiddenInventoryRow(row);
    const action =
      hiddenInventory
        ? 'review_required'
        : match.status.startsWith('matched') && isMatched
        ? match.record.sku
          ? 'update_existing_meta'
          : 'set_missing_sku_and_update_meta'
        : match.status === 'new_hidden_draft_candidate'
          ? 'create_hidden_draft_candidate'
          : 'review_required';

    const record = {
      ...row,
      matchStatus: match.status,
      action,
      proposedSku,
      wooProductId: match.record?.productId || '',
      wooVariationId: match.record?.variationId || '',
      wooSku: match.record?.sku || '',
      wooProductName: match.record?.productName || '',
      candidateCount: match.candidates.length,
      candidateRefs: match.candidates
        .slice(0, 8)
        .map((candidate) => `${candidate.productId}${candidate.variationId ? `:${candidate.variationId}` : ''}:${candidate.productName}`)
        .join(' | '),
    };

    reconciled.push(record);

    if (action === 'update_existing_meta' || action === 'set_missing_sku_and_update_meta') {
      const endpoint = record.wooVariationId
        ? `products/${record.wooProductId}/variations/${record.wooVariationId}`
        : `products/${record.wooProductId}`;
      actions.push({
        type: action,
        method: 'PUT',
        endpoint,
        payload: buildUpdatePayload(row, match, proposedSku),
        source: pickSource(record),
      });
    } else if (action === 'create_hidden_draft_candidate') {
      actions.push({
        type: action,
        method: 'POST',
        endpoint: 'products',
        payload: buildCreatePayload(row, proposedSku, match),
        source: pickSource(record),
      });
    } else {
      actions.push({
        type: action,
        source: pickSource(record),
        candidates: match.candidates.slice(0, 12).map((candidate) => ({
          productId: candidate.productId,
          variationId: candidate.variationId,
          productName: candidate.productName,
          sku: candidate.sku,
          color: candidate.canonicalColor,
          size: candidate.canonicalSize,
        })),
      });
    }
  }

  return { rows: reconciled, actions };
}

function pickSource(record) {
  return {
    sheet: record.sourceSheet,
    row: record.sourceRow,
    code: record.sourceCode,
    model: record.sourceModel,
    color: record.sourceColor,
    size: record.sourceSize,
    proposedSku: record.proposedSku,
  };
}

function csvEscape(value) {
  const stringValue = String(value ?? '');
  if (/[",\r\n]/.test(stringValue)) return `"${stringValue.replace(/"/g, '""')}"`;
  return stringValue;
}

async function writeCsv(filePath, rows) {
  const headers = [
    'sourceSheet',
    'sourceRow',
    'sourceCode',
    'proposedSku',
    'sourceModel',
    'sourceDescription',
    'productKind',
    'sourceColor',
    'canonicalColor',
    'sourceSize',
    'canonicalSize',
    'sizeMappingConfidence',
    'season',
    'year',
    'isCampionatura',
    'location',
    'stockQuantity',
    'sourceQtyStock',
    'sourceQtyDoha',
    'sourceQtyReturned',
    'unitCostSartoria',
    'unitCostTessuto',
    'unitCostFodera',
    'unitCostAccessori',
    'unitCostEtichettaLogo',
    'matchStatus',
    'action',
    'wooProductId',
    'wooVariationId',
    'wooSku',
    'wooProductName',
    'candidateCount',
    'candidateRefs',
    'excludedReason',
    'notes',
  ];

  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(
      headers
        .map((header) => {
          const value = Array.isArray(row[header]) ? row[header].join('|') : row[header];
          return csvEscape(value);
        })
        .join(',')
    );
  }
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function groupCounts(rows, field) {
  const counts = new Map();
  for (const row of rows) {
    const key = String(row[field] || 'blank');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function topRows(rows, predicate, max = 40) {
  return rows.filter(predicate).slice(0, max);
}

function renderMarkdownTable(rows, columns) {
  if (rows.length === 0) return '_Nessuna riga._\n';
  const header = `| ${columns.map((column) => column.label).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => csvEscapeMarkdown(column.value(row))).join(' | ')} |`);
  return [header, divider, ...body].join('\n') + '\n';
}

function csvEscapeMarkdown(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .slice(0, 160);
}

function buildReport({ args, outputDir, rows, skippedSheets, actions, catalogSize }) {
  const actionCounts = groupCounts(rows, 'action');
  const matchCounts = groupCounts(rows, 'matchStatus');
  const sheetCounts = groupCounts(rows, 'sourceSheet');
  const locationCounts = groupCounts(rows, 'location');
  const tishaRows = topRows(rows, (row) => row.action === 'exclude', 20);
  const reviewRows = topRows(rows, (row) => row.action === 'review_required', 40);
  const createRows = topRows(rows, (row) => row.action === 'create_hidden_draft_candidate', 40);
  const skuRows = topRows(rows, (row) => row.action === 'set_missing_sku_and_update_meta', 40);

  return `# Farway ERP - Report riconciliazione prodotti

Generato: ${new Date().toISOString()}

## Scope
- File Excel: \`${args.excelPath}\`
- Output: \`${outputDir}\`
- Record WooCommerce analizzati: ${catalogSize}
- Righe normalizzate dal file: ${rows.length}
- Azioni dry-run prodotte: ${actions.length}

## Sintesi azioni
${renderMarkdownTable(actionCounts.map(([action, count]) => ({ action, count })), [
  { label: 'Azione', value: (row) => row.action },
  { label: 'Righe', value: (row) => row.count },
])}

## Sintesi match
${renderMarkdownTable(matchCounts.map(([matchStatus, count]) => ({ matchStatus, count })), [
  { label: 'Match status', value: (row) => row.matchStatus },
  { label: 'Righe', value: (row) => row.count },
])}

## Location
${renderMarkdownTable(locationCounts.map(([location, count]) => ({ location, count })), [
  { label: 'Location', value: (row) => row.location },
  { label: 'Righe', value: (row) => row.count },
])}

## Righe per foglio
${renderMarkdownTable(sheetCounts.map(([sheet, count]) => ({ sheet, count })), [
  { label: 'Foglio', value: (row) => row.sheet },
  { label: 'Righe', value: (row) => row.count },
])}

## SKU generati per record WooCommerce esistenti
${renderMarkdownTable(skuRows, [
  { label: 'Foglio', value: (row) => row.sourceSheet },
  { label: 'Riga', value: (row) => row.sourceRow },
  { label: 'SKU proposto', value: (row) => row.proposedSku },
  { label: 'Woo', value: (row) => `${row.wooProductId}${row.wooVariationId ? `:${row.wooVariationId}` : ''}` },
  { label: 'Prodotto', value: (row) => row.wooProductName },
])}

## Prodotti mancanti candidati a draft hidden
${renderMarkdownTable(createRows, [
  { label: 'Foglio', value: (row) => row.sourceSheet },
  { label: 'Riga', value: (row) => row.sourceRow },
  { label: 'SKU', value: (row) => row.proposedSku },
  { label: 'Modello', value: (row) => row.sourceModel || row.sourceCode },
  { label: 'Colore', value: (row) => row.canonicalColor },
  { label: 'Taglia', value: (row) => row.canonicalSize },
  { label: 'Location', value: (row) => row.location },
  { label: 'Qta', value: (row) => row.stockQuantity },
])}

## Casi da approvare manualmente
${renderMarkdownTable(reviewRows, [
  { label: 'Foglio', value: (row) => row.sourceSheet },
  { label: 'Riga', value: (row) => row.sourceRow },
  { label: 'Codice', value: (row) => row.sourceCode },
  { label: 'Modello', value: (row) => row.sourceModel },
  { label: 'Colore', value: (row) => row.canonicalColor },
  { label: 'Taglia', value: (row) => row.canonicalSize },
  { label: 'Candidati', value: (row) => row.candidateRefs },
])}

## Esclusioni Tisha
${renderMarkdownTable(tishaRows, [
  { label: 'Foglio', value: (row) => row.sourceSheet },
  { label: 'Riga', value: (row) => row.sourceRow },
  { label: 'Codice', value: (row) => row.sourceCode },
  { label: 'Modello', value: (row) => row.sourceModel },
  { label: 'Colore', value: (row) => row.sourceColor || row.canonicalColor },
  { label: 'Motivo', value: (row) => row.excludedReason },
])}

## Fogli esclusi dalla normalizzazione
${skippedSheets.map((sheet) => `- ${sheet}`).join('\n')}

## Garanzie dry-run
- Nessuna scrittura viene eseguita senza \`--apply --confirm-apply ${APPLY_CONFIRMATION}\`.
- La creazione dei prodotti mancanti richiede anche \`--apply-create-missing\`.
- Per prodotti WooCommerce già esistenti il payload contiene solo SKU mancante e metadati ERP; non contiene prezzo, descrizione, immagini, visibilità o stock.
`;
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function applyActions(args, actions) {
  if (!args.apply) {
    return { applied: 0, skipped: actions.length, results: [] };
  }

  if (args.confirmApply !== APPLY_CONFIRMATION) {
    throw new Error(`Apply bloccato: passa --confirm-apply ${APPLY_CONFIRMATION}.`);
  }

  const settings = await resolveWooSettings();
  const results = [];
  let applied = 0;

  for (const action of actions) {
    if (!action.method || !action.endpoint || !action.payload) {
      results.push({ action: action.type, status: 'skipped_no_write_payload', source: action.source });
      continue;
    }

    if (action.type === 'create_hidden_draft_candidate' && !args.applyCreateMissing) {
      results.push({ action: action.type, status: 'skipped_missing_create_flag', source: action.source });
      continue;
    }

    if (action.type === 'review_required' || action.type === 'exclude_tisha_lost') {
      results.push({ action: action.type, status: 'skipped_non_writable', source: action.source });
      continue;
    }

    const response = await wooRequest(settings, action.method, action.endpoint, action.payload);
    results.push({ action: action.type, status: 'applied', endpoint: action.endpoint, id: response?.id, source: action.source });
    applied += 1;
  }

  return { applied, skipped: actions.length - applied, results };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = args.outputDir || path.join(process.cwd(), 'data', `tmp-farway-erp-reconcile-${nowCompact()}`);

  await fs.mkdir(outputDir, { recursive: true });

  legendMaps = await loadLegendMaps(args.legendPackPath);
  if (legendMaps.loaded) {
    console.log(`[farway-erp] Legende approvate: ${args.legendPackPath}`);
  } else {
    console.log('[farway-erp] Nessun legend pack approvato trovato: uso fallback locali.');
  }

  console.log(`[farway-erp] Leggo Excel: ${args.excelPath}`);
  const sheets = await readExcelFile(args.excelPath);
  const { rows: normalizedRows, skippedSheets } = parseWorkbookRows(sheets);

  console.log(`[farway-erp] Righe normalizzate: ${normalizedRows.length}`);
  console.log('[farway-erp] Leggo catalogo WooCommerce...');
  const catalog = await loadWooCatalog(args);
  console.log(`[farway-erp] Record WooCommerce analizzati: ${catalog.length}`);

  const { rows, actions } = reconcileRows(normalizedRows, catalog);
  const dryRun = {
    generatedAt: new Date().toISOString(),
    apply: args.apply,
    applyCreateMissing: args.applyCreateMissing,
    excelPath: args.excelPath,
    erpFields: ERP_FIELDS,
    actions,
  };

  const masterPath = path.join(outputDir, 'master-normalizzato.csv');
  const reportPath = path.join(outputDir, 'report-riconciliazione.md');
  const dryRunPath = path.join(outputDir, 'dry-run-import.json');
  const summaryPath = path.join(outputDir, 'summary.json');

  await writeCsv(masterPath, rows);
  await writeJson(dryRunPath, dryRun);

  const applyResult = await applyActions(args, actions);
  const summary = {
    generatedAt: dryRun.generatedAt,
    excelPath: args.excelPath,
    outputDir,
    normalizedRows: rows.length,
    catalogRecords: catalog.length,
    actions: Object.fromEntries(groupCounts(rows, 'action')),
    matches: Object.fromEntries(groupCounts(rows, 'matchStatus')),
    locations: Object.fromEntries(groupCounts(rows, 'location')),
    skippedSheets,
    applyResult,
    files: {
      master: masterPath,
      report: reportPath,
      dryRun: dryRunPath,
      summary: summaryPath,
    },
  };

  await fs.writeFile(
    reportPath,
    buildReport({ args, outputDir, rows, skippedSheets, actions, catalogSize: catalog.length }),
    'utf8'
  );
  await writeJson(summaryPath, summary);

  console.log(`[farway-erp] Master: ${masterPath}`);
  console.log(`[farway-erp] Report: ${reportPath}`);
  console.log(`[farway-erp] Dry-run: ${dryRunPath}`);
  if (args.apply) {
    console.log(`[farway-erp] Apply: ${applyResult.applied} scritture, ${applyResult.skipped} skip.`);
  } else {
    console.log('[farway-erp] Dry-run completato: nessuna scrittura eseguita.');
  }
}

main().catch((error) => {
  console.error(`[farway-erp] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
