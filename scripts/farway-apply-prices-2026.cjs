const fs = require('fs');
const path = require('path');

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

function parseLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        q = !q;
      }
    } else if (ch === ',' && !q) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(filePath) {
  const lines = fs
    .readFileSync(filePath, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  const header = parseLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cols = parseLine(line);
    const obj = {};
    for (let i = 0; i < header.length; i += 1) obj[header[i]] = cols[i] ?? '';
    return obj;
  });
  return rows;
}

function parseIds(pipeText) {
  return String(pipeText || '')
    .split('|')
    .map((x) => Number.parseInt(x.trim(), 10))
    .filter((x) => Number.isFinite(x));
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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

async function getProduct(env, productId) {
  return wooRequest(env, `/wp-json/wc/v3/products/${productId}`);
}

async function getProductVariations(env, productId) {
  const all = [];
  let page = 1;
  while (true) {
    const batch = await wooRequest(
      env,
      `/wp-json/wc/v3/products/${productId}/variations?per_page=100&page=${page}`
    );
    all.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return all;
}

function attrMatch(variation, attrKey, attrValue) {
  const keyNeedle = normalize(attrKey);
  const valueNeedle = normalize(attrValue);
  for (const attr of variation.attributes || []) {
    const k1 = normalize(attr.name || '');
    const k2 = normalize(attr.slug || '');
    const v = normalize(attr.option || '');
    if ((k1.includes(keyNeedle) || k2.includes(keyNeedle)) && v === valueNeedle) return true;
  }
  return false;
}

async function updateSimpleProductPrice(env, productId, targetPrice, dryRun, logRows) {
  const product = await getProduct(env, productId);
  const before = {
    regular_price: product.regular_price,
    sale_price: product.sale_price,
    price: product.price
  };

  if (!dryRun) {
    await wooRequest(env, `/wp-json/wc/v3/products/${productId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regular_price: String(targetPrice), sale_price: '' })
    });
  }

  logRows.push({
    scope: 'simple',
    product_id: productId,
    product_name: product.name,
    variation_id: '',
    variation_attrs: '',
    before_regular_price: before.regular_price ?? '',
    before_sale_price: before.sale_price ?? '',
    before_effective_price: before.price ?? '',
    after_regular_price: String(targetPrice),
    after_sale_price: '',
    action: dryRun ? 'dry-run' : 'updated'
  });

  return { touched: 1, updated: dryRun ? 0 : 1 };
}

async function updateAllVariationsPrice(env, productId, targetPrice, dryRun, logRows) {
  const product = await getProduct(env, productId);
  if (product.type !== 'variable') {
    return updateSimpleProductPrice(env, productId, targetPrice, dryRun, logRows);
  }

  const variations = await getProductVariations(env, productId);
  let updated = 0;
  for (const variation of variations) {
    const attrs = (variation.attributes || [])
      .map((a) => `${a.name || a.slug}:${a.option}`)
      .join(' | ');

    if (!dryRun) {
      await wooRequest(env, `/wp-json/wc/v3/products/${productId}/variations/${variation.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regular_price: String(targetPrice), sale_price: '' })
      });
      updated += 1;
    }

    logRows.push({
      scope: 'variation-all',
      product_id: productId,
      product_name: product.name,
      variation_id: variation.id,
      variation_attrs: attrs,
      before_regular_price: variation.regular_price ?? '',
      before_sale_price: variation.sale_price ?? '',
      before_effective_price: variation.price ?? '',
      after_regular_price: String(targetPrice),
      after_sale_price: '',
      action: dryRun ? 'dry-run' : 'updated'
    });
  }

  return { touched: variations.length, updated };
}

