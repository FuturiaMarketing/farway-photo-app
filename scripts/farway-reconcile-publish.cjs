#!/usr/bin/env node
/*
 * Publish deployable reconcile assets into public/reconcile/ so they ship with the Vercel deploy:
 *   - public/reconcile/suggestions-manifest.json   (from data/reconcile/)
 *   - public/reconcile/catalog-slim.json           (from data/reconcile/)
 *   - public/reconcile/stilllife/*.jpg             (copied from data/reconcile/stilllife-thumbs)
 *   - public/reconcile/catalog/*.jpg               (copied from data/reconcile/catalog-thumbs)
 * Idempotent: copies only new/changed-size files.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'data', 'reconcile');
const DST = path.join(ROOT, 'public', 'reconcile');

function copyJson(name) {
  const from = path.join(SRC, name);
  if (!fs.existsSync(from)) { console.warn('missing', name); return; }
  fs.copyFileSync(from, path.join(DST, name));
  console.log('json:', name);
}

function copyThumbs(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  const files = fs.existsSync(srcDir) ? fs.readdirSync(srcDir).filter((f) => /\.jpg$/i.test(f)) : [];
  let copied = 0;
  for (const f of files) {
    const s = path.join(srcDir, f), d = path.join(dstDir, f);
    if (fs.existsSync(d) && fs.statSync(d).size === fs.statSync(s).size) continue;
    fs.copyFileSync(s, d); copied++;
  }
  return { total: files.length, copied };
}

fs.mkdirSync(DST, { recursive: true });
copyJson('suggestions-manifest.json');
copyJson('catalog-slim.json');
const sl = copyThumbs(path.join(SRC, 'stilllife-thumbs'), path.join(DST, 'stilllife'));
const cat = copyThumbs(path.join(SRC, 'catalog-thumbs'), path.join(DST, 'catalog'));
console.log(`stilllife thumbs: ${sl.copied} copied / ${sl.total} total`);
console.log(`catalog thumbs:   ${cat.copied} copied / ${cat.total} total`);
console.log('published ->', DST);
