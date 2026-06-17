#!/usr/bin/env node
/*
 * Apply the confirmed reconcile manifest to the still-life folder.
 * Reads data/reconcile/decisions.json (written by the /abbina-foto review UI).
 *  - status "confirmed" -> rename file to the standard name (with -N suffix on duplicates)
 *  - status "bucket"    -> move file into _da-verificare/ (original name kept)
 *  - status "skip"/none -> left untouched
 * Logs every action to <folder>/_rinomina-log.csv. DRY-RUN by default; pass --apply to execute.
 *
 * Usage:  node scripts/farway-reconcile-apply-rename.cjs [--apply]
 */
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const STILL_LIFE_DIR =
  process.env.STILL_LIFE_DIR ||
  'D:\\GoogleDrive\\Futuria at work\\Clienti e progetti\\Farway Milano\\Website\\Sito Next\\Foto still life sfondo chiaro';
const RDIR = path.join(process.cwd(), 'data', 'reconcile');

// ---- naming (kept in sync with lib/reconcile-naming.ts) ----
function cleanSegment(s) {
  return String(s || '')
    .normalize('NFC')
    .replace(/&/g, 'e')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/['’.,()]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function buildTargetName({ productName, colorway, view, suffix }) {
  const parts = [cleanSegment(productName)];
  if (colorway && String(colorway).trim()) parts.push(cleanSegment(colorway));
  parts.push('still-life');
  let v = String(view || '').trim();
  if (v) {
    if (suffix && suffix > 1) v = `${v}-${suffix}`;
    parts.push(v);
  } else if (suffix && suffix > 1) {
    parts.push(String(suffix));
  }
  parts.push('di-Farway-Milano');
  return parts.filter(Boolean).join('-') + '.jpg';
}

function csvCell(s) {
  const v = String(s == null ? '' : s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  } catch {}
}

// Decisions come from Postgres (where the deployed review UI writes them); fall back to local file.
async function loadDecisions() {
  loadEnv();
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
    try {
      const r = await pool.query("SELECT value FROM app_key_value WHERE namespace='photo_matches' AND key='decisions'");
      await pool.end();
      const map = r.rows[0]?.value || {};
      return Object.values(map);
    } catch (e) {
      await pool.end().catch(() => {});
      console.error('DB read failed, falling back to local file:', e.message);
    }
  }
  const local = path.join(RDIR, 'decisions.json');
  if (!fs.existsSync(local)) { console.error('No decisions in DB or at', local); process.exit(1); }
  return Object.values(JSON.parse(fs.readFileSync(local, 'utf8')));
}

(async function main() {
  const decisions = await loadDecisions();

  const bucketDir = path.join(STILL_LIFE_DIR, '_da-verificare');
  const multiDir = path.join(STILL_LIFE_DIR, '_multiprodotto');
  const existing = new Set(fs.readdirSync(STILL_LIFE_DIR).filter((f) => /\.jpg$/i.test(f)));
  const used = new Set(existing); // reserve names already on disk (incl. the 7 already-renamed)

  const ts = new Date().toISOString();
  const logRows = [];
  const plan = { rename: [], bucket: [], multi: [], skip: [], missing: [], conflict: [] };

  // confirmed first (stable order so suffix assignment is deterministic)
  const confirmed = decisions.filter((d) => d.status === 'confirmed').sort((a, b) => a.file.localeCompare(b.file));
  const buckets = decisions.filter((d) => d.status === 'bucket').sort((a, b) => a.file.localeCompare(b.file));
  const multis = decisions.filter((d) => d.status === 'multi').sort((a, b) => a.file.localeCompare(b.file));

  for (const d of confirmed) {
    if (!existing.has(d.file)) { plan.missing.push(d.file); continue; }
    let target = null;
    for (let suffix = 1; suffix <= 50; suffix++) {
      const name = buildTargetName({ productName: d.productName, colorway: d.colorway, view: d.view, suffix });
      if (name === d.file) { target = name; break; } // already correctly named (idempotent)
      if (!used.has(name)) { target = name; break; }
    }
    if (!target) { plan.conflict.push(d.file); continue; }
    used.add(target);
    if (target === d.file) { plan.skip.push({ from: d.file, why: 'gia-standard' }); continue; }
    plan.rename.push({ from: d.file, to: target, prodotto: d.productName + (d.colorway ? ` / ${d.colorway}` : '') });
    logRows.push([ts, 'rinomina', d.file, target, d.productName + (d.colorway ? ` / ${d.colorway}` : ''), d.view]);
  }

  for (const d of buckets) {
    if (!existing.has(d.file)) { plan.missing.push(d.file); continue; }
    plan.bucket.push({ from: d.file, note: d.note || '' });
    logRows.push([ts, 'bucket', d.file, `_da-verificare/${d.file}`, '', d.note || '']);
  }

  for (const d of multis) {
    if (!existing.has(d.file)) { plan.missing.push(d.file); continue; }
    plan.multi.push({ from: d.file, note: d.note || '' });
    logRows.push([ts, 'multiprodotto', d.file, `_multiprodotto/${d.file}`, '', d.note || '']);
  }

  // ---- report ----
  console.log(`MODE: ${APPLY ? 'APPLY' : 'DRY-RUN'}  |  folder: ${STILL_LIFE_DIR}`);
  console.log(`decisions: ${decisions.length}  -> rename ${plan.rename.length}, bucket ${plan.bucket.length}, multiprodotto ${plan.multi.length}, already-standard ${plan.skip.length}, missing ${plan.missing.length}, conflict ${plan.conflict.length}\n`);
  for (const r of plan.rename) console.log(`  RENAME  ${r.from}\n       -> ${r.to}`);
  for (const b of plan.bucket) console.log(`  BUCKET  ${b.from}  (${b.note})`);
  for (const m of plan.multi) console.log(`  MULTI   ${m.from}  (${m.note})`);
  if (plan.missing.length) console.log(`  MISSING (not in folder): ${plan.missing.join(', ')}`);
  if (plan.conflict.length) console.log(`  CONFLICT (no free name): ${plan.conflict.join(', ')}`);

  if (!APPLY) { console.log('\nDry-run only. Re-run with --apply to execute.'); return; }

  // ---- execute ----
  fs.mkdirSync(bucketDir, { recursive: true });
  let done = 0;
  for (const r of plan.rename) {
    const from = path.join(STILL_LIFE_DIR, r.from), to = path.join(STILL_LIFE_DIR, r.to);
    if (fs.existsSync(to)) { console.error('SKIP (target exists):', r.to); continue; }
    fs.renameSync(from, to); done++;
  }
  for (const b of plan.bucket) {
    const from = path.join(STILL_LIFE_DIR, b.from), to = path.join(bucketDir, b.from);
    if (fs.existsSync(to)) { console.error('SKIP (already bucketed):', b.from); continue; }
    fs.renameSync(from, to); done++;
  }
  fs.mkdirSync(multiDir, { recursive: true });
  for (const m of plan.multi) {
    const from = path.join(STILL_LIFE_DIR, m.from), to = path.join(multiDir, m.from);
    if (fs.existsSync(to)) { console.error('SKIP (already in _multiprodotto):', m.from); continue; }
    fs.renameSync(from, to); done++;
  }

  // append to log (create header if missing)
  const logPath = path.join(STILL_LIFE_DIR, '_rinomina-log.csv');
  if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, 'timestamp,azione,originale,nuovo,prodotto,note\n');
  fs.appendFileSync(logPath, logRows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n');

  console.log(`\nAPPLIED ${done} actions. Log appended to ${logPath}`);
})();
