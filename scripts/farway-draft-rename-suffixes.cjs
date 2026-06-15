#!/usr/bin/env node
'use strict';

/**
 * farway-draft-rename-suffixes.cjs
 *
 * Aggiunge suffissi al `name` dei parent variable draft creati dal consolidamento:
 *   - `(CAMP)` se `fw_erp_is_campionatura == '1'`
 *   - `(DOHA)` se TUTTE le variazioni hanno `fw_erp_location == 'Doha'`
 *
 * Entrambi possono coesistere: "Pantaloncino Capri (CAMP)" + "(DOHA)" → "Pantaloncino Capri (CAMP) (DOHA)".
 *
 * Vincoli:
 *   - NON tocca status / attributi / categorie / prezzi / variazioni
 *   - Idempotente: skip parent il cui name termina già con i suffissi corretti
 *
 * Modi:
 *   - dry-run (default)
 *   - apply (richiede --confirm FARWAY_RENAME_SUFFIXES_APPROVED)
 */

const fs = require('fs/promises');
const path = require('path');

const APPLY_CONFIRMATION = 'FARWAY_RENAME_SUFFIXES_APPROVED';
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

function getMetaValue(metaData, key) {
  if (!Array.isArray(metaData)) return undefined;
  for (const m of metaData) {
    if (m && m.key === key) return m.value;
  }
  return undefined;
}

/**
 * Calcola il name target aggiungendo i suffissi richiesti se non già presenti.
 * Idempotente: se name contiene già "(CAMP)" o "(DOHA)" alla fine, non ripete.
 */
function computeTargetName(currentName, needsCamp, needsDoha) {
  let name = String(currentName || '').trim();
  // Rimuovi suffissi esistenti (in qualsiasi ordine, anche con spaces) per ricomporli puliti
  const stripped = name
    .replace(/\s*\((CAMP|DOHA)\)\s*\((CAMP|DOHA)\)\s*$/i, '')
    .replace(/\s*\((CAMP|DOHA)\)\s*$/i, '')
    .trim();
  const parts = [stripped];
  if (needsCamp) parts.push('(CAMP)');
  if (needsDoha) parts.push('(DOHA)');
  return parts.join(' ').trim();
}

