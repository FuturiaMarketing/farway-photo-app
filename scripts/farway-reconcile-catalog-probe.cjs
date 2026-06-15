#!/usr/bin/env node
// Throwaway probe: fetch published WooCommerce catalog (with images) and summarize.
// Read-only. Saves full catalog to data/reconcile/catalog-published.json for reuse.
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env.local');
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

(async () => {
  const env = loadEnv();
  const base = (env.WC_STORE_URL || 'https://farwaymilano.com').replace(/\/$/, '');
  const key = env.WC_CONSUMER_KEY, secret = env.WC_CONSUMER_SECRET;
  if (!key || !secret) throw new Error('WC creds missing in .env.local');

  const all = [];
  for (let page = 1; page < 50; page++) {
    const url = `${base}/wp-json/wc/v3/products?status=publish&per_page=100&page=${page}` +
      `&consumer_key=${encodeURIComponent(key)}&consumer_secret=${encodeURIComponent(secret)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`WC ${res.status} on page ${page}: ${await res.text()}`);
    const batch = await res.json();
    all.push(...batch);
    if (batch.length < 100) break;
  }

  // Pull color attribute options per product
  const norm = (p) => {
    const colorAttr = (p.attributes || []).find(a => /color/i.test(a.name || ''));
    return {
      id: p.id, name: p.name, sku: p.sku, status: p.status, type: p.type,
      categories: (p.categories || []).map(c => ({ id: c.id, name: c.name, slug: c.slug })),
      colors: colorAttr ? colorAttr.options : [],
      images: (p.images || []).map(im => ({ id: im.id, src: im.src, name: im.name, alt: im.alt })),
      permalink: p.permalink,
    };
  };
  const cat = all.map(norm);

  const outDir = path.join(process.cwd(), 'data', 'reconcile');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'catalog-published.json'), JSON.stringify(cat, null, 2));

  // Summary
  const byCat = {};
  for (const p of cat) {
    for (const c of (p.categories.length ? p.categories : [{ name: '(senza categoria)' }])) {
      byCat[c.name] = (byCat[c.name] || 0) + 1;
    }
  }
  const campLike = cat.filter(p => /\((CAMP|DOHA)\)/i.test(p.name));
  const noImages = cat.filter(p => p.images.length === 0);
  const monocolor = cat.filter(p => p.colors.length === 0 || (p.colors.length === 1 && /unico/i.test(p.colors[0])));

  console.log('=== PUBLISHED CATALOG SUMMARY ===');
  console.log('total published:', cat.length);
  console.log('with >=1 image:', cat.length - noImages.length, '| without images:', noImages.length);
  console.log('name contains (CAMP)/(DOHA):', campLike.length, campLike.map(p => p.name).slice(0, 10));
  console.log('monocolor/Unico (no colorway token):', monocolor.length);
  console.log('total images across catalog:', cat.reduce((s, p) => s + p.images.length, 0));
  console.log('\n=== BY CATEGORY ===');
  for (const [name, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(4)}  ${name}`);
  console.log('\n=== SAMPLE PRODUCT ===');
  const sample = cat.find(p => p.images.length && p.colors.length) || cat[0];
  console.log(JSON.stringify({ ...sample, images: sample.images.slice(0, 2) }, null, 2));

  // Verify one image is actually fetchable
  const probe = cat.find(p => p.images.length)?.images[0]?.src;
  if (probe) {
    const r = await fetch(probe, { method: 'HEAD' });
    console.log('\nimage HEAD', r.status, probe.slice(0, 80));
  }
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
