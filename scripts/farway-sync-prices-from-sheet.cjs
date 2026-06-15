const fs = require('fs');
const path = require('path');

const SHEET_RANGE = 'A1:H1000';

function readEnvFile(filePath) {
  const env = {};
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

function nowCompact() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function parsePrice(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const raw = s.replace(/[^0-9,.-]/g, '');
  const hasComma = raw.includes(',');
  const hasDot = raw.includes('.');
  let cleaned = raw;

  if (hasComma && hasDot) {
    // Italian-like format: 1.234,56
    cleaned = raw.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    // Decimal comma: 123,45
    cleaned = raw.replace(',', '.');
  } else {
    // Decimal dot or integer: 123.45 / 123
    cleaned = raw;
  }

  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n;
}

async function googleRequest(token, url, options = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    ...(options.headers || {})
  };
  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error(`Google ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

async function wooRequest(env, endpoint, options = {}) {
  const base = env.WC_STORE_URL.replace(/\/$/, '');
  const auth = `consumer_key=${env.WC_CONSUMER_KEY}&consumer_secret=${env.WC_CONSUMER_SECRET}`;
  const glue = endpoint.includes('?') ? '&' : '?';
  const url = `${base}${endpoint}${glue}${auth}`;

  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`Woo ${response.status} ${endpoint}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }

  return data;
}

