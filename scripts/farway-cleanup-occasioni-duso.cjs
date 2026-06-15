#!/usr/bin/env node
'use strict';

/**
 * Cleans Farway WooCommerce ACF `occasione_duso` from live gallery evidence.
 *
 * Source of truth:
 * - WooCommerce REST API live products, statuses publish + draft by default.
 * - Canonical occasion values from ../lib/farway-occasions.ts.
 *
 * Default mode is dry-run. Apply requires:
 *   --apply --confirm FARWAY_OCCASIONI_DUSO_CLEANUP_APPROVED
 */

const fs = require('fs/promises');
const path = require('path');
const vm = require('vm');

const APPLY_CONFIRMATION = 'FARWAY_OCCASIONI_DUSO_CLEANUP_APPROVED';
const DEFAULT_STATUSES = ['publish', 'draft'];
const WC_API_TIMEOUT_MS = 60000;
const WC_WRITE_DELAY_MS = 150;

function parseArgs(argv) {
  const args = {
    apply: false,
    confirm: '',
    outputDir: '',
    statuses: DEFAULT_STATUSES,
    limitProducts: 0,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || '');

    if (value === '--apply') {
      args.apply = true;
      continue;
    }

    if (value === '--confirm') {
      args.confirm = String(argv[index + 1] || '');
      index += 1;
      continue;
    }

    if (value === '--output-dir') {
      args.outputDir = String(argv[index + 1] || '');
      index += 1;
      continue;
    }

    if (value === '--statuses') {
      args.statuses = String(argv[index + 1] || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }

    if (value === '--limit-products') {
      const parsed = Number(argv[index + 1] || 0);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.limitProducts = Math.round(parsed);
      }
      index += 1;
      continue;
    }
  }

  if (args.apply && args.confirm !== APPLY_CONFIRMATION) {
    throw new Error(`Apply bloccato: usa --confirm ${APPLY_CONFIRMATION}`);
  }

  if (!args.statuses.length) {
    throw new Error('Nessuno status prodotto selezionato.');
  }

  return args;
}

function nowCompact() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    // Optional local env file.
  }
}

async function resolveWooSettings(projectRoot) {
  const envPath = path.join(projectRoot, '.env.local');
  await loadEnvFile(envPath);

  const storeUrl = String(process.env.WC_STORE_URL || '').trim().replace(/\/$/, '');
  const consumerKey = String(process.env.WC_CONSUMER_KEY || '').trim();
  const consumerSecret = String(process.env.WC_CONSUMER_SECRET || '').trim();

  if (!storeUrl || !consumerKey || !consumerSecret) {
    throw new Error(`Credenziali WooCommerce mancanti in ${envPath}`);
  }

  return { storeUrl, consumerKey, consumerSecret };
}

async function fetchWithTimeout(url, init = {}, timeoutMs = WC_API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildWooUrl(settings, endpoint) {
  const url = new URL(`${settings.storeUrl}/wp-json/wc/v3/${endpoint.replace(/^\//, '')}`);
  url.searchParams.set('consumer_key', settings.consumerKey);
  url.searchParams.set('consumer_secret', settings.consumerSecret);
  return url;
}

async function wooRequest(settings, method, endpoint, body) {
  const response = await fetchWithTimeout(buildWooUrl(settings, endpoint), {
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
    throw new Error(`Woo ${method} ${endpoint} -> HTTP ${response.status}: ${String(text).slice(0, 400)}`);
  }

  return data;
}

async function wooFetchAll(settings, endpoint, params = {}) {
  const all = [];
  let page = 1;

  while (true) {
    const url = buildWooUrl(settings, endpoint);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    const response = await fetchWithTimeout(url);
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!response.ok) {
      throw new Error(`Woo GET ${endpoint} -> HTTP ${response.status}: ${String(text).slice(0, 400)}`);
    }

    if (!Array.isArray(data)) {
      throw new Error(`Risposta Woo inattesa per ${endpoint}`);
    }

    all.push(...data);
    if (data.length < 100) break;
    page += 1;
  }

  return all;
}

async function loadCanonicalOccasionConfig(projectRoot) {
  const tsPath = path.join(projectRoot, 'lib', 'farway-occasions.ts');
  const source = await fs.readFile(tsPath, 'utf8');
  const ts = require(path.join(projectRoot, 'node_modules', 'typescript'));

  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
    },
  }).outputText;

  const moduleState = { exports: {} };
  vm.runInNewContext(
    compiled,
    {
      module: moduleState,
      exports: moduleState.exports,
      require,
    },
    { filename: tsPath }
  );

  const config = moduleState.exports;

  if (
    config.farwayOccasionDusoFieldName !== 'occasione_duso' ||
    !config.farwayOccasionDusoFieldKey ||
    !Array.isArray(config.farwayOccasionDusoChoices)
  ) {
    throw new Error(`Config occasioni non valida in ${tsPath}`);
  }

  return {
    fieldName: config.farwayOccasionDusoFieldName,
    fieldKey: config.farwayOccasionDusoFieldKey,
    choices: config.farwayOccasionDusoChoices,
  };
}

