/**
 * farway-generate-sku-mapping.cjs
 *
 * Reads:
 *   data/products-catalog-snapshot-latest.json
 *   data/farway-sku-lookups.json
 *
 * Produces:
 *   data/farway-sku-mapping-<TS>.csv         — parent + variations with new_sku
 *   data/farway-sku-mapping-latest.csv       — copy
 *   data/farway-numeric-models-<TS>.json     — registry of numeric MOD assignments
 *   data/farway-numeric-models-latest.json   — copy
 *
 * No write to WC. Pure offline transformation.
 */
const fs = require('fs');
const path = require('path');

function nowCompact() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function writeCsv(filePath, rows) {
  if (rows.length === 0) { fs.writeFileSync(filePath, ''); return; }
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

function normalize(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function buildCategorySlugToCat(lookups) {
  const map = new Map();
  for (const [code, def] of Object.entries(lookups.cat)) {
    for (const slug of def.wc_category_slugs || []) map.set(slug.toLowerCase(), code);
  }
  return map;
}

const NAME_TO_CAT = [
  [/\bpantaloncin/i, 'PAS'],
  [/\bpantalocino\b/i, 'PAS'],
  [/\bpantalon|\bpants\b/i, 'PAN'],
  [/\bcamici|\bcamicett|\bbluse/i, 'CAM'],
  [/\babito|\babiti/i, 'ABI'],
  [/\btutina|\bbody\b/i, 'BOD'],
  [/\bfelpa|\bcardigan|\bmaglia\b|\bmaglieria|\bmaglia\sfelpata/i, 'FEL'],
  [/\bgonna|\bsalopette/i, 'GON'],
  [/\bgiacca|\bgiacche\b/i, 'GIA'],
  [/\bt-shirt|\btshirt\b|\btop\b|\bmaglietta/i, 'TSH'],
  [/\bscrunchies/i, 'SCR'],
  [/\bcerchietto|\bcerchietti/i, 'CER'],
  [/\bfiocco|\bfermaglio/i, 'FIO'],
  [/\bborsa|\byes\sbag\b|\bbag\b/i, 'BOR'],
  [/\bsopravveste/i, 'GIA'],
  [/\bcappello/i, 'ACC'],
  [/^(FARY-)?AB\d/i, 'ABI'],
  [/^(FARY-)?CAM\d/i, 'CAM'],
  [/^(FARY-)?PAN\d/i, 'PAN'],
  [/^(FARY-)?TSH\d/i, 'TSH'],
  [/^(FARY-)?TUT\d|tutina\sbimb/i, 'BOD'],
  [/^GON\d|gonna\s\d/i, 'GON'],
  [/^SAL\d/i, 'GON'],
  [/^PTC\d/i, 'PAS'],
  [/^MANICA\b|\belegante\b|\bcolletto/i, 'CAM'],
  [/\btuta\sbianca/i, 'BOD'],
  [/^FCM\d/i, 'FEL'],
  [/^FARY-FCM\d/i, 'FEL'],
  [/^MCA\d/i, 'TSH'],
];

function resolveCat(product, lookups, slugMap) {
  const priority = lookups.category_routing_priority;
  const slugs = (product.categories || []).map((c) => (c.slug || '').toLowerCase());
  for (const prio of priority) {
    if (slugs.includes(prio.toLowerCase())) {
      const cat = slugMap.get(prio.toLowerCase());
      if (cat) return { cat, source: `category:${prio}` };
    }
  }
  for (const s of slugs) {
    const cat = slugMap.get(s);
    if (cat) return { cat, source: `category:${s}` };
  }
  const name = product.name || '';
  for (const [rx, code] of NAME_TO_CAT) {
    if (rx.test(name)) return { cat: code, source: `name:${rx.source}` };
  }
  return { cat: 'ACC', source: 'fallback' };
}

function resolveMod(product, lookups, numericRegistry, cat, seedMaxRef) {
  const name = normalize(product.name);
  for (const [code, def] of Object.entries(lookups.mod_known)) {
    const patterns = def.name_patterns || [];
    for (const pat of patterns) {
      if (name.includes(normalize(pat))) return { mod: code, source: `name:${pat}`, confidence: 'known' };
    }
  }
  for (const [code, def] of Object.entries(lookups.mod_known)) {
    const autoCats = def.auto_for_categories || [];
    if (autoCats.includes(cat)) return { mod: code, source: `auto_cat:${cat}`, confidence: 'known' };
  }
  if (numericRegistry.has(product.id)) {
    return { mod: numericRegistry.get(product.id), source: 'numeric_existing', confidence: 'numeric' };
  }
  seedMaxRef.value += 1;
  const code = String(seedMaxRef.value).padStart(3, '0');
  numericRegistry.set(product.id, code);
  return { mod: code, source: 'numeric_new', confidence: 'numeric' };
}

function buildMaterialSlugToTes(lookups) {
  const map = new Map();
  for (const [code, def] of Object.entries(lookups.tes)) {
    for (const slug of def.fw_materiale_slugs || []) map.set(slug.toLowerCase(), code);
  }
  return map;
}

function resolveTes(product, lookups, matMap) {
  const meta = product.meta || {};
  let raw = meta.fw_materiale;
  let source = 'fw_materiale';
  let multi = '';
  if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0)) {
    raw = meta.fw_erp_tessuto;
    source = raw ? 'fw_erp_tessuto' : 'fallback';
  }
  if (raw === undefined || raw === null || raw === '') return { tes: 'MIS', source: 'fallback', multi: '' };
  let value;
  if (Array.isArray(raw)) {
    multi = raw.length > 1 ? raw.join('|') : '';
    value = String(raw[0] || '').toLowerCase();
  } else {
    value = String(raw).toLowerCase();
  }
  value = value.replace(/\s+/g, '_');
  const code = matMap.get(value);
  if (code) return { tes: code, source, multi };
  for (const [slug, c] of matMap.entries()) {
    if (value.includes(slug)) return { tes: c, source: `${source}:partial`, multi };
  }
  return { tes: 'MIS', source: `${source}:unknown:${value}`, multi };
}