async function main() {
  const scriptDir = __dirname;
  const apply = process.argv.includes('--apply');
  const confirm = (() => {
    const i = process.argv.indexOf('--confirm');
    return i >= 0 ? process.argv[i + 1] : '';
  })();

  console.log('========================================');
  console.log(' Farway — Rename suffixes (CAMP) / (DOHA)');
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

  // Fetch parent variable in draft con marker consolidamento
  console.log('[1] fetch parent variable draft...');
  const allDrafts = await wooFetchAll(settings, 'products', 'status=draft&type=variable');
  const parents = allDrafts.filter((d) => (d.meta_data || []).some((m) => m.key === '_fw_consolidate_run_id'));
  console.log(`  ✓ ${parents.length} parent con marker consolidamento`);

  // Per ogni parent, leggere le variazioni per location
  console.log('[2] analisi suffix necessari (CAMP / DOHA)...');
  const plan = [];
  for (const p of parents) {
    const campMeta = getMetaValue(p.meta_data, 'fw_erp_is_campionatura');
    const isCamp = String(campMeta || '').trim() === '1';

    // Variazioni per location
    const vars = await wooFetchAll(settings, `products/${p.id}/variations`);
    const locations = vars.map((v) => String(getMetaValue(v.meta_data, 'fw_erp_location') || '').trim());
    const allDoha = locations.length > 0 && locations.every((l) => l === 'Doha');
    const uniqueLocations = [...new Set(locations)].filter(Boolean);

    const targetName = computeTargetName(p.name, isCamp, allDoha);
    const needsRename = targetName !== p.name;

    plan.push({
      parent_id: p.id,
      current_name: p.name,
      target_name: targetName,
      is_campionatura: isCamp,
      all_doha: allDoha,
      unique_locations: uniqueLocations,
      variations_count: vars.length,
      needs_rename: needsRename,
    });
  }

  const toRename = plan.filter((p) => p.needs_rename);
  const countCamp = plan.filter((p) => p.is_campionatura).length;
  const countDoha = plan.filter((p) => p.all_doha).length;
  const countBoth = plan.filter((p) => p.is_campionatura && p.all_doha).length;

  console.log('');
  console.log('Sintesi:');
  console.log(`  - Parent totali: ${plan.length}`);
  console.log(`  - Con campionatura=1: ${countCamp}`);
  console.log(`  - Con tutte le var Doha: ${countDoha}`);
  console.log(`  - Con entrambi (CAMP + DOHA): ${countBoth}`);
  console.log(`  - Da rinominare: ${toRename.length}`);
  console.log(`  - Già correttamente suffissati / nessun suffisso necessario: ${plan.length - toRename.length}`);

  // Output dir
  const outputDir = path.join(scriptDir, '..', 'data', `farway-rename-suffixes-${nowCompact()}`);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');

  // Report markdown
  const lines = [];
  lines.push('# Farway — Rename suffixes (CAMP) / (DOHA): plan');
  lines.push('');
  lines.push(`Generato: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Sintesi');
  lines.push('');
  lines.push(`- Parent totali: ${plan.length}`);
  lines.push(`- Con campionatura=1 (suffisso \`(CAMP)\`): ${countCamp}`);
  lines.push(`- Con tutte var Doha (suffisso \`(DOHA)\`): ${countDoha}`);
  lines.push(`- Con entrambi: ${countBoth}`);
  lines.push(`- Da rinominare: **${toRename.length}**`);
  lines.push('');
  lines.push('## Rinomine pianificate');
  lines.push('');
  lines.push('| Parent ID | Current name | → | Target name | Locations var. | #var |');
  lines.push('|---|---|---|---|---|---|');
  for (const p of toRename) {
    lines.push(`| ${p.parent_id} | ${escapeMd(p.current_name)} | → | ${escapeMd(p.target_name)} | ${escapeMd(p.unique_locations.join(','))} | ${p.variations_count} |`);
  }
  lines.push('');
  lines.push('## Parent NON da rinominare (già OK o nessun suffisso necessario)');
  lines.push('');
  lines.push('| Parent ID | Name | camp | all_doha | Locations | #var |');
  lines.push('|---|---|---|---|---|---|');
  for (const p of plan.filter((x) => !x.needs_rename)) {
    lines.push(`| ${p.parent_id} | ${escapeMd(p.current_name)} | ${p.is_campionatura ? 'sì' : ''} | ${p.all_doha ? 'sì' : ''} | ${escapeMd(p.unique_locations.join(','))} | ${p.variations_count} |`);
  }
  await fs.writeFile(path.join(outputDir, 'report.md'), lines.join('\n'), 'utf8');

  console.log(`  ✓ plan: ${path.join(outputDir, 'plan.json')}`);
  console.log(`  ✓ report: ${path.join(outputDir, 'report.md')}`);

  if (!apply) {
    console.log('');
    console.log('==========================================');
    console.log('[ok] DRY-RUN completato.');
    console.log(`     Per applicare:`);
    console.log(`       node scripts/farway-draft-rename-suffixes.cjs --apply --confirm ${APPLY_CONFIRMATION}`);
    console.log('==========================================');
    return;
  }

  // === Apply ===
  console.log('');
  console.log('[3] APPLY rinomine...');
  let ok = 0, failed = 0;
  for (const p of toRename) {
    try {
      await wooRequest(settings, 'PUT', `products/${p.parent_id}`, { name: p.target_name });
      ok += 1;
      await sleep(WC_WRITE_DELAY_MS);
    } catch (err) {
      console.error(`  ✗ parent ${p.parent_id} FALLITO: ${err.message}`);
      failed += 1;
    }
  }
  console.log(`  ✓ ${ok}/${toRename.length} parent rinominati (${failed} falliti)`);

  await fs.writeFile(path.join(outputDir, 'applied-summary.json'), JSON.stringify({
    ok, failed, total: toRename.length, finished_at: new Date().toISOString(),
  }, null, 2), 'utf8');

  console.log('');
  console.log('==========================================');
  console.log(`[ok] APPLY completato.`);
  console.log('==========================================');
}

function escapeMd(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

main().catch((e) => {
  console.error('[ERR]', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
