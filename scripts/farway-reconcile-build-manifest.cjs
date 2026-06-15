#!/usr/bin/env node
// Build data/reconcile/suggestions-manifest.json from a workflow task-output JSON file.
// Usage: node scripts/farway-reconcile-build-manifest.cjs <path-to-workflow-output.json>
const fs = require('fs');
const path = require('path');

const inPath = process.argv[2];
if (!inPath) { console.error('Usage: build-manifest <workflow-output.json>'); process.exit(1); }

const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const result = Array.isArray(raw) ? raw : (raw.result || []);
if (!Array.isArray(result) || !result.length) { console.error('No result[] found in', inPath); process.exit(1); }

// dedupe by file (keep last)
const byFile = new Map();
for (const r of result) { if (r && r.file) byFile.set(r.file, r); }

const RDIR = path.join(process.cwd(), 'data', 'reconcile');
const outPath = path.join(RDIR, 'suggestions-manifest.json');

// merge with any existing manifest so partial runs accumulate
let existing = {};
if (fs.existsSync(outPath)) {
  try { for (const it of JSON.parse(fs.readFileSync(outPath, 'utf8')).items || []) existing[it.file] = it; } catch {}
}
for (const [f, r] of byFile) existing[f] = r;

const items = Object.values(existing).sort((a, b) => a.file.localeCompare(b.file));
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), count: items.length, items }, null, 2));

const matched = items.filter(i => i.disposition === 'match').length;
const bucket = items.filter(i => i.disposition === 'bucket').length;
console.log(`manifest written: ${items.length} items (${matched} match, ${bucket} bucket) -> ${outPath}`);
