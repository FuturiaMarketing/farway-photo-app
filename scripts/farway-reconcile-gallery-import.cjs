#!/usr/bin/env node
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DEFAULT_STILL_LIFE_DIR =
  'D:\\GoogleDrive\\Futuria at work\\Clienti e progetti\\Farway Milano\\Website\\Sito Next\\Foto still life sfondo chiaro';
const DEFAULT_REPORT_DIR = path.join(process.cwd(), 'data', 'reconcile-gallery-import');
const USER_AGENT = 'FarwayPhotoAppReconcileGallery/1.0';

function parseArgs(argv) {
  const args = {
    apply: false,
    allConfirmed: false,
    pruneMissingSource: false,
    deletePrunedMedia: false,
    productId: 0,
    storeUrl: '',
    sourceDir: process.env.STILL_LIFE_DIR || DEFAULT_STILL_LIFE_DIR,
    reportDir: DEFAULT_REPORT_DIR,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || '');

    if (value === '--apply') {
      args.apply = true;
      continue;
    }

    if (value === '--all-confirmed') {
      args.allConfirmed = true;
      continue;
    }

    if (value === '--prune-missing-source') {
      args.pruneMissingSource = true;
      continue;
    }

    if (value === '--delete-pruned-media') {
      args.deletePrunedMedia = true;
      continue;
    }

    if (value === '--product-id') {
      const parsed = Number(argv[index + 1] || 0);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.productId = Math.round(parsed);
      }
      index += 1;
      continue;
    }

    if (value === '--source-dir') {
      args.sourceDir = String(argv[index + 1] || '').trim() || args.sourceDir;
      index += 1;
      continue;
    }

    if (value === '--store-url') {
      args.storeUrl = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }

    if (value === '--report-dir') {
      args.reportDir = path.resolve(String(argv[index + 1] || '').trim() || args.reportDir);
      index += 1;
      continue;
    }

    if (value === '--help' || value === '-h') {
      args.help = true;
      continue;
    }
  }

  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/farway-reconcile-gallery-import.cjs --product-id 1385
  node scripts/farway-reconcile-gallery-import.cjs --product-id 1385 --apply

Options:
  --product-id <id>     Import one confirmed product.
  --all-confirmed       Import every confirmed decision with a productId.
  --source-dir <path>   Override the still-life source folder.
  --store-url <url>     Override the WordPress/WooCommerce API origin.
  --report-dir <path>   Override local report folder.
  --prune-missing-source
                         Remove managed still-life images whose source file is no longer in the top-level source folder.
  --delete-pruned-media  Delete pruned media from Media Library when no product gallery/variation still references them.
  --apply               Upload media and update product.images. Omit for dry-run.`);
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

      let value = trimmed.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  } catch {
    // optional
  }
}

async function readWooSettingsFromDatabase() {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 1,
  });

  try {
    const result = await pool.query(
      "SELECT value FROM app_key_value WHERE namespace='settings' AND key='woocommerce'"
    );
    const value = result.rows[0]?.value || null;
    if (!value) return null;

    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed?.storeUrl && parsed.consumerKey && parsed.consumerSecret) {
      return parsed;
    }
  } catch {
    return null;
  } finally {
    await pool.end().catch(() => {});
  }

  return null;
}

async function readEnvValueFromFile(filePath, key) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const separatorIndex = line.indexOf('=');
      if (separatorIndex <= 0) continue;
      if (line.slice(0, separatorIndex).trim() !== key) continue;

      let value = line.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value;
    }
  } catch {
    return '';
  }

  return '';
}

async function resolveWpOrigin(projectRoot, configuredStoreUrl, overrideStoreUrl) {
  const candidates = [
    overrideStoreUrl,
    process.env.FARWAY_WP_ORIGIN,
    process.env.WP_ORIGIN_URL,
    process.env.WORDPRESS_ORIGIN_URL,
  ];
  const siblingStorefront = path.resolve(projectRoot, '..', 'next-storefront-pilot');

  for (const fileName of ['.env.local', '.env', '.env.example']) {
    candidates.push(await readEnvValueFromFile(path.join(siblingStorefront, fileName), 'FARWAY_WP_ORIGIN'));
  }

  candidates.push(configuredStoreUrl);

  const resolved = candidates.find((value) => String(value || '').trim());
  return String(resolved || '').trim().replace(/\/$/, '');
}

async function resolveWooSettings(projectRoot, args) {
  await loadEnvFile(path.join(projectRoot, '.env.local'));

  const databaseSettings = await readWooSettingsFromDatabase();
  if (databaseSettings?.storeUrl && databaseSettings.consumerKey && databaseSettings.consumerSecret) {
    const configuredStoreUrl = String(databaseSettings.storeUrl).replace(/\/$/, '');
    return {
      storeUrl: await resolveWpOrigin(projectRoot, configuredStoreUrl, args.storeUrl),
      configuredStoreUrl,
      consumerKey: String(databaseSettings.consumerKey),
      consumerSecret: String(databaseSettings.consumerSecret),
    };
  }

  const settingsPath = path.join(projectRoot, 'data', 'woocommerce-settings.json');
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.storeUrl && parsed.consumerKey && parsed.consumerSecret) {
      const configuredStoreUrl = String(parsed.storeUrl).replace(/\/$/, '');
      return {
        storeUrl: await resolveWpOrigin(projectRoot, configuredStoreUrl, args.storeUrl),
        configuredStoreUrl,
        consumerKey: String(parsed.consumerKey),
        consumerSecret: String(parsed.consumerSecret),
      };
    }
  } catch {
    // fallback env
  }

  const storeUrl = String(process.env.WC_STORE_URL || '').trim().replace(/\/$/, '');
  const consumerKey = String(process.env.WC_CONSUMER_KEY || '').trim();
  const consumerSecret = String(process.env.WC_CONSUMER_SECRET || '').trim();

  if (!storeUrl || !consumerKey || !consumerSecret) {
    throw new Error('Credenziali WooCommerce mancanti (WC_STORE_URL, WC_CONSUMER_KEY, WC_CONSUMER_SECRET).');
  }

  return {
    storeUrl: await resolveWpOrigin(projectRoot, storeUrl, args.storeUrl),
    configuredStoreUrl: storeUrl,
    consumerKey,
    consumerSecret,
  };
}

function resolveWpCredentials() {
  const username = String(
    process.env.WP_API_USERNAME || process.env.WP_USERNAME || process.env.WP_USER_EMAIL || ''
  ).trim();
  const appPassword = String(process.env.WP_APP_PASSWORD || '').trim();

  if (!username || !appPassword) {
    return null;
  }

  return { username, appPassword };
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

function buildWooUrl(settings, endpoint, authMode) {
  const url = new URL(`${settings.storeUrl}/wp-json/wc/v3/${String(endpoint).replace(/^\//, '')}`);

  if (authMode === 'query') {
    url.searchParams.set('consumer_key', settings.consumerKey);
    url.searchParams.set('consumer_secret', settings.consumerSecret);
  }

  return url;
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function summarizeBody(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body.slice(0, 260);
  return JSON.stringify(body).slice(0, 260);
}

const HTTP_RETRY_ATTEMPTS = 5;

function isRetriableHttpStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function makeHttpError(message, status, responseBody) {
  const error = new Error(message);
  error.status = status;
  error.responseBody = responseBody;
  error.retriable = isRetriableHttpStatus(status);
  return error;
}

function isRetriableError(error) {
  return Boolean(
    error?.retriable ||
      error?.name === 'AbortError' ||
      /(?:fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|database|connessione al database)/i.test(
        String(error?.message || '')
      )
  );
}

async function withHttpRetry(action, attempts = HTTP_RETRY_ATTEMPTS) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;

      if (attempt >= attempts || !isRetriableError(error)) {
        throw error;
      }

      await wait(Math.min(1500 * attempt, 8000));
    }
  }

  throw lastError;
}

