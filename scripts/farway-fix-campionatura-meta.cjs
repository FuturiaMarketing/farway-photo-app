#!/usr/bin/env node
'use strict';

/**
 * farway-fix-campionatura-meta.cjs
 *
 * Fix retroattivo del meta `fw_erp_is_campionatura` sui parent draft e
 * variazioni creati dallo script di consolidamento, che erano stati salvati
 * come stringhe `'true'`/`'false'`. ACF `true_false` interpreta qualsiasi
 * stringa non-empty come TRUE (PHP truthy), quindi nell'admin tutti i
 * prodotti risultano "campionatura: sì".
 *
 * Conversione: `'true'` → `'1'`, `'false'` → `'0'` (formato ACF standard).
 *
 * Scope:
 *   - parent variable in draft con marker `_fw_consolidate_run_id`
 *   - variazioni di ciascun parent (stesso meta key)
 *
 * Non tocca:
 *   - simple in trash (meta scritto da altro flusso ERP)
 *   - prodotti pubblicati
 *
 * Modi:
 *   - dry-run (default)
 *   - apply (richiede --confirm FARWAY_FIX_CAMPIONATURA_META_APPROVED)
 */

const fs = require('fs/promises');
const path = require('path');

const APPLY_CONFIRMATION = 'FARWAY_FIX_CAMPIONATURA_META_APPROVED';
const WC_WRITE_DELAY_MS = 150;

function nowCompact() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function loadEnvFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const sep = t.indexOf('=');
      if (sep <= 0) continue;
      const k = t.slice(0, sep).trim();
      if (!k || process.env[k]) continue;
      let v = t.slice(sep + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[k] = v;
    }
  } catch {}
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(tid); }
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
  if (!res.ok) throw new Error(`Woo ${method} ${endpoint} -> HTTP ${res.status}: ${String(text).slice(0, 400)}`);
  return data;
}

