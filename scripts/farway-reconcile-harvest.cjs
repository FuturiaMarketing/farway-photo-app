#!/usr/bin/env node
/*
 * Harvest completed match results from a (possibly interrupted) match workflow's transcripts,
 * merge with the validation batch, and build a manifest covering ALL to-process photos.
 * Photos with no harvested match get empty candidates (Farwa searches manually).
 * Pure local parsing — no model tokens.
 *
 * Usage: node scripts/farway-reconcile-harvest.cjs <workflow-transcript-dir> [validation-output.json ...]
 */
const fs = require('fs');
const path = require('path');

const RDIR = path.join(process.cwd(), 'data', 'reconcile');
const transcriptDir = process.argv[2];
const extraResultFiles = process.argv.slice(3);

function findStructuredOutputs(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) findStructuredOutputs(n, out); return; }
  if (node.type === 'tool_use' && node.name === 'StructuredOutput' && node.input && typeof node.input === 'object' && node.input.file) {
    out.push(node.input);
  }
  for (const k of Object.keys(node)) findStructuredOutputs(node[k], out);
}

function harvestDir(dir) {
  const results = [];
  if (!dir || !fs.existsSync(dir)) { console.warn('transcript dir missing:', dir); return results; }
  for (const f of fs.readdirSync(dir).filter((x) => /^agent-.*\.jsonl$/.test(x))) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter(Boolean);
    const found = [];
    for (const line of lines) {
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      findStructuredOutputs(obj, found);
    }
    // last StructuredOutput in the transcript is the final answer
    if (found.length) results.push(found[found.length - 1]);
  }
  return results;
}

function loadResultFile(p) {
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(raw) ? raw : raw.result || [];
  } catch { return []; }
}

const byFile = new Map();
// validation / extra result files first (clean, Opus), then harvested fill in the rest
for (const p of extraResultFiles) for (const r of loadResultFile(p)) if (r && r.file) byFile.set(r.file, r);
let harvested = 0;
for (const r of harvestDir(transcriptDir)) { if (r && r.file && !byFile.has(r.file)) { byFile.set(r.file, r); harvested++; } }

const toProcess = JSON.parse(fs.readFileSync(path.join(RDIR, 'to-process.json'), 'utf8'));
const items = toProcess.map((file) => {
  const m = byFile.get(file);
  if (m) return m;
  return { file, garmentType: '', category: '', colorDescription: '', viewGuess: 'front', disposition: 'match', candidates: [], flags: ['no-suggestion'] };
});

const withSugg = items.filter((i) => i.candidates && i.candidates.length).length;
fs.writeFileSync(path.join(RDIR, 'suggestions-manifest.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), count: items.length, items }, null, 2));

console.log(`to-process: ${toProcess.length}`);
console.log(`matched from validation/extra: ${extraResultFiles.length ? byFile.size - harvested : 0}`);
console.log(`harvested from transcripts: ${harvested}`);
console.log(`manifest items: ${items.length} (${withSugg} with suggestions, ${items.length - withSugg} manual-search)`);