async function wooRequestOnce(settings, method, endpoint, body) {
  const attempts = ['basic', 'query'];
  const failures = [];

  for (const authMode of attempts) {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    };

    if (authMode === 'basic') {
      const token = Buffer.from(`${settings.consumerKey}:${settings.consumerSecret}`).toString('base64');
      headers.Authorization = `Basic ${token}`;
    }

    const response = await fetchWithTimeout(buildWooUrl(settings, endpoint, authMode), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const responseBody = await readResponseBody(response);

    if (response.ok) {
      return responseBody;
    }

    failures.push(`${authMode} ${response.status}: ${summarizeBody(responseBody)}`);
    if (response.status !== 401 && response.status !== 403) {
      break;
    }
  }

  const lastFailure = failures.at(-1) || '';
  const statusMatch = lastFailure.match(/\s(\d{3}):/);
  throw makeHttpError(
    `Woo ${method} ${endpoint} non riuscito. Tentativi: ${failures.join(' | ')}`,
    statusMatch ? Number(statusMatch[1]) : 0,
    lastFailure
  );
}

async function wooRequest(settings, method, endpoint, body) {
  return withHttpRetry(() => wooRequestOnce(settings, method, endpoint, body));
}

function addEndpointParams(endpoint, params) {
  const pairs = Object.entries(params).map(
    ([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
  );
  return `${endpoint}${String(endpoint).includes('?') ? '&' : '?'}${pairs.join('&')}`;
}

async function wooFetchAll(settings, endpoint) {
  const all = [];
  let page = 1;

  while (true) {
    const list = await wooRequest(settings, 'GET', addEndpointParams(endpoint, { per_page: 100, page }));
    if (!Array.isArray(list) || list.length === 0) {
      break;
    }

    all.push(...list);
    if (list.length < 100) {
      break;
    }

    page += 1;
  }

  return all;
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function wooFetchAllWithRetry(settings, endpoint, attempts = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await wooFetchAll(settings, endpoint);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await wait(1200 * attempt);
      }
    }
  }

  throw lastError;
}

function buildWpUrl(baseUrl, endpoint) {
  return new URL(`${baseUrl}/wp-json/wp/v2/${String(endpoint).replace(/^\//, '')}`);
}

function buildWpHeaders(wpCreds, json = true) {
  const token = Buffer.from(`${wpCreds.username}:${wpCreds.appPassword}`).toString('base64');
  const headers = {
    Accept: 'application/json',
    Authorization: `Basic ${token}`,
    'User-Agent': USER_AGENT,
  };

  if (json) {
    headers['Content-Type'] = 'application/json';
  }

  return headers;
}

async function wpRequestOnce(baseUrl, wpCreds, method, endpoint, body) {
  const response = await fetchWithTimeout(buildWpUrl(baseUrl, endpoint), {
    method,
    headers: buildWpHeaders(wpCreds, true),
    body: body ? JSON.stringify(body) : undefined,
  });
  const responseBody = await readResponseBody(response);

  if (!response.ok) {
    throw makeHttpError(
      `WP ${method} ${endpoint} -> ${response.status}: ${summarizeBody(responseBody)}`,
      response.status,
      responseBody
    );
  }

  return responseBody;
}

async function wpRequest(baseUrl, wpCreds, method, endpoint, body) {
  return withHttpRetry(() => wpRequestOnce(baseUrl, wpCreds, method, endpoint, body));
}