async function wooFetchAll(settings, endpoint, extra = '') {
  const out = [];
  let page = 1;
  while (true) {
    const sep = endpoint.includes('?') ? '&' : '?';
    const qs = `per_page=100&page=${page}${extra ? '&' + extra : ''}`;
    const batch = await wooRequest(settings, 'GET', `${endpoint}${sep}${qs}`);
    if (!Array.isArray(batch)) throw new Error(`Risposta Woo inattesa per ${endpoint}`);
    out.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return out;
}

function normalizeCampValue(currentValue) {
  // Ritorna il valore corretto in formato ACF '1'/'0', oppure null se è già OK.
  if (currentValue === '1' || currentValue === '0') return null; // già OK
  const s = String(currentValue).trim().toLowerCase();
  if (s === 'true') return '1';
  if (s === 'false') return '0';
  if (s === '') return '0';
  // Qualsiasi altra stringa è truthy in PHP → assume vera
  return '1';
}

async function main() {
  const scriptDir = __dirname;
  const apply = process.argv.includes('--apply');
  const confirm = (() => {
    const i = process.argv.indexOf('--confirm');
    return i >= 0 ? process.argv[i + 1] : '';
  })();

  console.log('========================================');
  console.log(' Farway — Fix fw_erp_is_campionatura meta');
  console.log(`  Modalità: ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log('========================================');

  if (apply && confirm !== APPLY_CONFIRMATION) {
    throw new Error(`Apply richiede --confirm ${APPLY_CONFIRMATION}`);
  }

  await loadEnvFile(path.join(scriptDir, '..', '.env.local'));
  const settings = {
    storeUrl: String(process.env.WC_STORE_URL || '').trim().replace(/\/$/, ''),
    consumerKey: String(process.env.WC_CONSUMER_KEY || '').trim(),
    consumerSecret: String(process.env.WC_CONSUMER_SECRET || '').trim(),
  };
  console.log(`[setup] store: ${settings.storeUrl}`);

  // Fetch parent variable in draft
  console.log('[1] fetch parent variable draft...');
  const allDrafts = await wooFetchAll(settings, 'products', 'status=draft&type=variable');
  const parents = allDrafts.filter((d) => (d.meta_data || []).some((m) => m.key === '_fw_consolidate_run_id'));
  console.log(`  ✓ ${parents.length} parent con marker consolidamento`);

  // Collect parent updates
  const parentUpdates = [];
  for (const p of parents) {
    const m = (p.meta_data || []).find((mm) => mm.key === 'fw_erp_is_campionatura');
    if (!m) continue;
    const normalized = normalizeCampValue(m.value);
    if (normalized === null) continue;
    parentUpdates.push({
      id: p.id,
      name: p.name,
      old: m.value,
      new: normalized,
    });
  }
  console.log(`  ✓ ${parentUpdates.length} parent da correggere`);

  // Collect variation updates
  console.log('[2] fetch variazioni per ogni parent...');
  const variationUpdates = [];
  for (const p of parents) {
    const vars = await wooFetchAll(settings, `products/${p.id}/variations`);
    for (const v of vars) {
      const m = (v.meta_data || []).find((mm) => mm.key === 'fw_erp_is_campionatura');
      if (!m) continue;
      const normalized = normalizeCampValue(m.value);
      if (normalized === null) continue;
      variationUpdates.push({
        parent_id: p.id,
        parent_name: p.name,
        variation_id: v.id,
        old: m.value,
        new: normalized,
      });
    }
  }
  console.log(`  ✓ ${variationUpdates.length} variazioni da correggere`);

  const totalChanges = parentUpdates.length + variationUpdates.length;
  console.log('');
  console.log('Sintesi:');
  console.log(`  - Parent da correggere: ${parentUpdates.length}`);
  console.log(`  - Variazioni da correggere: ${variationUpdates.length}`);
  console.log(`  - Totale aggiornamenti: ${totalChanges}`);

  // Distribuzione vecchio→nuovo
  const distParent = parentUpdates.reduce((acc, u) => { acc[u.old + '→' + u.new] = (acc[u.old + '→' + u.new] || 0) + 1; return acc; }, {});
  const distVar = variationUpdates.reduce((acc, u) => { acc[u.old + '→' + u.new] = (acc[u.old + '→' + u.new] || 0) + 1; return acc; }, {});
  console.log('  Parent distribuzione:', JSON.stringify(distParent));
  console.log('  Variazioni distribuzione:', JSON.stringify(distVar));

  // Output dir
  const baseDataDir = path.join(scriptDir, '..', 'data');
  const outputDir = path.join(baseDataDir, `farway-fix-campionatura-${nowCompact()}`);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'parent-updates.json'), JSON.stringify(parentUpdates, null, 2), 'utf8');
  await fs.writeFile(path.join(outputDir, 'variation-updates.json'), JSON.stringify(variationUpdates, null, 2), 'utf8');

  if (!apply) {
    console.log('');
    console.log('==========================================');
    console.log('[ok] DRY-RUN completato. Plan in:', outputDir);
    console.log(`     Per applicare:`);
    console.log(`       node scripts/farway-fix-campionatura-meta.cjs --apply --confirm ${APPLY_CONFIRMATION}`);
    console.log('==========================================');
    return;
  }

  // === Apply ===
  console.log('');
  console.log('[3] APPLY...');
  let okP = 0, failP = 0;
  for (const u of parentUpdates) {
    try {
      await wooRequest(settings, 'PUT', `products/${u.id}`, {
        meta_data: [{ key: 'fw_erp_is_campionatura', value: u.new }],
      });
      okP += 1;
      await sleep(WC_WRITE_DELAY_MS);
    } catch (err) {
      console.error(`  ✗ parent ${u.id} FALLITO: ${err.message}`);
      failP += 1;
    }
  }
  console.log(`  ✓ Parent: ${okP}/${parentUpdates.length} aggiornati (${failP} falliti)`);

  let okV = 0, failV = 0;
  for (const u of variationUpdates) {
    try {
      await wooRequest(settings, 'PUT', `products/${u.parent_id}/variations/${u.variation_id}`, {
        meta_data: [{ key: 'fw_erp_is_campionatura', value: u.new }],
      });
      okV += 1;
      await sleep(WC_WRITE_DELAY_MS);
    } catch (err) {
      console.error(`  ✗ variation ${u.variation_id} (parent ${u.parent_id}) FALLITO: ${err.message}`);
      failV += 1;
    }
  }
  console.log(`  ✓ Variazioni: ${okV}/${variationUpdates.length} aggiornate (${failV} fallite)`);

  await fs.writeFile(path.join(outputDir, 'applied-summary.json'), JSON.stringify({
    parents: { ok: okP, failed: failP },
    variations: { ok: okV, failed: failV },
    finished_at: new Date().toISOString(),
  }, null, 2), 'utf8');

  console.log('');
  console.log('==========================================');
  console.log(`[ok] APPLY completato. ${okP + okV} totali aggiornati, ${failP + failV} falliti`);
  console.log('==========================================');
}

main().catch((e) => {
  console.error('[ERR]', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