function normalizeSearchToken(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildOccasionSearchIndex(choices) {
  return choices.map((choice) => {
    const labels = [choice.value, choice.label, ...(choice.aliases || [])]
      .map((item) => normalizeSearchToken(item))
      .filter(Boolean);

    return {
      value: choice.value,
      label: choice.label,
      tokens: Array.from(new Set(labels)),
    };
  });
}

function getImageBasename(src) {
  const raw = String(src || '');
  if (!raw) return '';

  try {
    const pathname = new URL(raw).pathname;
    return decodeURIComponent(pathname.split('/').pop() || '');
  } catch {
    return raw.split(/[\\/]/).pop() || raw;
  }
}

function inferOccasionValuesFromImages(images, searchIndex) {
  const searchableText = (images || [])
    .flatMap((image) => [
      image && image.name,
      image && image.alt,
      image && image.src,
      image && getImageBasename(image.src),
    ])
    .filter(Boolean)
    .join('\n');

  const normalized = normalizeSearchToken(searchableText);

  return searchIndex
    .filter((entry) => entry.tokens.some((token) => token && normalized.includes(token)))
    .map((entry) => entry.value);
}

function normalizeMetaArrayValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }

  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }

  return [];
}

function getMetaEntry(product, key) {
  return (product.meta_data || []).find((meta) => meta && meta.key === key) || null;
}

function normalizeSelectedValues(product, canonicalValues, fieldName) {
  const rawValues = normalizeMetaArrayValue(getMetaEntry(product, fieldName)?.value);
  const known = [];
  const unknown = [];

  for (const value of rawValues) {
    if (canonicalValues.has(value)) {
      if (!known.includes(value)) known.push(value);
    } else if (!unknown.includes(value)) {
      unknown.push(value);
    }
  }

  return { rawValues, known, unknown };
}

