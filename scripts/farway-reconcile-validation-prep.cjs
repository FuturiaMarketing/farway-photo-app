#!/usr/bin/env node
// Build slim catalog index for matcher agents + thumbnail the 7 known-answer files +
// assemble a ~20-photo validation set (7 known ground-truth + sampled unknowns).
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = process.cwd();
const RDIR = path.join(ROOT, 'data', 'reconcile');
const STILL_LIFE_DIR = process.env.STILL_LIFE_DIR ||
  'D:\\GoogleDrive\\Futuria at work\\Clienti e progetti\\Farway Milano\\Website\\Sito Next\\Foto still life sfondo chiaro';

const slug = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');

(async () => {
  const index = JSON.parse(fs.readFileSync(path.join(RDIR, 'reference-index.json'), 'utf8'));
  const have = new Set(fs.readdirSync(path.join(RDIR, 'catalog-thumbs')));

  // slim index with EXACT thumb filenames the agent can Read
  const slim = index.map((p) => ({
    id: p.id, name: p.name, sku: p.sku, categories: p.categories, isMono: p.isMono,
    primaryThumb: have.has(`${p.id}__primary.jpg`) ? `${p.id}__primary.jpg` : null,
    colorways: p.colorways.map((c) => {
      const fn = `${p.id}__${slug(c.colorway || 'unico')}.jpg`;
      return { colorway: c.colorway, thumb: have.has(fn) ? fn : null };
    }),
  }));
  fs.writeFileSync(path.join(RDIR, 'catalog-slim.json'), JSON.stringify(slim, null, 2));

  // thumbnail the 7 already-renamed (ground-truth) files
  const slDir = path.join(RDIR, 'stilllife-thumbs');
  const known = fs.readdirSync(STILL_LIFE_DIR).filter((f) => /-di-Farway-Milano\.jpg$/i.test(f));
  for (const f of known) {
    const out = path.join(slDir, f);
    if (!fs.existsSync(out)) {
      await sharp(path.join(STILL_LIFE_DIR, f)).rotate()
        .resize(896, 896, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(out);
    }
  }

  // validation set
  const toProcess = JSON.parse(fs.readFileSync(path.join(RDIR, 'to-process.json'), 'utf8'));
  const giraffe = toProcess.filter((f) => /giraffe|giall/i.test(f) && !/massima-qualita/i.test(f));
  const dsc = toProcess.filter((f) => /^DSC/i.test(f)).slice(0, 4);
  const and = toProcess.filter((f) => /^_AND/i.test(f)).slice(0, 5);
  const unknownSample = [...new Set([...giraffe, ...dsc, ...and])];

  const validation = {
    known: known.map((f) => ({ file: f, groundTruth: f.replace(/-still-life-.*/, '').replace(/-/g, ' ') })),
    unknown: unknownSample.map((f) => ({ file: f })),
  };
  fs.writeFileSync(path.join(RDIR, 'validation-set.json'), JSON.stringify(validation, null, 2));

  console.log('catalog-slim products:', slim.length);
  console.log('known (ground-truth) files:', known.length);
  console.log('unknown sample:', unknownSample.length, unknownSample);
  console.log('TOTAL validation:', known.length + unknownSample.length);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