function buildOptionToCol(lookups) {
  const map = new Map();
  for (const [code, def] of Object.entries(lookups.col)) {
    for (const v of def.wc_option_values || []) map.set(normalize(v), code);
  }
  return map;
}

function buildOptionToTag(lookups) {
  const map = new Map();
  for (const [code, def] of Object.entries(lookups.tag)) {
    for (const v of def.wc_option_values || []) map.set(normalize(v), code);
  }
  return map;
}

function findAttr(attrs, candidates) {
  for (const a of attrs || []) {
    const slug = (a.slug || '').toLowerCase();
    const name = normalize(a.name || '');
    for (const c of candidates) {
      if (slug === c.slug || name === c.name) return a;
    }
  }
  return null;
}

function findColInName(name, colMap) {
  const nm = normalize(name);
  for (const [optNorm, code] of colMap.entries()) {
    if (optNorm && nm.includes(optNorm)) return { code, raw: optNorm };
  }
  return null;
}

function findTagInName(name, tagMap) {
  const nm = normalize(name);
  const sorted = [...tagMap.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [optNorm, code] of sorted) {
    if (!optNorm) continue;
    if (!/anni|anno|mesi|one size|unica/.test(optNorm)) continue;
    if (nm.includes(optNorm)) return { code, raw: optNorm };
  }
  return null;
}

function resolveColTagForVariation(variation, parent, colMap, tagMap) {
  const cAttr = findAttr(variation.attributes, [
    { slug: 'pa_colore', name: 'colore' }, { slug: 'colore', name: 'colore' },
  ]);
  const sAttr = findAttr(variation.attributes, [
    { slug: 'pa_taglia', name: 'taglia' }, { slug: 'taglia', name: 'taglia' },
  ]);
  let colRaw = cAttr ? normalize(cAttr.option) : '';
  const tagRawAttr = sAttr ? normalize(sAttr.option) : '';
  let col = colMap.get(colRaw) || 'MIS';
  let tag = tagMap.get(tagRawAttr) || (sAttr ? null : 'OSI_pending');
  let colSource = cAttr ? 'variation_attr' : 'no_attr';
  let tagSource = sAttr ? 'variation_attr' : 'no_attr';
  if ((col === 'MIS' || tag === 'OSI_pending' || tag === null) && parent) {
    if (col === 'MIS') {
      const hit = findColInName(parent.name, colMap);
      if (hit) { col = hit.code; colSource = 'parent_name'; colRaw = hit.raw; }
    }
    if (tag === 'OSI_pending' || tag === null) {
      const hit = findTagInName(parent.name, tagMap);
      if (hit) { tag = hit.code; tagSource = 'parent_name'; }
    }
  }
  if (tag === 'OSI_pending' || tag === null) tag = 'OSI';
  return { col, tag, colRaw, tagRaw: sAttr ? sAttr.option : '', colSource, tagSource };
}