async function updateVariationsByAttribute(env, productId, attrKey, attrValue, targetPrice, dryRun, logRows) {
  const product = await getProduct(env, productId);
  if (product.type !== 'variable') {
    return { touched: 0, updated: 0, skipped: 1 };
  }

  const variations = await getProductVariations(env, productId);
  let touched = 0;
  let updated = 0;

  for (const variation of variations) {
    if (!attrMatch(variation, attrKey, attrValue)) continue;
    touched += 1;
    const attrs = (variation.attributes || [])
      .map((a) => `${a.name || a.slug}:${a.option}`)
      .join(' | ');

    if (!dryRun) {
      await wooRequest(env, `/wp-json/wc/v3/products/${productId}/variations/${variation.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regular_price: String(targetPrice), sale_price: '' })
      });
      updated += 1;
    }

    logRows.push({
      scope: `variation-filter:${attrKey}=${attrValue}`,
      product_id: productId,
      product_name: product.name,
      variation_id: variation.id,
      variation_attrs: attrs,
      before_regular_price: variation.regular_price ?? '',
      before_sale_price: variation.sale_price ?? '',
      before_effective_price: variation.price ?? '',
      after_regular_price: String(targetPrice),
      after_sale_price: '',
      action: dryRun ? 'dry-run' : 'updated'
    });
  }

  return { touched, updated };
}

function writeCsv(filePath, rows) {
  const headers = [
    'row',
    'csv_name',
    'match_type',
    'target_price',
    'scope',
    'product_id',
    'product_name',
    'variation_id',
    'variation_attrs',
    'before_regular_price',
    'before_sale_price',
    'before_effective_price',
    'after_regular_price',
    'after_sale_price',
    'action',
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

  const proposalPath = path.join(process.cwd(), 'data', 'farway-price-2026-match-proposal.csv');
  const rows = parseCsv(proposalPath).sort((a, b) => Number(a.row) - Number(b.row));

  const opLogs = [];
  const summary = {
    dryRun,
    processedRows: 0,
    touchedItems: 0,
    updatedItems: 0,
    skippedRows: 0,
    skippedDetails: []
  };

  for (const row of rows) {
    summary.processedRows += 1;
    const rowNum = Number.parseInt(row.row, 10);
    const matchType = row.match_type;
    const csvName = row.csv_name;
    const ids = parseIds(row.matched_product_ids);
    const target = Number.parseInt(row.target_price_ceil, 10);

    if (!Number.isFinite(target)) {
      summary.skippedRows += 1;
      summary.skippedDetails.push({ row: rowNum, csvName, reason: 'target_price non valido' });
      continue;
    }

    if (!ids.length) {
      summary.skippedRows += 1;
      summary.skippedDetails.push({ row: rowNum, csvName, reason: 'nessun product_id nel mapping' });
      continue;
    }

    const pushNote = (base, note = '') => `${base}${note ? ` | ${note}` : ''}`;

    if (matchType === 'exact' || matchType === 'proposed_high' || matchType === 'proposed_medium') {
      for (const id of ids) {
        const res = await updateAllVariationsPrice(env, id, target, dryRun, opLogs);
        summary.touchedItems += res.touched;
        summary.updatedItems += res.updated;
        if (opLogs.length > 0) {
          const start = opLogs.length - res.touched;
          for (let i = start; i < opLogs.length; i += 1) {
            opLogs[i].row = rowNum;
            opLogs[i].csv_name = csvName;
            opLogs[i].match_type = matchType;
            opLogs[i].target_price = target;
            opLogs[i].note = pushNote('update-all-variations', row.note);
          }
        }
      }
      continue;
    }

    if (matchType === 'manual_ambiguous') {
      // Assunzione operativa approvata dall'utente: #21 -> 1194, #49 -> 3568
      let chosenId = null;
      if (rowNum === 21) chosenId = 1194;
      if (rowNum === 49) chosenId = 3568;

      if (!chosenId || !ids.includes(chosenId)) {
        summary.skippedRows += 1;
        summary.skippedDetails.push({ row: rowNum, csvName, reason: 'mapping ambiguo non risolto' });
        continue;
      }

      const res = await updateAllVariationsPrice(env, chosenId, target, dryRun, opLogs);
      summary.touchedItems += res.touched;
      summary.updatedItems += res.updated;
      const start = opLogs.length - res.touched;
      for (let i = start; i < opLogs.length; i += 1) {
        opLogs[i].row = rowNum;
        opLogs[i].csv_name = csvName;
        opLogs[i].match_type = matchType;
        opLogs[i].target_price = target;
        opLogs[i].note = pushNote(`ambiguous-resolved:${chosenId}`, row.note);
      }
      continue;
    }

    if (matchType === 'manual_group') {
      for (const id of ids) {
        const res = await updateAllVariationsPrice(env, id, target, dryRun, opLogs);
        summary.touchedItems += res.touched;
        summary.updatedItems += res.updated;
        const start = opLogs.length - res.touched;
        for (let i = start; i < opLogs.length; i += 1) {
          opLogs[i].row = rowNum;
          opLogs[i].csv_name = csvName;
          opLogs[i].match_type = matchType;
          opLogs[i].target_price = target;
          opLogs[i].note = pushNote('group-update-all', row.note);
        }
      }
      continue;
    }

    if (matchType === 'manual_variation_group') {
      let attrValue = null;
      if (rowNum === 58) attrValue = 'S';
      if (rowNum === 59) attrValue = 'M';
      if (rowNum === 63) attrValue = 'M';
      if (rowNum === 64) attrValue = 'S';

      if (!attrValue) {
        summary.skippedRows += 1;
        summary.skippedDetails.push({ row: rowNum, csvName, reason: 'regola variation_group non definita' });
        continue;
      }

      let totalTouched = 0;
      let totalUpdated = 0;
      for (const id of ids) {
        const res = await updateVariationsByAttribute(env, id, 'taglia', attrValue, target, dryRun, opLogs);
        totalTouched += res.touched;
        totalUpdated += res.updated;
        const start = opLogs.length - res.touched;
        for (let i = start; i < opLogs.length; i += 1) {
          opLogs[i].row = rowNum;
          opLogs[i].csv_name = csvName;
          opLogs[i].match_type = matchType;
          opLogs[i].target_price = target;
          opLogs[i].note = pushNote(`variation-group:taglia=${attrValue}`, row.note);
        }
      }

      if (totalTouched === 0) {
        summary.skippedRows += 1;
        summary.skippedDetails.push({ row: rowNum, csvName, reason: `nessuna variazione trovata con taglia=${attrValue}` });
      }

      summary.touchedItems += totalTouched;
      summary.updatedItems += totalUpdated;
      continue;
    }

    if (matchType === 'manual_variation_split') {
      summary.skippedRows += 1;
      summary.skippedDetails.push({
        row: rowNum,
        csvName,
        reason: 'split su stesso product_id con prezzi diversi: richiede regola colore esplicita'
      });
      continue;
    }

    if (matchType === 'manual_missing') {
      summary.skippedRows += 1;
      summary.skippedDetails.push({ row: rowNum, csvName, reason: 'match mancante' });
      continue;
    }

    summary.skippedRows += 1;
    summary.skippedDetails.push({ row: rowNum, csvName, reason: `match_type non gestito: ${matchType}` });
  }

  const stamp = nowCompact();
  const mode = dryRun ? 'dryrun' : 'live';
  const reportDir = path.join(process.cwd(), 'data');
  const csvOut = path.join(reportDir, `farway-price-2026-update-report-${mode}-${stamp}.csv`);
  const jsonOut = path.join(reportDir, `farway-price-2026-update-summary-${mode}-${stamp}.json`);
  writeCsv(csvOut, opLogs);
  fs.writeFileSync(jsonOut, JSON.stringify(summary, null, 2), 'utf8');

  console.log(JSON.stringify({ mode, csvOut, jsonOut, summary }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
