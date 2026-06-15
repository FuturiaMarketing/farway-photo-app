#!/usr/bin/env node
'use strict';

/**
 * farway-draft-normalize-suffixes.cjs
 *
 * Normalizza i suffissi tra parentesi nei nomi dei prodotti in `draft`:
 *   - `(Campionatura)` → `(CAMP)`
 *   - `(Doha)` → `(DOHA)`
 *
 * Scope: tutti i prodotti draft (parent variable consolidati + simple residui
 * lasciati standalone come "modelli codice" o pre-existing). Idempotente.
 *
 * Vincoli: tocca SOLO `name`, mai status/attributi/categorie/varianti.
 *
 * Modi:
 *   - dry-run (default)
 *   - apply (richiede --confirm FARWAY_NORMALIZE_SUFFIXES_APPROVED)
 */

const fs = require('fs/promises');
const path = require('path');

const APPLY_CONFIRMATION = 'FARWAY_NORMALIZE_SUFFIXES_APPROVED';
const WC_WRITE_DELAY_MS = 150;

const REPLACEMENTS = [
  { pattern: /\(Campionatura\)/gi, replace: '(CAMP)' },
  { pattern: /\(Doha\)/g, replace: '(DOHA)' },
];

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

function normalizeName(name) {
  let result = String(name || '');
  for (const r of REPLACEMENTS) {
    result = result.replace(r.pattern, r.replace);
  }
  return result;
}

async function main() {
  const scriptDir = __dirname;
  const apply = process.argv.includes('--apply');
  const confirm = (() => {
    const i = process.argv.indexOf('--confirm');
    return i >= 0 ? process.argv[i + 1] : '';
  })();

  console.log('========================================');
  console.log(' Farway — Normalize suffixes draft names');
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

  console.log('[1] fetch tutti i prodotti draft...');
  const drafts = await wooFetchAll(settings, 'products', 'status=draft');
  console.log(`  ✓ ${drafts.length} draft totali`);

  const plan = [];
  for (const d of drafts) {
    const target = normalizeName(d.name);
    if (target !== d.name) {
      plan.push({
        id: d.id,
        type: d.type,
        current_name: d.name,
        target_name: target,
      });
    }
  }
  console.log(`  ✓ ${plan.length} da rinominare`);

  // Output
  const outputDir = path.join(scriptDir, '..', 'data', `farway-normalize-suffixes-${nowCompact()}`);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');

  console.log('');
  console.log('Esempi (primi 10):');
  plan.slice(0, 10).forEach((p) => console.log(`  ${p.id} | ${p.current_name} → ${p.target_name}`));

  if (!apply) {
    console.log('');
    console.log('==========================================');
    console.log('[ok] DRY-RUN completato.');
    console.log(`     Per applicare:`);
    console.log(`       node scripts/farway-draft-normalize-suffixes.cjs --apply --confirm ${APPLY_CONFIRMATION}`);
    console.log('==========================================');
    return;
  }

  console.log('');
  console.log('[2] APPLY...');
  let ok = 0, failed = 0;
  for (const p of plan) {
    try {
      await wooRequest(settings, 'PUT', `products/${p.id}`, { name: p.target_name });
      ok += 1;
      await sleep(WC_WRITE_DELAY_MS);
    } catch (err) {
      console.error(`  ✗ ${p.id} FALLITO: ${err.message}`);
      failed += 1;
    }
  }
  console.log(`  ✓ ${ok}/${plan.length} rinominati (${failed} falliti)`);

  await fs.writeFile(path.join(outputDir, 'applied-summary.json'), JSON.stringify({
    ok, failed, total: plan.length, finished_at: new Date().toISOString(),
  }, null, 2), 'utf8');

  console.log('');
  console.log('==========================================');
  console.log(`[ok] APPLY completato.`);
  console.log('==========================================');
}

main().catch((e) => {
  console.error('[ERR]', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
