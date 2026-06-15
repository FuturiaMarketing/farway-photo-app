/**
 * farway-apply-skus.cjs
 *
 * Applies new SKUs to WooCommerce based on mapping CSV.
 * Preserves legacy ERP SKUs into meta_data._erp_sku.
 *
 * Usage:
 *   node scripts/farway-apply-skus.cjs --mapping data/farway-sku-mapping-latest.csv --dry-run
 *   node scripts/farway-apply-skus.cjs --mapping data/farway-sku-mapping-latest.csv
 *   node scripts/farway-apply-skus.cjs --backup-only
 *   node scripts/farway-apply-skus.cjs --mapping <csv> --limit 5 --dry-run
 *   node scripts/farway-apply-skus.cjs --mapping <csv> --scope parent
 *
 * Output:
 *   _local/sku-update-<mode>-<TS>.csv   where mode = dryrun | applied | backup
 */
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
      if (q && line[i + 1] === '"') { cur += '"'; i += 1; } else { q = !q; }
    } else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else { cur += ch; }
  }
  out.push(cur);
  return out;
}

function parseCsv(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = parseLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = parseLine(line);
    const obj = {};
    for (let i = 0; i < header.length; i += 1) obj[header[i]] = cols[i] ?? '';
    return obj;
  });
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function writeCsv(filePath, rows) {
  if (rows.length === 0) { fs.writeFileSync(filePath, ''); return; }
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

async function wooRequest(env, endpoint, options = {}) {
  const base = env.WC_STORE_URL.replace(/\/$/, '');
  const auth = `consumer_key=${env.WC_CONSUMER_KEY}&consumer_secret=${env.WC_CONSUMER_SECRET}`;
  const glue = endpoint.includes('?') ? '&' : '?';
  const url = `${base}${endpoint}${glue}${auth}`;
  const r = await fetch(url, options);
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: r.ok, status: r.status, data };
}

function parseArgs(argv) {
  const out = { mapping: '', dryRun: false, backupOnly: false, limit: 0, scope: 'all' };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--backup-only') out.backupOnly = true;
    else if (a.startsWith('--mapping')) out.mapping = a.split('=')[1] || argv[argv.indexOf(a) + 1];
    else if (a.startsWith('--limit')) out.limit = parseInt(a.split('=')[1] || argv[argv.indexOf(a) + 1], 10);
    else if (a.startsWith('--scope')) out.scope = (a.split('=')[1] || argv[argv.indexOf(a) + 1]).toLowerCase();
  }
  return out;
}

function looksLikeErpCode(s) {
  if (!s) return false;
  if (s.length > 16) return false;
  if (!/^[A-Z0-9]+$/.test(s)) return false;
  if (!/[A-Z]/.test(s) || !/[0-9]/.test(s)) return false;
  return true;
}