function getFileMimeType(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function sanitizeUploadFileName(fileName) {
  const parsed = path.parse(fileName);
  const base = parsed.name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'still-life';
  const extension = parsed.ext || '.jpg';
  return `${base}${extension.toLowerCase()}`;
}

async function uploadWordPressMedia(baseUrl, wpCreds, sourcePath, sourceFileName) {
  const bytes = await fs.readFile(sourcePath);
  const uploadFileName = sanitizeUploadFileName(sourceFileName);

  return withHttpRetry(async () => {
    const response = await fetchWithTimeout(`${baseUrl}/wp-json/wp/v2/media`, {
      method: 'POST',
      headers: {
        ...buildWpHeaders(wpCreds, false),
        'Content-Disposition': `attachment; filename="${uploadFileName}"`,
        'Content-Type': getFileMimeType(uploadFileName),
      },
      body: bytes,
    });
    const responseBody = await readResponseBody(response);

    if (!response.ok) {
      throw makeHttpError(
        `WP media upload ${sourceFileName} -> ${response.status}: ${summarizeBody(responseBody)}`,
        response.status,
        responseBody
      );
    }

    return responseBody;
  });
}

async function updateWordPressMediaMetadata(baseUrl, wpCreds, mediaId, title, altText) {
  return wpRequest(baseUrl, wpCreds, 'POST', `media/${mediaId}`, {
    title,
    alt_text: altText,
  });
}

async function deleteWordPressMedia(baseUrl, wpCreds, mediaId) {
  return wpRequest(baseUrl, wpCreds, 'DELETE', `media/${mediaId}?force=true`);
}

async function readTopLevelImageFiles(sourceDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  return new Set(
    entries
      .filter((entry) => entry.isFile() && /\.(jpe?g|png|webp)$/i.test(entry.name))
      .map((entry) => entry.name)
  );
}

function normalizeProbe(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&[^;]+;/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getUrlFileName(value) {
  try {
    const parsed = new URL(String(value || ''));
    return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
  } catch {
    return '';
  }
}

function sourceFileNeedles(sourceFileName) {
  // Match the full original filename only; prefix matches collide on similar shots.
  return [normalizeProbe(sourceFileName)].filter((value) => value.length >= 4);
}

function galleryImageMatchesSource(image, sourceFileName) {
  const corpus = normalizeProbe(
    [
      image?.name,
      image?.alt,
      image?.src,
      getUrlFileName(image?.src),
    ].join(' ')
  );

  return sourceFileNeedles(sourceFileName).some((needle) => corpus.includes(needle));
}

function isManagedImportImageForSource(image, sourceFileName) {
  const corpus = normalizeProbe([image?.name, image?.alt, image?.src, getUrlFileName(image?.src)].join(' '));
  return (
    corpus.includes('still life') &&
    corpus.includes('farway milano') &&
    galleryImageMatchesSource(image, sourceFileName)
  );
}

function mediaMatchesSource(media, sourceFileName) {
  const corpus = normalizeProbe(
    [
      media?.title?.rendered,
      media?.alt_text,
      media?.source_url,
      getUrlFileName(media?.source_url),
    ].join(' ')
  );

  return sourceFileNeedles(sourceFileName).some((needle) => corpus.includes(needle));
}

function isManagedImportMediaForSource(media, sourceFileName) {
  const corpus = normalizeProbe(
    [
      media?.title?.rendered,
      media?.title?.raw,
      media?.alt_text,
      media?.source_url,
      getUrlFileName(media?.source_url),
    ].join(' ')
  );

  return (
    corpus.includes('still life') &&
    corpus.includes('farway milano') &&
    mediaMatchesSource(media, sourceFileName)
  );
}

async function findExistingWordPressMedia(baseUrl, wpCreds, sourceFileName) {
  if (!wpCreds) {
    return null;
  }

  const parsed = path.parse(sourceFileName);
  const searchTerms = Array.from(
    new Set([
      parsed.name,
      parsed.name.replace(/^_+/, ''),
      sourceFileName,
      sourceFileName.replace(/^_+/, ''),
    ])
  );

  for (const term of searchTerms) {
    const endpoint = addEndpointParams('media', {
      search: term,
      per_page: 100,
      _fields: 'id,source_url,title,alt_text,media_type,mime_type',
    });
    const results = await wpRequest(baseUrl, wpCreds, 'GET', endpoint);
    if (!Array.isArray(results)) {
      continue;
    }

    const match = results.find((media) => mediaMatchesSource(media, sourceFileName));
    if (match) {
      return match;
    }
  }

  return null;
}

function titleFromMedia(media) {
  return String(media?.title?.rendered || media?.title?.raw || '').replace(/<[^>]+>/g, '').trim();
}

function normalizeIdentity(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function collectProductColorways(product, variations) {
  const colorways = new Map();

  function addColorway(value) {
    const name = String(value || '').trim();
    const slug = normalizeIdentity(name);
    if (!slug || colorways.has(slug)) return;
    colorways.set(slug, { name, slug });
  }

  for (const attribute of Array.isArray(product?.attributes) ? product.attributes : []) {
    if (normalizeIdentity(attribute?.name) !== 'colore') continue;

    for (const option of Array.isArray(attribute?.options) ? attribute.options : []) {
      addColorway(option);
    }

    for (const term of Array.isArray(attribute?.terms) ? attribute.terms : []) {
      addColorway(term?.name || term?.slug);
    }
  }

  for (const variation of variations) {
    for (const attribute of Array.isArray(variation?.attributes) ? variation.attributes : []) {
      if (normalizeIdentity(attribute?.name) !== 'colore') continue;
      addColorway(attribute?.option || attribute?.value);
    }
  }

  return colorways;
}

function resolveDecisionColorway(decision, productColorways) {
  const name = String(decision?.colorway || '').trim();
  const slug = normalizeIdentity(name);
  if (!slug || !productColorways.has(slug)) return null;
  const productColorway = productColorways.get(slug);
  return { name: productColorway?.name || name, slug };
}

function normalizeMetadataText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;|&mdash;/gi, '-')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function mediaNeedsMetadataUpdate(currentTitle, currentAlt, nextTitle, nextAlt) {
  return (
    normalizeMetadataText(currentTitle) !== normalizeMetadataText(nextTitle) ||
    normalizeMetadataText(currentAlt) !== normalizeMetadataText(nextAlt)
  );
}

function buildMediaTitle(productName, decision, colorway = null) {
  const view = normalizeProbe(decision.view).replace(/\s+/g, '-') || 'vista-non-specificata';
  const colorPart = colorway?.name ? ` ${colorway.name}` : '';
  return `${productName}${colorPart} still life ${view} di Farway Milano - ${decision.file}`;
}

function imageRefForPayload(image) {
  const id = Number(image?.id || 0);
  if (id > 0) {
    return { id };
  }

  const src = String(image?.src || '').trim();
  if (src) {
    const ref = { src };
    if (image?.name) ref.name = String(image.name);
    if (image?.alt) ref.alt = String(image.alt);
    return ref;
  }

  return null;
}

function imageSummary(image) {
  return {
    id: Number(image?.id || 0),
    name: String(image?.name || ''),
    alt: String(image?.alt || ''),
    src: String(image?.src || ''),
    file: getUrlFileName(image?.src),
  };
}

function variationImageSummary(variation) {
  return {
    id: Number(variation?.id || 0),
    sku: String(variation?.sku || ''),
    imageId: Number(variation?.image?.id || 0),
    imageSrc: String(variation?.image?.src || ''),
    attributes: Array.isArray(variation?.attributes)
      ? variation.attributes.map((attribute) => ({
          name: String(attribute?.name || ''),
          option: String(attribute?.option || ''),
        }))
      : [],
  };
}

function variationImageMap(variations) {
  return Object.fromEntries(
    variations.map((variation) => [String(Number(variation?.id || 0)), Number(variation?.image?.id || 0)])
  );
}

function sameVariationImageMap(before, after) {
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  if (beforeKeys.join('|') !== afterKeys.join('|')) {
    return false;
  }

  return beforeKeys.every((key) => before[key] === after[key]);
}

function sameFirstImage(before, after) {
  const beforeFirst = before?.[0] || null;
  const afterFirst = after?.[0] || null;
  return (
    Number(beforeFirst?.id || 0) === Number(afterFirst?.id || 0) &&
    String(beforeFirst?.src || '') === String(afterFirst?.src || '')
  );
}

function csvCell(value) {
  const text = String(value == null ? '' : value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function saveReports(report, reportDir) {
  await fs.mkdir(reportDir, { recursive: true });
  const timestamp = report.createdAt.replace(/[:.]/g, '-');
  const mode = report.mode.apply ? 'apply' : 'dry-run';
  const jsonPath = path.join(reportDir, `gallery-import-${mode}-${timestamp}.json`);
  const latestJsonPath = path.join(reportDir, 'gallery-import-latest.json');
  const csvPath = path.join(reportDir, `gallery-import-${mode}-${timestamp}.csv`);
  const latestCsvPath = path.join(reportDir, 'gallery-import-latest.csv');

  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), 'utf8');

  const rows = [
    [
      'createdAt',
      'mode',
      'productId',
      'productName',
      'sku',
      'file',
      'colorway',
      'colorSlug',
      'action',
      'reason',
      'sourcePath',
      'mediaId',
      'mediaUrl',
      'previousTitle',
      'previousAlt',
      'title',
      'alt',
    ],
  ];

  for (const product of report.products) {
    for (const row of product.importRows) {
      rows.push([
        report.createdAt,
        mode,
        product.product.id,
        product.product.name,
        product.product.sku,
        row.file,
        row.colorway || '',
        row.colorSlug || '',
        row.action,
        row.reason,
        row.sourcePath,
        row.mediaId || '',
        row.mediaUrl || '',
        row.previousTitle || '',
        row.previousAlt || '',
        row.title || '',
        row.alt || '',
      ]);
    }

    for (const row of product.pruneRows || []) {
      rows.push([
        report.createdAt,
        mode,
        product.product.id,
        product.product.name,
        product.product.sku,
        row.file,
        row.colorway || '',
        row.colorSlug || '',
        row.action,
        row.reason,
        row.sourcePath,
        row.mediaId || '',
        row.mediaUrl || '',
        row.previousTitle || '',
        row.previousAlt || '',
        row.title || '',
        row.alt || '',
      ]);
    }
  }

  for (const row of report.mediaDeleteRows || []) {
    rows.push([
      report.createdAt,
      mode,
      row.products?.map((product) => product.productId).join('|') || '',
      row.products?.map((product) => product.productName).join('|') || '',
      row.products?.map((product) => product.sku).join('|') || '',
      row.file || '',
      row.colorway || '',
      row.colorSlug || '',
      row.action,
      row.reason,
      '',
      row.mediaId || '',
      row.mediaUrl || '',
      row.previousTitle || '',
      row.previousAlt || '',
      '',
      '',
    ]);
  }

  const csv = `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
  await fs.writeFile(csvPath, csv, 'utf8');
  await fs.writeFile(latestCsvPath, csv, 'utf8');

  return { jsonPath, latestJsonPath, csvPath, latestCsvPath };
}

async function loadDecisions(projectRoot) {
  await loadEnvFile(path.join(projectRoot, '.env.local'));

  if (process.env.DATABASE_URL) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 1,
    });

    try {
      const result = await pool.query(
        "SELECT value FROM app_key_value WHERE namespace='photo_matches' AND key='decisions'"
      );
      const value = result.rows[0]?.value || {};
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      return {
        source: 'postgres:app_key_value/photo_matches/decisions',
        decisions: Object.values(parsed || {}),
      };
    } finally {
      await pool.end().catch(() => {});
    }
  }

  const fallbackPath = path.join(projectRoot, 'data', 'reconcile', 'decisions.json');
  const raw = await fs.readFile(fallbackPath, 'utf8');
  return {
    source: fallbackPath,
    decisions: Object.values(JSON.parse(raw)),
  };
}

function groupByProduct(decisions, args, sourceFileSet) {
  const eligible = decisions.filter((decision) => {
    const status = String(decision?.status || '').trim();
    const productId = Number(decision?.productId || 0);
    if (status !== 'confirmed' || productId <= 0) {
      return false;
    }

    if (args.productId > 0 && productId !== args.productId) {
      return false;
    }

    return true;
  });

  const present = eligible.filter((decision) => sourceFileSet.has(String(decision?.file || '')));
  const missing = eligible.filter((decision) => !sourceFileSet.has(String(decision?.file || '')));
  const productIdsToProcess = new Set(present.map((decision) => Number(decision.productId)));
  if (args.productId > 0 && eligible.length > 0) {
    productIdsToProcess.add(args.productId);
  }

  const groups = new Map();
  for (const decision of eligible) {
    const productId = Number(decision.productId);
    if (!productIdsToProcess.has(productId)) {
      continue;
    }

    if (!groups.has(productId)) {
      groups.set(productId, []);
    }
    groups.get(productId).push(decision);
  }

  for (const rows of groups.values()) {
    rows.sort((a, b) => String(a.file || '').localeCompare(String(b.file || '')));
  }

  return {
    eligible,
    present,
    missing,
    productCountAfterIntersection: new Set(present.map((decision) => Number(decision.productId))).size,
    groups: Array.from(groups.entries())
      .sort(([a], [b]) => a - b)
      .map(([productId, rows]) => ({ productId, rows })),
  };
}

async function sourceExists(sourcePath) {
  try {
    const stat = await fs.stat(sourcePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function buildProductSnapshot(product, variations) {
  const images = Array.isArray(product?.images) ? product.images : [];
  return {
    product: {
      id: Number(product?.id || 0),
      name: String(product?.name || ''),
      sku: String(product?.sku || ''),
      permalink: String(product?.permalink || ''),
    },
    galleryCount: images.length,
    firstImage: imageSummary(images[0] || {}),
    images: images.map(imageSummary),
    variations: variations.map(variationImageSummary),
    variationImageMap: variationImageMap(variations),
  };
}

async function fetchProductsForReferenceScan(settings) {
  try {
    return await wooFetchAllWithRetry(settings, 'products?status=any&_fields=id,name,sku,images');
  } catch {
    return wooFetchAllWithRetry(settings, 'products?_fields=id,name,sku,images');
  }
}

function makePlannedPruneKey(productId, mediaId) {
  return `${Number(productId || 0)}:${Number(mediaId || 0)}`;
}

async function buildMediaReferenceIndex(settings, mediaIds, plannedPrunes = []) {
  const targetIds = new Set(Array.from(mediaIds).map((id) => Number(id || 0)).filter((id) => id > 0));
  const plannedPruneKeys = new Set(
    plannedPrunes.map((item) => makePlannedPruneKey(item.productId, item.mediaId))
  );
  const references = new Map(Array.from(targetIds).map((id) => [id, []]));

  if (!targetIds.size) {
    return references;
  }

  const products = await fetchProductsForReferenceScan(settings);
  for (const product of products) {
    const productId = Number(product?.id || 0);
    for (const image of Array.isArray(product?.images) ? product.images : []) {
      const mediaId = Number(image?.id || 0);
      if (!targetIds.has(mediaId)) continue;
      if (plannedPruneKeys.has(makePlannedPruneKey(productId, mediaId))) continue;

      references.get(mediaId).push({
        type: 'product-gallery',
        productId,
        productName: String(product?.name || ''),
        sku: String(product?.sku || ''),
      });
    }

    const variations = await wooFetchAllWithRetry(
      settings,
      `products/${productId}/variations?_fields=id,sku,image`
    );
    for (const variation of variations) {
      const mediaId = Number(variation?.image?.id || 0);
      if (!targetIds.has(mediaId)) continue;

      references.get(mediaId).push({
        type: 'variation-image',
        productId,
        variationId: Number(variation?.id || 0),
        sku: String(variation?.sku || ''),
      });
    }
  }

  return references;
}

async function planOrDeletePrunedMedia({ settings, wpCreds, args, productReports }) {
  const candidatesById = new Map();
  const plannedPrunes = [];

  for (const productReport of productReports) {
    for (const row of productReport.pruneRows || []) {
      const mediaId = Number(row.mediaId || 0);
      if (mediaId <= 0 || row.action === 'skip-protected-featured') continue;

      plannedPrunes.push({ productId: productReport.product.id, mediaId });
      if (!candidatesById.has(mediaId)) {
        candidatesById.set(mediaId, {
          mediaId,
          file: row.file,
          mediaUrl: row.mediaUrl || '',
          products: [],
          action: args.deletePrunedMedia ? 'pending-delete' : 'delete-disabled',
          reason: args.deletePrunedMedia
            ? 'media candidato alla cancellazione dopo prune galleria'
            : 'cancellazione media non richiesta',
        });
      }

      candidatesById.get(mediaId).products.push({
        productId: productReport.product.id,
        productName: productReport.product.name,
        sku: productReport.product.sku,
      });
    }
  }

  const rows = Array.from(candidatesById.values());
  if (!rows.length || !args.deletePrunedMedia) {
    return rows;
  }

  let references;
  try {
    references = await buildMediaReferenceIndex(
      settings,
      new Set(rows.map((row) => row.mediaId)),
      args.apply ? [] : plannedPrunes
    );
  } catch (error) {
    const reason = `scansione referenze non completata: ${error instanceof Error ? error.message : String(error)}`;
    for (const row of rows) {
      row.action = 'skip-delete-reference-scan-error';
      row.reason = reason;
    }
    return rows;
  }

  for (const row of rows) {
    const refs = references.get(row.mediaId) || [];
    row.references = refs;

    if (refs.length > 0) {
      row.action = 'skip-delete-referenced';
      row.reason = 'media ancora referenziato da gallerie o varianti prodotto';
      continue;
    }

    if (!args.apply) {
      row.action = 'would-delete-media';
      row.reason = 'media non referenziato dopo il prune previsto';
      continue;
    }

    try {
      await deleteWordPressMedia(settings.storeUrl, wpCreds, row.mediaId);
      row.action = 'deleted-media';
      row.reason = 'media eliminato dalla Media Library';
    } catch (error) {
      row.action = 'error';
      row.reason = error instanceof Error ? error.message : String(error);
    }
  }

  return rows;
}

async function processProductGroup({ settings, wpCreds, args, sourceFileSet, productId, rows }) {
  const product = await wooRequest(
    settings,
    'GET',
    `products/${productId}?_fields=id,name,sku,permalink,images,attributes`
  );
  const variations = await wooFetchAll(
    settings,
    `products/${productId}/variations?_fields=id,sku,attributes,image`
  );
  const before = buildProductSnapshot(product, variations);
  const productColorways = collectProductColorways(product, variations);
  const existingImages = Array.isArray(product?.images) ? product.images : [];
  const existingPayloadRefs = existingImages.map(imageRefForPayload);
  const invalidExistingImages = existingPayloadRefs.some((image) => !image);
  const importRows = [];
  const appendRefs = [];
  const pruneRows = [];
  const pruneMediaIds = new Set();
  const validRows = rows.filter((decision) => sourceFileSet.has(String(decision?.file || '')));
  const missingRows = rows.filter((decision) => !sourceFileSet.has(String(decision?.file || '')));

  if (invalidExistingImages) {
    throw new Error(`Prodotto ${productId}: una o piu immagini esistenti non hanno id/src, update non sicuro.`);
  }

  for (const decision of rows) {
    const file = String(decision.file || '').trim();
    const sourcePath = path.join(args.sourceDir, file);
    const colorway = resolveDecisionColorway(decision, productColorways);
    const rawColorway = String(decision?.colorway || '').trim();
    const title = buildMediaTitle(before.product.name, { ...decision, file }, colorway);
    const alt = title;
    const row = {
      file,
      sourcePath,
      view: String(decision.view || ''),
      colorway: colorway?.name || rawColorway,
      colorSlug: colorway?.slug || '',
      title,
      alt,
      previousTitle: '',
      previousAlt: '',
      action: 'pending',
      reason: '',
      mediaId: 0,
      mediaUrl: '',
    };

    if (!file) {
      row.action = 'skip';
      row.reason = 'decisione senza file';
      importRows.push(row);
      continue;
    }

    if (!sourceFileSet.has(file)) {
      row.action = 'excluded-missing-source';
      row.reason = 'file non presente nella cartella pulita';
      importRows.push(row);
      continue;
    }

    const galleryMatch = existingImages.find((image) => galleryImageMatchesSource(image, file));
    if (galleryMatch) {
      row.mediaId = Number(galleryMatch?.id || 0);
      row.mediaUrl = String(galleryMatch?.src || '');
      row.previousTitle = String(galleryMatch?.name || '');
      row.previousAlt = String(galleryMatch?.alt || '');

      if (
        row.mediaId > 0 &&
        mediaNeedsMetadataUpdate(row.previousTitle, row.previousAlt, title, alt)
      ) {
        if (!args.apply) {
          row.action = 'would-update-metadata';
          row.reason = 'media gia in galleria, title/alt colore da aggiornare';
          importRows.push(row);
          continue;
        }

        if (!wpCreds) {
          row.action = 'error';
          row.reason = 'credenziali WP mancanti, update metadata non possibile';
          importRows.push(row);
          continue;
        }

        const updatedMedia = await updateWordPressMediaMetadata(
          settings.storeUrl,
          wpCreds,
          row.mediaId,
          title,
          alt
        );
        row.action = 'metadata-updated';
        row.reason = 'media gia in galleria, title/alt colore aggiornati';
        row.mediaUrl = String(updatedMedia?.source_url || row.mediaUrl || '');
        importRows.push(row);
        continue;
      }

      row.action = 'skip-existing-gallery';
      row.reason = 'file gia presente nella galleria prodotto con metadata corretti';
      importRows.push(row);
      continue;
    }

    const existingMedia = await findExistingWordPressMedia(settings.storeUrl, wpCreds, file);
    if (existingMedia) {
      row.action = 'reuse-media';
      row.reason = 'media gia presente in libreria, non ancora in galleria';
      row.mediaId = Number(existingMedia.id || 0);
      row.mediaUrl = String(existingMedia.source_url || '');
      row.previousTitle = titleFromMedia(existingMedia);
      row.previousAlt = String(existingMedia.alt_text || '');
      if (args.apply && mediaNeedsMetadataUpdate(row.previousTitle, row.previousAlt, title, alt)) {
        const updatedMedia = await updateWordPressMediaMetadata(
          settings.storeUrl,
          wpCreds,
          row.mediaId,
          title,
          alt
        );
        row.mediaUrl = String(updatedMedia?.source_url || row.mediaUrl || '');
      }
      row.title = title;
      row.alt = alt;
      appendRefs.push({ id: row.mediaId });
      importRows.push(row);
      continue;
    }

    if (!args.apply) {
      row.action = 'would-upload';
      row.reason = 'nuovo media da caricare e appendere in coda';
      appendRefs.push({ name: title, alt, plannedFile: file });
      importRows.push(row);
      continue;
    }

    if (!wpCreds) {
      row.action = 'error';
      row.reason = 'credenziali WP mancanti, upload non possibile';
      importRows.push(row);
      continue;
    }

    const uploaded = await uploadWordPressMedia(settings.storeUrl, wpCreds, sourcePath, file);
    const uploadedId = Number(uploaded?.id || 0);
    if (uploadedId <= 0) {
      throw new Error(`Upload WP senza media id per ${file}.`);
    }

    const updatedMedia = await updateWordPressMediaMetadata(settings.storeUrl, wpCreds, uploadedId, title, alt);
    row.action = 'uploaded';
    row.reason = 'media caricato e appendato in coda';
    row.mediaId = uploadedId;
    row.mediaUrl = String(updatedMedia?.source_url || uploaded?.source_url || '');
    appendRefs.push({ id: uploadedId });
    importRows.push(row);
  }

  if (args.pruneMissingSource) {
    for (const decision of missingRows) {
      const file = String(decision.file || '').trim();
      if (!file) continue;

      const galleryMatch = existingImages.find((image) => isManagedImportImageForSource(image, file));
      if (!galleryMatch) {
        if (args.deletePrunedMedia && wpCreds) {
          const existingMedia = await findExistingWordPressMedia(settings.storeUrl, wpCreds, file);
          if (existingMedia && isManagedImportMediaForSource(existingMedia, file)) {
            pruneRows.push({
              file,
              sourcePath: path.join(args.sourceDir, file),
              action: 'already-pruned-media',
              reason: 'media gia fuori dalla galleria ma ancora presente in Media Library',
              mediaId: Number(existingMedia.id || 0),
              mediaUrl: String(existingMedia.source_url || ''),
              title: titleFromMedia(existingMedia),
              alt: String(existingMedia.alt_text || ''),
            });
          }
        }
        continue;
      }

      const mediaId = Number(galleryMatch?.id || 0);
      const row = {
        file,
        sourcePath: path.join(args.sourceDir, file),
        action: args.apply ? 'pruned-gallery' : 'would-prune-gallery',
        reason: 'media still life gestito ma file non presente nella cartella pulita',
        mediaId,
        mediaUrl: String(galleryMatch?.src || ''),
        title: String(galleryMatch?.name || ''),
        alt: String(galleryMatch?.alt || ''),
      };

      if (mediaId > 0 && mediaId === Number(before.firstImage?.id || 0)) {
        row.action = 'skip-protected-featured';
        row.reason = 'media corrisponde alla prima immagine prodotto, preservato';
      } else if (mediaId > 0) {
        pruneMediaIds.add(mediaId);
      }

      pruneRows.push(row);
    }
  }

  const keptExistingPayloadRefs = existingImages
    .filter((image) => !pruneMediaIds.has(Number(image?.id || 0)))
    .map(imageRefForPayload);
  const payloadImages = [...keptExistingPayloadRefs, ...appendRefs].filter(Boolean);
  let updatedProduct = null;
  let after = null;
  const appendMediaRefs = appendRefs.filter((ref) => Number(ref?.id || 0) > 0);
  const shouldUpdateProduct = args.apply && (appendMediaRefs.length > 0 || pruneMediaIds.size > 0);

  if (shouldUpdateProduct) {
    updatedProduct = await wooRequest(settings, 'PUT', `products/${productId}`, {
      images: payloadImages
        .filter((image) => !image.plannedFile)
        .map((image) => {
          if (Number(image.id || 0) > 0) {
            return { id: Number(image.id) };
          }
          return image;
        }),
    });

    const afterVariations = await wooFetchAll(
      settings,
      `products/${productId}/variations?_fields=id,sku,attributes,image`
    );
    after = buildProductSnapshot(updatedProduct, afterVariations);
  } else if (args.apply) {
    const refetchedProduct = await wooRequest(
      settings,
      'GET',
      `products/${productId}?_fields=id,name,sku,permalink,images,attributes`
    );
    const afterVariations = await wooFetchAll(
      settings,
      `products/${productId}/variations?_fields=id,sku,attributes,image`
    );
    after = buildProductSnapshot(refetchedProduct, afterVariations);
  }

  const plannedPayloadImages = payloadImages.map((image) => {
    if (Number(image?.id || 0) > 0) return { id: Number(image.id) };
    if (image?.plannedFile) return { upload: image.plannedFile, name: image.name, alt: image.alt };
    return image;
  });

  return {
    product: before.product,
    before,
    after,
    importRows,
    pruneRows,
    desiredSourceFiles: validRows.map((decision) => String(decision.file || '')).filter(Boolean),
    excludedSourceFiles: missingRows.map((decision) => String(decision.file || '')).filter(Boolean),
    plannedPayload: {
      imageCount: plannedPayloadImages.length,
      appendCount: appendRefs.length,
      pruneCount: pruneMediaIds.size,
      images: plannedPayloadImages,
    },
    checks: after
      ? {
          firstImageUnchanged: sameFirstImage(before.images, after.images),
          variationImageIdsUnchanged: sameVariationImageMap(before.variationImageMap, after.variationImageMap),
        }
      : {
          firstImageUnchanged: null,
          variationImageIdsUnchanged: null,
        },
  };
}

function printProductPlan(productReport) {
  const product = productReport.product;
  console.log(`\n[product] ${product.id} | ${product.name} | SKU ${product.sku || '-'}`);
  console.log(`[gallery before] ${productReport.before.galleryCount} immagini`);
  for (const image of productReport.before.images) {
    const label = image.name || image.file || image.src;
    console.log(`  - ${image.id || '-'} | ${label}`);
  }

  console.log('[variation image ids before]');
  for (const variation of productReport.before.variations) {
    const attrs = variation.attributes.map((attribute) => `${attribute.name}: ${attribute.option}`).join(' | ');
    console.log(`  - variation ${variation.id} | image ${variation.imageId || '-'} | ${attrs}`);
  }

  console.log('[files]');
  for (const row of productReport.importRows) {
    const mediaPart = row.mediaId ? ` | media ${row.mediaId}` : '';
    const colorPart = row.colorway ? ` | color ${row.colorway}` : '';
    console.log(`  - ${row.action}${mediaPart}${colorPart} | ${row.file} | ${row.reason}`);
  }

  if ((productReport.pruneRows || []).length) {
    console.log('[prune]');
    for (const row of productReport.pruneRows) {
      const mediaPart = row.mediaId ? ` | media ${row.mediaId}` : '';
      console.log(`  - ${row.action}${mediaPart} | ${row.file} | ${row.reason}`);
    }
  }

  console.log(`[planned payload] ${productReport.plannedPayload.imageCount} immagini totali`);
  console.log(
    productReport.plannedPayload.images
      .map((image) => {
        if (image.id) return `id:${image.id}`;
        if (image.upload) return `upload:${image.upload}`;
        if (image.src) return `src:${image.src}`;
        return 'unknown';
      })
      .join(', ')
  );

  if (productReport.after) {
    console.log(`[gallery after] ${productReport.after.galleryCount} immagini`);
    console.log(`[check] first image invariata: ${productReport.checks.firstImageUnchanged ? 'si' : 'NO'}`);
    console.log(
      `[check] variation.image.id invariati: ${
        productReport.checks.variationImageIdsUnchanged ? 'si' : 'NO'
      }`
    );
  }
}

async function main() {
  const projectRoot = process.cwd();
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  if ((args.productId > 0 && args.allConfirmed) || (args.productId <= 0 && !args.allConfirmed)) {
    printUsage();
    throw new Error('Scegli esattamente uno tra --product-id <id> e --all-confirmed.');
  }

  if (args.deletePrunedMedia && !args.pruneMissingSource) {
    throw new Error('--delete-pruned-media richiede anche --prune-missing-source.');
  }

  if (!fsSync.existsSync(args.sourceDir)) {
    throw new Error(`Cartella still life non trovata: ${args.sourceDir}`);
  }

  const settings = await resolveWooSettings(projectRoot, args);
  const wpCreds = resolveWpCredentials();
  const { source, decisions } = await loadDecisions(projectRoot);
  const sourceFileSet = await readTopLevelImageFiles(args.sourceDir);
  const { eligible, present, missing, productCountAfterIntersection, groups } = groupByProduct(
    decisions,
    args,
    sourceFileSet
  );

  const report = {
    createdAt: new Date().toISOString(),
    mode: {
      apply: args.apply,
      scope: args.productId > 0 ? 'single-product' : 'all-confirmed',
      pruneMissingSource: args.pruneMissingSource,
      deletePrunedMedia: args.deletePrunedMedia,
    },
    sourceDir: args.sourceDir,
    sourceFileCount: sourceFileSet.size,
    decisionSource: source,
    storeUrl: settings.storeUrl,
    configuredStoreUrl: settings.configuredStoreUrl,
    summary: {
      decisionsTotal: decisions.length,
      confirmedWithProductId: eligible.length,
      confirmedPresentInSource: present.length,
      confirmedMissingFromSource: missing.length,
      productCountAfterIntersection,
      products: groups.length,
      uploaded: 0,
      reusedMedia: 0,
      skippedExistingGallery: 0,
      wouldUpdateMetadata: 0,
      metadataUpdated: 0,
      missingSource: 0,
      wouldUpload: 0,
      prunedGallery: 0,
      wouldPruneGallery: 0,
      alreadyPrunedMedia: 0,
      deletedMedia: 0,
      wouldDeleteMedia: 0,
      skippedReferencedMediaDelete: 0,
      skippedReferenceScanError: 0,
      errors: 0,
    },
    rules: {
      statusFilter: 'confirmed',
      requiresProductId: true,
      excludedStatuses: ['multi', 'bucket'],
      sourceAllowlist: 'top-level image files only',
      updatesOnly: ['product.images', 'wp_media.title', 'wp_media.alt_text'],
      variationWrites: false,
      colorwayUsedForMediaMetadata: true,
      colorwayUsedInProductImagesPayload: false,
    },
    products: [],
    mediaDeleteRows: [],
    reportPaths: null,
  };

  console.log(`[mode] ${args.apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`[decisions] ${source}`);
  console.log(`[scope] ${args.productId > 0 ? `product ${args.productId}` : 'all confirmed products'}`);
  console.log(`[source] ${sourceFileSet.size} immagini nel livello principale della cartella pulita`);
  console.log(
    `[eligible] ${eligible.length} foto confirmed con productId, ${present.length} presenti, ${missing.length} escluse, ${productCountAfterIntersection} prodotti validi`
  );

  if (!groups.length) {
    throw new Error('Nessuna decisione confirmed con productId e file presente nella cartella pulita nello scope richiesto.');
  }

  if (args.apply && !wpCreds) {
    throw new Error('Credenziali WP mancanti (WP_USERNAME/WP_USER_EMAIL + WP_APP_PASSWORD), apply non possibile.');
  }

  for (const group of groups) {
    try {
      const productReport = await processProductGroup({
        settings,
        wpCreds,
        args,
        sourceFileSet,
        productId: group.productId,
        rows: group.rows,
      });

      report.products.push(productReport);
      for (const row of productReport.importRows) {
        if (row.action === 'uploaded') report.summary.uploaded += 1;
        if (row.action === 'reuse-media') report.summary.reusedMedia += 1;
        if (row.action === 'skip-existing-gallery') report.summary.skippedExistingGallery += 1;
        if (row.action === 'would-update-metadata') report.summary.wouldUpdateMetadata += 1;
        if (row.action === 'metadata-updated') report.summary.metadataUpdated += 1;
        if (row.action === 'missing-source') report.summary.missingSource += 1;
        if (row.action === 'excluded-missing-source') report.summary.missingSource += 1;
        if (row.action === 'would-upload') report.summary.wouldUpload += 1;
        if (row.action === 'error') report.summary.errors += 1;
      }
      for (const row of productReport.pruneRows || []) {
        if (row.action === 'pruned-gallery') report.summary.prunedGallery += 1;
        if (row.action === 'would-prune-gallery') report.summary.wouldPruneGallery += 1;
        if (row.action === 'already-pruned-media') report.summary.alreadyPrunedMedia += 1;
        if (row.action === 'error') report.summary.errors += 1;
      }

      printProductPlan(productReport);
    } catch (error) {
      report.summary.errors += 1;
      report.products.push({
        product: { id: group.productId, name: '', sku: '', permalink: '' },
        error: error instanceof Error ? error.message : String(error),
        importRows: [],
      });
      console.error(`[error] product ${group.productId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  report.mediaDeleteRows = await planOrDeletePrunedMedia({
    settings,
    wpCreds,
    args,
    productReports: report.products,
  });

  if (report.mediaDeleteRows.length) {
    console.log('\n[media delete]');
    for (const row of report.mediaDeleteRows) {
      console.log(`  - ${row.action} | media ${row.mediaId} | ${row.file || '-'} | ${row.reason}`);
    }
  }

  for (const row of report.mediaDeleteRows) {
    if (row.action === 'deleted-media') report.summary.deletedMedia += 1;
    if (row.action === 'would-delete-media') report.summary.wouldDeleteMedia += 1;
    if (row.action === 'skip-delete-referenced') report.summary.skippedReferencedMediaDelete += 1;
    if (row.action === 'skip-delete-reference-scan-error') report.summary.skippedReferenceScanError += 1;
    if (row.action === 'error') report.summary.errors += 1;
  }

  const reportPaths = await saveReports(report, args.reportDir);
  report.reportPaths = reportPaths;
  await fs.writeFile(reportPaths.jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(reportPaths.latestJsonPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n[summary]');
  console.log(`  uploaded: ${report.summary.uploaded}`);
  console.log(`  reused media: ${report.summary.reusedMedia}`);
  console.log(`  already in gallery: ${report.summary.skippedExistingGallery}`);
  console.log(`  would update metadata: ${report.summary.wouldUpdateMetadata}`);
  console.log(`  metadata updated: ${report.summary.metadataUpdated}`);
  console.log(`  missing source: ${report.summary.missingSource}`);
  console.log(`  would upload: ${report.summary.wouldUpload}`);
  console.log(`  pruned gallery: ${report.summary.prunedGallery}`);
  console.log(`  would prune gallery: ${report.summary.wouldPruneGallery}`);
  console.log(`  already pruned media: ${report.summary.alreadyPrunedMedia}`);
  console.log(`  deleted media: ${report.summary.deletedMedia}`);
  console.log(`  would delete media: ${report.summary.wouldDeleteMedia}`);
  console.log(`  skipped referenced media delete: ${report.summary.skippedReferencedMediaDelete}`);
  console.log(`  skipped reference scan error: ${report.summary.skippedReferenceScanError}`);
  console.log(`  errors: ${report.summary.errors}`);
  console.log(`[report] ${reportPaths.jsonPath}`);
  console.log(`[report csv] ${reportPaths.csvPath}`);

  if (report.summary.errors > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[fatal] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