function sameArray(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function buildMetaPayload(product, fieldName, fieldKey, desiredValues) {
  const publicEntry = getMetaEntry(product, fieldName);
  const privateEntry = getMetaEntry(product, `_${fieldName}`);
  const existingFieldKey = privateEntry && privateEntry.value ? String(privateEntry.value) : fieldKey;

  return [
    publicEntry && typeof publicEntry.id === 'number'
      ? { id: publicEntry.id, key: fieldName, value: desiredValues }
      : { key: fieldName, value: desiredValues },
    privateEntry && typeof privateEntry.id === 'number'
      ? { id: privateEntry.id, key: `_${fieldName}`, value: existingFieldKey }
      : { key: `_${fieldName}`, value: existingFieldKey },
  ];
}

async function fetchProducts(settings, statuses) {
  const fields = [
    'id',
    'name',
    'slug',
    'status',
    'type',
    'sku',
    'permalink',
    'images',
    'meta_data',
  ].join(',');

  const all = [];

  for (const status of statuses) {
    console.log(`[fetch] prodotti status=${status}`);
    const products = await wooFetchAll(settings, 'products', {
      status,
      _fields: fields,
    });
    all.push(...products);
    console.log(`        ${products.length} prodotti`);
  }

  return all;
}

function buildPlan(products, config, args) {
  const searchIndex = buildOccasionSearchIndex(config.choices);
  const canonicalValues = new Set(config.choices.map((choice) => choice.value));
  const choiceLabelByValue = new Map(config.choices.map((choice) => [choice.value, choice.label]));

  const rows = products.map((product) => {
    const selected = normalizeSelectedValues(product, canonicalValues, config.fieldName);
    const inferred = inferOccasionValuesFromImages(product.images || [], searchIndex);
    const changed =
      selected.unknown.length > 0 ||
      !sameArray(selected.known, inferred);

    return {
      product_id: product.id,
      name: product.name || '',
      slug: product.slug || '',
      status: product.status || '',
      type: product.type || '',
      sku: product.sku || '',
      permalink: product.permalink || '',
      image_count: Array.isArray(product.images) ? product.images.length : 0,
      current_values: selected.known,
      current_unknown_values: selected.unknown,
      desired_values: inferred,
      current_labels: selected.known.map((value) => choiceLabelByValue.get(value) || value),
      desired_labels: inferred.map((value) => choiceLabelByValue.get(value) || value),
      remove_values: selected.known.filter((value) => !inferred.includes(value)),
      add_values: inferred.filter((value) => !selected.known.includes(value)),
      would_clear: selected.known.length + selected.unknown.length > 0 && inferred.length === 0,
      would_set_non_empty: inferred.length > 0 && changed,
      changed,
    };
  });

  const plan = args.limitProducts > 0 ? rows.slice(0, args.limitProducts) : rows;
  return { plan, rows };
}

function summarize(rows) {
  const byStatus = {};

  for (const row of rows) {
    if (!byStatus[row.status]) {
      byStatus[row.status] = {
        total: 0,
        changed: 0,
        would_clear: 0,
        would_set_non_empty: 0,
        unchanged: 0,
      };
    }

    byStatus[row.status].total += 1;
    if (row.changed) byStatus[row.status].changed += 1;
    if (row.would_clear) byStatus[row.status].would_clear += 1;
    if (row.would_set_non_empty) byStatus[row.status].would_set_non_empty += 1;
    if (!row.changed) byStatus[row.status].unchanged += 1;
  }

  return {
    total_products: rows.length,
    changed_products: rows.filter((row) => row.changed).length,
    would_clear_products: rows.filter((row) => row.would_clear).length,
    would_set_non_empty_products: rows.filter((row) => row.would_set_non_empty).length,
    products_with_unknown_current_values: rows.filter((row) => row.current_unknown_values.length > 0).length,
    by_status: byStatus,
  };
}

function escapeMd(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function valuesForReport(values) {
  return values.length ? values.map((value) => `\`${value}\``).join(', ') : '_vuoto_';
}

async function writeRunFiles(outputDir, products, plan, summary, config, args) {
  await fs.mkdir(outputDir, { recursive: true });

  await fs.writeFile(
    path.join(outputDir, 'backup-products-pre-cleanup.json'),
    JSON.stringify(products, null, 2),
    'utf8'
  );
  await fs.writeFile(path.join(outputDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
  await fs.writeFile(
    path.join(outputDir, 'summary.json'),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        mode: args.apply ? 'apply' : 'dry-run',
        statuses: args.statuses,
        field_name: config.fieldName,
        field_key: config.fieldKey,
        occasion_values: config.choices.map((choice) => choice.value),
        summary,
      },
      null,
      2
    ),
    'utf8'
  );

  const changedRows = plan.filter((row) => row.changed);
  const lines = [
    '# Farway - Bonifica occasioni d uso WooCommerce',
    '',
    `- Generato: ${new Date().toISOString()}`,
    `- Modalita: ${args.apply ? 'apply' : 'dry-run'}`,
    `- Scope status: ${args.statuses.join(', ')}`,
    `- Campo: \`${config.fieldName}\` / \`${config.fieldKey}\``,
    `- Prodotti letti: ${summary.total_products}`,
    `- Prodotti da cambiare: ${summary.changed_products}`,
    `- Prodotti da svuotare: ${summary.would_clear_products}`,
    `- Prodotti da impostare non-vuoti: ${summary.would_set_non_empty_products}`,
    '',
    '## Breakdown per status',
    '',
    '| Status | Totale | Cambiano | Svuotati | Non vuoti | Invariati |',
    '|---|---:|---:|---:|---:|---:|',
  ];

  for (const [status, data] of Object.entries(summary.by_status)) {
    lines.push(
      `| ${escapeMd(status)} | ${data.total} | ${data.changed} | ${data.would_clear} | ${data.would_set_non_empty} | ${data.unchanged} |`
    );
  }

  lines.push('', '## Prime differenze', '');
  lines.push('| ID | Status | SKU | Nome | Attuale | Desiderato | Remove | Add |');
  lines.push('|---:|---|---|---|---|---|---|---|');

  for (const row of changedRows.slice(0, 80)) {
    lines.push(
      `| ${row.product_id} | ${escapeMd(row.status)} | ${escapeMd(row.sku)} | ${escapeMd(row.name)} | ${escapeMd(valuesForReport([...row.current_values, ...row.current_unknown_values]))} | ${escapeMd(valuesForReport(row.desired_values))} | ${escapeMd(valuesForReport(row.remove_values))} | ${escapeMd(valuesForReport(row.add_values))} |`
    );
  }

  await fs.writeFile(path.join(outputDir, 'report.md'), lines.join('\n'), 'utf8');
}

async function applyPlan(settings, outputDir, products, plan, config) {
  const productById = new Map(products.map((product) => [product.id, product]));
  const changedRows = plan.filter((row) => row.changed);
  const applied = {
    started_at: new Date().toISOString(),
    field_name: config.fieldName,
    field_key: config.fieldKey,
    total_planned: changedRows.length,
    updated: [],
    failures: [],
  };

  let index = 0;
  for (const row of changedRows) {
    index += 1;
    const product = productById.get(row.product_id);
    if (!product) {
      applied.failures.push({ product_id: row.product_id, error: 'Prodotto non trovato nel backup runtime' });
      continue;
    }

    const payload = {
      meta_data: buildMetaPayload(product, config.fieldName, config.fieldKey, row.desired_values),
    };

    console.log(
      `[apply] ${index}/${changedRows.length} #${row.product_id} ${row.name} -> ${row.desired_values.join(',') || '[]'}`
    );

    try {
      const updatedProduct = await wooRequest(settings, 'PUT', `products/${row.product_id}`, payload);
      applied.updated.push({
        product_id: row.product_id,
        name: row.name,
        status: row.status,
        sku: row.sku,
        previous_values: row.current_values,
        previous_unknown_values: row.current_unknown_values,
        desired_values: row.desired_values,
        response_status: updatedProduct && updatedProduct.status,
      });
      await sleep(WC_WRITE_DELAY_MS);
    } catch (error) {
      console.error(`        FALLITO: ${error.message}`);
      applied.failures.push({
        product_id: row.product_id,
        name: row.name,
        error: error.message,
      });
    }
  }

  applied.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(outputDir, 'applied-summary.json'), JSON.stringify(applied, null, 2), 'utf8');
  return applied;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = path.resolve(__dirname, '..');
  const outputDir = args.outputDir
    ? path.resolve(args.outputDir)
    : path.join(projectRoot, '_local', `farway-occasioni-duso-cleanup-${nowCompact()}`);

  const settings = await resolveWooSettings(projectRoot);
  const config = await loadCanonicalOccasionConfig(projectRoot);

  console.log('[config]');
  console.log(`  store: ${settings.storeUrl}`);
  console.log(`  field: ${config.fieldName} (${config.fieldKey})`);
  console.log(`  occasioni: ${config.choices.length}`);
  console.log(`  output: ${outputDir}`);

  const products = await fetchProducts(settings, args.statuses);
  const scopedProducts = args.limitProducts > 0 ? products.slice(0, args.limitProducts) : products;
  const { plan } = buildPlan(scopedProducts, config, args);
  const summary = summarize(plan);

  await writeRunFiles(outputDir, scopedProducts, plan, summary, config, args);

  console.log('[summary]');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`  backup: ${path.join(outputDir, 'backup-products-pre-cleanup.json')}`);
  console.log(`  plan:   ${path.join(outputDir, 'plan.json')}`);
  console.log(`  report: ${path.join(outputDir, 'report.md')}`);

  if (!args.apply) {
    console.log('');
    console.log('[ok] Dry-run completato. Nessuna scrittura effettuata.');
    console.log(`     Apply: node scripts/farway-cleanup-occasioni-duso.cjs --apply --confirm ${APPLY_CONFIRMATION} --output-dir "${outputDir}"`);
    return;
  }

  const applied = await applyPlan(settings, outputDir, scopedProducts, plan, config);
  console.log('');
  console.log(`[ok] Apply completato: ${applied.updated.length} aggiornati, ${applied.failures.length} falliti.`);
  console.log(`     Riepilogo: ${path.join(outputDir, 'applied-summary.json')}`);

  if (applied.failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('');
  console.error('[ERRORE FATALE]', error.message);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