function resolveColTagForSimple(product, colMap, tagMap) {
  const cHit = findColInName(product.name, colMap);
  const tHit = findTagInName(product.name, tagMap);
  return {
    col: cHit ? cHit.code : 'MIS',
    tag: tHit ? tHit.code : 'OSI',
    colRaw: cHit ? cHit.raw : '',
    tagRaw: tHit ? tHit.raw : '',
  };
}

function looksLikeAutoSlug(s) {
  if (!s) return false;
  if (!s.includes('-')) return false;
  if (s.length < 12) return false;
  if (/[a-z]/.test(s)) return true;
  return false;
}

function looksLikeErpCode(s) {
  if (!s) return false;
  if (/^[A-Z]{2,}[A-Z0-9]{3,}\d{2}$/.test(s)) return true;
  if (/^[A-Z]{2}[A-Z]+\d{2,}$/.test(s)) return true;
  return false;
}

(async () => {
  const repoRoot = path.resolve(__dirname, '..');
  const dataDir = path.join(repoRoot, 'data');
  const snapshotPath = path.join(dataDir, 'products-catalog-snapshot-latest.json');
  const lookupsPath = path.join(dataDir, 'farway-sku-lookups.json');

  if (!fs.existsSync(snapshotPath)) { console.error('Missing', snapshotPath); process.exit(1); }
  if (!fs.existsSync(lookupsPath)) { console.error('Missing', lookupsPath); process.exit(1); }

  const products = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const lookups = JSON.parse(fs.readFileSync(lookupsPath, 'utf8'));

  const slugToCat = buildCategorySlugToCat(lookups);
  const matToTes = buildMaterialSlugToTes(lookups);
  const optToCol = buildOptionToCol(lookups);
  const optToTag = buildOptionToTag(lookups);
  const numericRegistry = new Map();

  const prevNumericPath = path.join(dataDir, 'farway-numeric-models-latest.json');
  let seedMax = 0;
  if (fs.existsSync(prevNumericPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(prevNumericPath, 'utf8'));
      for (const it of prev.items || []) {
        numericRegistry.set(it.wc_product_id, it.code);
        const n = parseInt(it.code, 10);
        if (Number.isFinite(n) && n > seedMax) seedMax = n;
      }
      console.log(`Seeded numeric registry from previous run: ${numericRegistry.size} entries, next free=${seedMax + 1}`);
    } catch (e) { console.warn('Failed to seed numeric registry:', e.message); }
  }

  console.log(`Products: ${products.length}`);
  console.log(`Lookups: CAT=${Object.keys(lookups.cat).length} MOD_known=${Object.keys(lookups.mod_known).length} TES=${Object.keys(lookups.tes).length} COL=${Object.keys(lookups.col).length} TAG=${Object.keys(lookups.tag).length}`);

  const rows = [];
  const skuUsage = new Map();

  function recordSku(sku) {
    skuUsage.set(sku, (skuUsage.get(sku) || 0) + 1);
  }

  const seedMaxRef = { value: seedMax };
  for (const p of products) {
    const { cat, source: catSrc } = resolveCat(p, lookups, slugToCat);
    const { mod, source: modSrc, confidence: modConf } = resolveMod(p, lookups, numericRegistry, cat, seedMaxRef);
    const { tes, source: tesSrc, multi: tesMulti } = resolveTes(p, lookups, matToTes);
    const parentSku = `${cat}-${mod}-${tes}`;
    recordSku(parentSku);
    const baseRow = {
      product_id: p.id,
      variation_id: '',
      scope: 'parent',
      type: p.type,
      product_name: p.name,
      variant_attrs: '',
      current_sku: p.sku || '',
      new_sku: parentSku,
      cat, mod, tes, col: '', tag: '',
      cat_source: catSrc,
      mod_source: modSrc,
      tes_source: tesSrc,
      tes_multi_raw: tesMulti,
      confidence: modConf === 'numeric' ? 'numeric_progressive' : 'auto',
      erp_sku_candidate: looksLikeErpCode(p.sku) ? p.sku : '',
      notes: '',
    };

    if (p.type === 'variable' && (p.variations || []).length > 0) {
      rows.push(baseRow);
      for (const v of p.variations) {
        const ct = resolveColTagForVariation(v, p, optToCol, optToTag);
        const variantSku = `${cat}-${mod}-${tes}-${ct.col}-${ct.tag}`;
        recordSku(variantSku);
        const attrStr = (v.attributes || []).map((a) => `${a.name}=${a.option}`).join(' | ');
        rows.push({
          product_id: p.id,
          variation_id: v.id,
          scope: 'variation',
          type: 'variation',
          product_name: p.name,
          variant_attrs: attrStr,
          current_sku: v.sku || '',
          new_sku: variantSku,
          cat, mod, tes, col: ct.col, tag: ct.tag,
          cat_source: catSrc,
          mod_source: modSrc,
          tes_source: tesSrc,
          tes_multi_raw: tesMulti,
          confidence: (ct.col === 'MIS' || ct.tag === 'OSI' && (v.attributes || []).some((a) => /taglia/i.test(a.name))) ? 'review' : 'auto',
          erp_sku_candidate: looksLikeErpCode(v.sku) ? v.sku : '',
          notes: `colRaw=${ct.colRaw} tagRaw=${ct.tagRaw}`,
        });
      }
    } else {
      const ct = resolveColTagForSimple(p, optToCol, optToTag);
      const simpleSku = `${cat}-${mod}-${tes}-${ct.col}-${ct.tag}`;
      recordSku(simpleSku);
      rows.push({
        ...baseRow,
        scope: 'simple',
        new_sku: simpleSku,
        col: ct.col,
        tag: ct.tag,
        confidence: ct.col === 'MIS' ? 'review' : 'auto',
        notes: `colFromName=${ct.colRaw}`,
      });
    }
  }

  const collisions = new Map();
  for (const [sku, n] of skuUsage.entries()) if (n > 1) collisions.set(sku, n);

  if (collisions.size > 0) {
    console.log(`Collisions detected on ${collisions.size} SKUs. Applying -A/-B/-C suffixes...`);
    const counter = new Map();
    for (const r of rows) {
      if (!collisions.has(r.new_sku)) continue;
      const cur = counter.get(r.new_sku) || 0;
      const suffix = String.fromCharCode(65 + cur);
      counter.set(r.new_sku, cur + 1);
      const original = r.new_sku;
      r.new_sku = `${original}-${suffix}`;
      r.notes = (r.notes ? r.notes + ' | ' : '') + `collision_with:${original} suffix:${suffix}`;
      r.confidence = 'review';
    }
  }

  const ts = nowCompact();
  const csvPath = path.join(dataDir, `farway-sku-mapping-${ts}.csv`);
  const csvLatest = path.join(dataDir, 'farway-sku-mapping-latest.csv');
  writeCsv(csvPath, rows);
  writeCsv(csvLatest, rows);

  const numericModels = [];
  for (const [pid, code] of numericRegistry.entries()) {
    const p = products.find((x) => x.id === pid);
    numericModels.push({ code, wc_product_id: pid, product_name: p ? p.name : '', sku_parent_hint: rows.find((r) => r.product_id === pid && (r.scope === 'parent' || r.scope === 'simple'))?.new_sku || '' });
  }
  numericModels.sort((a, b) => a.code.localeCompare(b.code));
  const nmTs = path.join(dataDir, `farway-numeric-models-${ts}.json`);
  const nmLatest = path.join(dataDir, 'farway-numeric-models-latest.json');
  fs.writeFileSync(nmTs, JSON.stringify({ generated_at: ts, count: numericModels.length, items: numericModels }, null, 2));
  fs.writeFileSync(nmLatest, JSON.stringify({ generated_at: ts, count: numericModels.length, items: numericModels }, null, 2));

  console.log('---');
  console.log(`Rows: ${rows.length} (parent/simple: ${rows.filter((r) => r.scope !== 'variation').length}, variations: ${rows.filter((r) => r.scope === 'variation').length})`);
  console.log(`Numeric MOD assignments: ${numericModels.length}`);
  console.log(`Collisions resolved: ${collisions.size}`);
  console.log(`Confidence distribution:`);
  const conf = {};
  for (const r of rows) conf[r.confidence] = (conf[r.confidence] || 0) + 1;
  for (const [k, v] of Object.entries(conf)) console.log(`  ${k}: ${v}`);
  console.log(`Mapping: ${csvPath}`);
  console.log(`Numeric: ${nmTs}`);
})().catch((e) => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
