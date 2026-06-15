#!/usr/bin/env node
/*
 * Reconcile PREP — deterministic, idempotent, read-only on originals.
 * Inputs:  data/reconcile/catalog-published.json (from farway-reconcile-catalog-probe.cjs)
 *          STILL_LIFE_DIR (the Drive folder of still-life photos)
 * Outputs: data/reconcile/reference-index.json      (per product/colorway catalog refs)
 *          data/reconcile/to-process.json           (still-life files needing a match)
 *          data/reconcile/stilllife-thumbs/*.jpg     (~896px thumbs of to-process photos)
 *          data/reconcile/catalog-thumbs/*.jpg        (~640px thumbs of per-colorway refs)
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = process.cwd();
const RDIR = path.join(ROOT, 'data', 'reconcile');
const STILL_LIFE_DIR = process.env.STILL_LIFE_DIR ||
  'D:\\GoogleDrive\\Futuria at work\\Clienti e progetti\\Farway Milano\\Website\\Sito Next\\Foto still life sfondo chiaro';

const slug = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const POSES = ['Front', 'Back', 'Retro', 'Risvolto', 'Dettaglio', 'Lato', 'Side', 'Detail'];

function buildReferenceIndex(catalog) {
  const index = [];
  for (const p of catalog) {
    const colors = (p.colors || []).filter(Boolean);
    const isMono = colors.length === 0 || (colors.length === 1 && /unico/i.test(colors[0]));
    const colorways = isMono ? [null] : colors;
    const refs = [];
    for (const cw of colorways) {
      // pick catalog images whose name/alt/src mention this colorway (or all, if mono)
      const imgs = (p.images || []).filter((im) => {
        if (cw === null) return true;
        const hay = `${im.name || ''} ${im.alt || ''} ${im.src || ''}`;
        return hay.toLowerCase().includes(cw.toLowerCase());
      });
      // detect pose from name
      const withPose = imgs.map((im) => {
        const hay = `${im.name || ''} ${im.src || ''}`;
        const pose = POSES.find((ps) => new RegExp(`\\b${ps}\\b`, 'i').test(hay)) || '';
        return { ...im, pose };
      });
      // prefer a Front image as the primary reference
      const primary = withPose.find((i) => /front/i.test(i.pose)) || withPose[0];
      refs.push({
        colorway: cw,
        imageCount: withPose.length,
        primarySrc: primary ? primary.src : null,
        primaryName: primary ? primary.name : null,
        allSrc: withPose.map((i) => i.src),
      });
    }
    const productPrimarySrc = (p.images && p.images[0] && p.images[0].src) || null;
    index.push({
      id: p.id, name: p.name, sku: p.sku,
      categories: (p.categories || []).map((c) => c.name),
      isMono, colorways: refs, productPrimarySrc, permalink: p.permalink,
    });
  }
  return index;
}

function listToProcess() {
  const files = fs.readdirSync(STILL_LIFE_DIR).filter((f) => /\.jpg$/i.test(f));
  return files.filter((f) =>
    !/-di-Farway-Milano\.jpg$/i.test(f) &&          // already renamed to standard
    !/^anteprima-rembg-pagina/i.test(f)             // contact-sheet artifacts
  ).sort();
}

async function makeThumb(srcPath, outPath, longEdge, quality) {
  if (fs.existsSync(outPath)) return 'skip';
  await sharp(srcPath).rotate().resize(longEdge, longEdge, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality }).toFile(outPath);
  return 'ok';
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

(async () => {
  fs.mkdirSync(RDIR, { recursive: true });
  const slDir = path.join(RDIR, 'stilllife-thumbs'); fs.mkdirSync(slDir, { recursive: true });
  const catDir = path.join(RDIR, 'catalog-thumbs'); fs.mkdirSync(catDir, { recursive: true });

  const catalog = JSON.parse(fs.readFileSync(path.join(RDIR, 'catalog-published.json'), 'utf8'));
  const index = buildReferenceIndex(catalog);
  fs.writeFileSync(path.join(RDIR, 'reference-index.json'), JSON.stringify(index, null, 2));

  const toProcess = listToProcess();
  fs.writeFileSync(path.join(RDIR, 'to-process.json'), JSON.stringify(toProcess, null, 2));

  // 1) still-life thumbs
  let slOk = 0, slSkip = 0, slErr = 0;
  await pool(toProcess, 8, async (f) => {
    try {
      const r = await makeThumb(path.join(STILL_LIFE_DIR, f), path.join(slDir, f), 896, 82);
      r === 'ok' ? slOk++ : slSkip++;
    } catch (e) { slErr++; console.error('SL thumb fail', f, e.message); }
  });

  // 2) catalog colorway-front thumbs (download src -> resize)
  const refTargets = [];
  const seen = new Set();
  const addTarget = (url, fn) => {
    if (!url || seen.has(fn)) return; seen.add(fn);
    refTargets.push({ url, out: path.join(catDir, fn), key: fn });
  };
  for (const p of index) {
    addTarget(p.productPrimarySrc, `${p.id}__primary.jpg`);   // guarantee one thumb per product
    for (const cw of p.colorways) {
      if (!cw.primarySrc) continue;
      addTarget(cw.primarySrc, `${p.id}__${slug(cw.colorway || 'unico')}.jpg`);
    }
  }
  let cOk = 0, cSkip = 0, cErr = 0;
  await pool(refTargets, 12, async (t) => {
    try {
      if (fs.existsSync(t.out)) { cSkip++; return; }
      const res = await fetch(t.url);
      if (!res.ok) { cErr++; return; }
      const buf = Buffer.from(await res.arrayBuffer());
      await sharp(buf).resize(640, 640, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(t.out);
      cOk++;
    } catch (e) { cErr++; console.error('cat thumb fail', t.key, e.message); }
  });

  console.log('reference-index products:', index.length,
    '| (product,colorway) pairs:', index.reduce((s, p) => s + p.colorways.length, 0));
  console.log('to-process still-life files:', toProcess.length);
  console.log('still-life thumbs  ok/skip/err:', slOk, slSkip, slErr);
  console.log('catalog thumbs     ok/skip/err:', cOk, cSkip, cErr, '/ targets', refTargets.length);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