(async () => {
  const repoRoot = path.resolve(__dirname, '..');
  const envPath = path.join(repoRoot, '.env.local');
  if (!fs.existsSync(envPath)) { console.error('Missing .env.local'); process.exit(1); }
  const env = readEnvFile(envPath);
  if (!env.WC_STORE_URL || !env.WC_CONSUMER_KEY || !env.WC_CONSUMER_SECRET) {
    console.error('Missing WC env vars'); process.exit(1);
  }

  const args = parseArgs(process.argv);
  const localDir = path.join(repoRoot, '_local');
  if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

  const ts = nowCompact();

  if (args.backupOnly) {
    console.log('BACKUP-ONLY mode: reading all current SKUs from WC...');
    const out = [];
    let totalProducts = 0;
    let totalVariations = 0;
    for (let page = 1; ; page += 1) {
      const r = await wooRequest(env, `/wp-json/wc/v3/products?per_page=100&status=publish&page=${page}`);
      if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) break;
      for (const p of r.data) {
        totalProducts += 1;
        out.push({ scope: 'parent', product_id: p.id, variation_id: '', current_sku: p.sku || '', product_name: p.name, type: p.type });
        if (p.type === 'variable') {
          for (let vp = 1; ; vp += 1) {
            const vr = await wooRequest(env, `/wp-json/wc/v3/products/${p.id}/variations?per_page=100&page=${vp}`);
            if (!vr.ok || !Array.isArray(vr.data) || vr.data.length === 0) break;
            for (const v of vr.data) {
              totalVariations += 1;
              const attrs = (v.attributes || []).map((a) => `${a.name}=${a.option}`).join(' | ');
              out.push({ scope: 'variation', product_id: p.id, variation_id: v.id, current_sku: v.sku || '', product_name: p.name, type: 'variation', variant_attrs: attrs });
            }
            if (vr.data.length < 100) break;
          }
        }
      }
      if (r.data.length < 100) break;
    }
    const file = path.join(localDir, `sku-update-backup-${ts}.csv`);
    writeCsv(file, out);
    console.log(`Backup: ${out.length} rows (${totalProducts} products, ${totalVariations} variations)`);
    console.log(`File: ${file}`);
    return;
  }

  if (!args.mapping) { console.error('Missing --mapping <csv>'); process.exit(1); }
  if (!fs.existsSync(args.mapping)) { console.error('Mapping CSV not found:', args.mapping); process.exit(1); }

  const mapping = parseCsv(args.mapping);
  console.log(`Mapping rows: ${mapping.length}`);
  console.log(`Mode: ${args.dryRun ? 'DRY-RUN' : 'APPLY'} | scope: ${args.scope} | limit: ${args.limit || 'none'}`);

  let filtered = mapping;
  if (args.scope === 'parent') filtered = mapping.filter((r) => r.scope === 'parent' || r.scope === 'simple');
  else if (args.scope === 'variation') filtered = mapping.filter((r) => r.scope === 'variation');
  if (args.limit > 0) filtered = filtered.slice(0, args.limit);

  console.log(`Filtered: ${filtered.length} rows to process`);

  const logRows = [];
  let processed = 0, updated = 0, skipped = 0, errors = 0, duplicateConflicts = 0;

  for (const r of filtered) {
    processed += 1;
    if (!r.new_sku) { skipped += 1; continue; }
    const isVariation = r.scope === 'variation';
    const endpoint = isVariation
      ? `/wp-json/wc/v3/products/${r.product_id}/variations/${r.variation_id}`
      : `/wp-json/wc/v3/products/${r.product_id}`;

    let currentSku = r.current_sku || '';
    let currentMeta = [];
    if (!args.dryRun) {
      const cur = await wooRequest(env, endpoint);
      if (cur.ok && cur.data) {
        currentSku = cur.data.sku || '';
        currentMeta = cur.data.meta_data || [];
      }
    }

    const payload = { sku: r.new_sku };
    const erpToPreserve = looksLikeErpCode(currentSku) ? currentSku : (r.erp_sku_candidate || '');
    if (erpToPreserve) {
      const existingErp = currentMeta.find((m) => m.key === '_erp_sku');
      if (!existingErp || !existingErp.value) {
        payload.meta_data = [{ key: '_erp_sku', value: erpToPreserve }];
      }
    }

    if (args.dryRun) {
      logRows.push({ scope: r.scope, product_id: r.product_id, variation_id: r.variation_id, product_name: r.product_name, current_sku: currentSku, new_sku: r.new_sku, action: 'dry-run', erp_preserved: erpToPreserve, http_status: '', error: '' });
      continue;
    }

    try {
      const resp = await wooRequest(env, endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        updated += 1;
        logRows.push({ scope: r.scope, product_id: r.product_id, variation_id: r.variation_id, product_name: r.product_name, current_sku: currentSku, new_sku: r.new_sku, action: 'updated', erp_preserved: erpToPreserve, http_status: resp.status, error: '' });
      } else {
        const errMsg = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
        const isDup = errMsg.includes('product_invalid_sku') || errMsg.includes('non univoco') || errMsg.includes('not unique');
        if (isDup) duplicateConflicts += 1; else errors += 1;
        logRows.push({ scope: r.scope, product_id: r.product_id, variation_id: r.variation_id, product_name: r.product_name, current_sku: currentSku, new_sku: r.new_sku, action: isDup ? 'duplicate_conflict' : 'error', erp_preserved: erpToPreserve, http_status: resp.status, error: errMsg.slice(0, 200) });
      }
    } catch (e) {
      errors += 1;
      logRows.push({ scope: r.scope, product_id: r.product_id, variation_id: r.variation_id, product_name: r.product_name, current_sku: currentSku, new_sku: r.new_sku, action: 'exception', erp_preserved: erpToPreserve, http_status: '', error: e.message.slice(0, 200) });
    }

    if (processed % 50 === 0) {
      console.log(`  Progress: ${processed}/${filtered.length}  updated=${updated} skipped=${skipped} errors=${errors} dupConflicts=${duplicateConflicts}`);
    }
  }

  const mode = args.dryRun ? 'dryrun' : 'applied';
  const file = path.join(localDir, `sku-update-${mode}-${ts}.csv`);
  writeCsv(file, logRows);
  console.log('---');
  console.log(`Processed: ${processed} | Updated: ${updated} | Skipped: ${skipped} | Errors: ${errors} | Duplicate conflicts: ${duplicateConflicts}`);
  console.log(`Log: ${file}`);
})().catch((e) => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