async function getProductVariations(env, productId) {
  const all = [];
  let page = 1;
  while (true) {
    const batch = await wooRequest(env, `/wp-json/wc/v3/products/${productId}/variations?per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return all;
}

function writeCsv(filePath, rows) {
  const headers = [
    'product_id',
    'product_name',
    'type',
    'variation_id',
    'variation_attrs',
    'before_regular_price',
    'before_sale_price',
    'before_effective_price',
    'after_regular_price',
    'after_sale_price',
    'status',
    'note'
  ];

  const esc = (v) => {
    const s = String(v ?? '');
    if (s.includes('"') || s.includes(',') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => esc(row[h])).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const env = readEnvFile(path.join(process.cwd(), '.env.local'));
  if (!env.WC_STORE_URL || !env.WC_CONSUMER_KEY || !env.WC_CONSUMER_SECRET) {
    throw new Error('Configurazione WooCommerce incompleta in .env.local');
  }

  const googleAuthUtilsPath = env.GOOGLE_AUTH_UTILS_PATH || process.env.GOOGLE_AUTH_UTILS_PATH;
  const spreadsheetId = env.FARWAY_PRICES_SHEET_ID || process.env.FARWAY_PRICES_SHEET_ID;
  if (!googleAuthUtilsPath) throw new Error('GOOGLE_AUTH_UTILS_PATH mancante (impostalo in .env.local)');
  if (!spreadsheetId) throw new Error('FARWAY_PRICES_SHEET_ID mancante (impostalo in .env.local)');

  const { OAuthCredentialStorage } = require(googleAuthUtilsPath);
  const creds = await OAuthCredentialStorage.loadCredentials();
  const token = creds?.access_token;
  if (!token) throw new Error('Token Google non disponibile');

  const sheet = await googleRequest(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(SHEET_RANGE)}`
  );

  const values = Array.isArray(sheet.values) ? sheet.values : [];
  if (!values.length) throw new Error('Spreadsheet vuoto');

  const header = values[0].map((h) => String(h || '').trim());
  const idIdx = header.findIndex((h) => h.toLowerCase() === 'id');
  const priceIdx = header.findIndex((h) => h.toLowerCase().includes('prezzo attuale'));
  const nameIdx = header.findIndex((h) => h.toLowerCase() === 'prodotto');

  if (idIdx === -1 || priceIdx === -1) {
    throw new Error(`Header non valido. Colonne trovate: ${header.join(' | ')}`);
  }

  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    const row = values[i];
    const rawId = String(row[idIdx] || '').trim();
    const rawPrice = String(row[priceIdx] || '').trim();
    const rawName = String(row[nameIdx] || '').trim();

    if (!rawId && !rawPrice && !rawName) continue;

    const productId = Number.parseInt(rawId, 10);
    const targetPrice = parsePrice(rawPrice);

    rows.push({
      sheetRow: i + 1,
      productId: Number.isFinite(productId) ? productId : null,
      productNameFromSheet: rawName,
      rawPrice,
      targetPrice
    });
  }

  const logRows = [];
  const summary = {
    dryRun,
    spreadsheetId,
    totalRowsRead: rows.length,
    validRows: 0,
    updatedItems: 0,
    skippedRows: 0,
    skipped: []
  };

  for (const row of rows) {
    if (!row.productId) {
      summary.skippedRows += 1;
      summary.skipped.push({ row: row.sheetRow, reason: 'ID non valido', product: row.productNameFromSheet });
      continue;
    }
    if (row.targetPrice === null) {
      summary.skippedRows += 1;
      summary.skipped.push({ row: row.sheetRow, reason: 'Prezzo vuoto/non numerico', product: row.productNameFromSheet, id: row.productId });
      continue;
    }

    summary.validRows += 1;

    const product = await wooRequest(env, `/wp-json/wc/v3/products/${row.productId}`);
    const target = String(row.targetPrice);

    if (product.type === 'variable') {
      const variations = await getProductVariations(env, row.productId);
      if (variations.length === 0) {
        if (!dryRun) {
          await wooRequest(env, `/wp-json/wc/v3/products/${row.productId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ regular_price: target, sale_price: '' })
          });
        }

        summary.updatedItems += 1;
        logRows.push({
          product_id: row.productId,
          product_name: product.name,
          type: 'variable-no-variations',
          variation_id: '',
          variation_attrs: '',
          before_regular_price: product.regular_price ?? '',
          before_sale_price: product.sale_price ?? '',
          before_effective_price: product.price ?? '',
          after_regular_price: target,
          after_sale_price: '',
          status: dryRun ? 'dry-run' : 'updated',
          note: `sheet_row_${row.sheetRow}`
        });
        continue;
      }

      for (const variation of variations) {
        const attrs = (variation.attributes || [])
          .map((a) => `${a.name || a.slug}:${a.option}`)
          .join(' | ');

        if (!dryRun) {
          await wooRequest(env, `/wp-json/wc/v3/products/${row.productId}/variations/${variation.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ regular_price: target, sale_price: '' })
          });
        }

        summary.updatedItems += 1;
        logRows.push({
          product_id: row.productId,
          product_name: product.name,
          type: 'variable',
          variation_id: variation.id,
          variation_attrs: attrs,
          before_regular_price: variation.regular_price ?? '',
          before_sale_price: variation.sale_price ?? '',
          before_effective_price: variation.price ?? '',
          after_regular_price: target,
          after_sale_price: '',
          status: dryRun ? 'dry-run' : 'updated',
          note: `sheet_row_${row.sheetRow}`
        });
      }
    } else {
      if (!dryRun) {
        await wooRequest(env, `/wp-json/wc/v3/products/${row.productId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ regular_price: target, sale_price: '' })
        });
      }

      summary.updatedItems += 1;
      logRows.push({
        product_id: row.productId,
        product_name: product.name,
        type: product.type,
        variation_id: '',
        variation_attrs: '',
        before_regular_price: product.regular_price ?? '',
        before_sale_price: product.sale_price ?? '',
        before_effective_price: product.price ?? '',
        after_regular_price: target,
        after_sale_price: '',
        status: dryRun ? 'dry-run' : 'updated',
        note: `sheet_row_${row.sheetRow}`
      });
    }
  }

  const stamp = nowCompact();
  const mode = dryRun ? 'dryrun' : 'live';
  const outJson = path.join(process.cwd(), 'data', `farway-sheet-price-sync-summary-${mode}-${stamp}.json`);
  const outCsv = path.join(process.cwd(), 'data', `farway-sheet-price-sync-report-${mode}-${stamp}.csv`);

  fs.writeFileSync(outJson, JSON.stringify(summary, null, 2), 'utf8');
  writeCsv(outCsv, logRows);

  console.log(JSON.stringify({ summary, outJson, outCsv }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
