/**
 * farway-refresh-catalog-snapshot.cjs
 *
 * Fetches all WooCommerce products (with status=publish), their variations,
 * meta_data (incl. fw_materiale, fw_erp_tessuto), categories and attributes.
 * Saves a single normalized JSON snapshot under data/.
 *
 * Usage:
 *   node scripts/farway-refresh-catalog-snapshot.cjs
 *   node scripts/farway-refresh-catalog-snapshot.cjs --status=any
 *
 * Output:
 *   data/products-catalog-snapshot-<YYYYMMDD-HHMMSS>.json
 *   data/products-catalog-snapshot-latest.json (symlink-like overwrite)
 */
const fs = require('fs');
const path = require('path');

function readEnvFile(filePath) {
  const env = {};
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

function nowCompact() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function parseArgs(argv) {
  const out = { status: 'publish' };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--status=')) out.status = a.split('=')[1];
  }
  return out;
}

async function wooRequest(env, endpoint) {
  const base = env.WC_STORE_URL.replace(/\/$/, '');
  const auth = `consumer_key=${env.WC_CONSUMER_KEY}&consumer_secret=${env.WC_CONSUMER_SECRET}`;
  const glue = endpoint.includes('?') ? '&' : '?';
  const url = `${base}${endpoint}${glue}${auth}`;
  const r = await fetch(url);
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw new Error(`WC ${r.status} ${endpoint}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function fetchAllProducts(env, status) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const batch = await wooRequest(env, `/wp-json/wc/v3/products?per_page=100&status=${status}&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

async function fetchAllVariations(env, productId) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const batch = await wooRequest(env, `/wp-json/wc/v3/products/${productId}/variations?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

function pickProductMeta(meta) {
  const wanted = ['fw_materiale', 'fw_erp_tessuto', 'fw_erp_season', 'fw_erp_year', 'fw_erp_is_campionatura', '_erp_sku'];
  const out = {};
  for (const m of meta || []) {
    if (wanted.includes(m.key)) out[m.key] = m.value;
  }
  return out;
}

(async () => {
  const repoRoot = path.resolve(__dirname, '..');
  const envPath = path.join(repoRoot, '.env.local');
  if (!fs.existsSync(envPath)) {
    console.error('Missing .env.local at', envPath);
    process.exit(1);
  }
  const env = readEnvFile(envPath);
  if (!env.WC_STORE_URL || !env.WC_CONSUMER_KEY || !env.WC_CONSUMER_SECRET) {
    console.error('Missing WC_STORE_URL/WC_CONSUMER_KEY/WC_CONSUMER_SECRET in .env.local');
    process.exit(1);
  }
  const args = parseArgs(process.argv);
  console.log(`Fetching products (status=${args.status}) from ${env.WC_STORE_URL}...`);

  const start = Date.now();
  const products = await fetchAllProducts(env, args.status);
  console.log(`  Got ${products.length} products`);

  const snapshot = [];
  let variationsFetched = 0;
  for (const p of products) {
    const cleanCategories = (p.categories || []).map((c) => ({
      id: c.id, name: c.name.replace(/&amp;/g, '&'), slug: c.slug,
    }));
    const cleanAttributes = (p.attributes || []).map((a) => ({
      name: a.name, slug: a.slug, options: a.options || [],
    }));
    const entry = {
      id: p.id,
      type: p.type,
      status: p.status,
      name: p.name,
      slug: p.slug,
      sku: p.sku || '',
      categories: cleanCategories,
      attributes: cleanAttributes,
      meta: pickProductMeta(p.meta_data),
      permalink: p.permalink,
      variations_count: (p.variations || []).length,
      variations: [],
    };
    if (p.type === 'variable' && (p.variations || []).length > 0) {
      const variations = await fetchAllVariations(env, p.id);
      variationsFetched += variations.length;
      entry.variations = variations.map((v) => ({
        id: v.id,
        sku: v.sku || '',
        attributes: (v.attributes || []).map((a) => ({ name: a.name, slug: a.slug, option: a.option })),
        meta: pickProductMeta(v.meta_data),
        regular_price: v.regular_price,
        stock_status: v.stock_status,
      }));
    }
    snapshot.push(entry);
    if (snapshot.length % 25 === 0) {
      console.log(`  Snapshot progress: ${snapshot.length}/${products.length} products`);
    }
  }

  const ts = nowCompact();
  const dataDir = path.join(repoRoot, 'data');
  const fileTs = path.join(dataDir, `products-catalog-snapshot-${ts}.json`);
  const fileLatest = path.join(dataDir, 'products-catalog-snapshot-latest.json');
  fs.writeFileSync(fileTs, JSON.stringify(snapshot, null, 2));
  fs.writeFileSync(fileLatest, JSON.stringify(snapshot, null, 2));

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('---');
  console.log(`Done in ${elapsed}s`);
  console.log(`  Products: ${snapshot.length}`);
  console.log(`  Variations: ${variationsFetched}`);
  console.log(`  Snapshot: ${fileTs}`);
  console.log(`  Latest:   ${fileLatest}`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
