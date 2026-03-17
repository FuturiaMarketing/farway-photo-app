#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs/promises');
const path = require('path');

function parseArgs(argv) {
  const args = {
    applyGallery: false,
    applyDelete: false,
    includeDrafts: false,
    limitProducts: 0,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || '');

    if (value === '--apply-gallery') {
      args.applyGallery = true;
      continue;
    }

    if (value === '--apply-delete') {
      args.applyDelete = true;
      continue;
    }

    if (value === '--include-drafts') {
      args.includeDrafts = true;
      continue;
    }

    if (value === '--limit-products') {
      const parsed = Number(argv[index + 1] || 0);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.limitProducts = Math.round(parsed);
      }
      index += 1;
      continue;
    }
  }

  return args;
}

async function loadEnvFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex <= 0) continue;

      const key = trimmed.slice(0, separatorIndex).trim();
      if (!key || process.env[key]) continue;

      let value = trimmed.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  } catch {
    // optional
  }
}

async function resolveWooSettings() {
  await loadEnvFile(path.join(process.cwd(), '.env.local'));

  const settingsPath = path.join(process.cwd(), 'data', 'woocommerce-settings.json');
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.storeUrl && parsed.consumerKey && parsed.consumerSecret) {
      return {
        storeUrl: String(parsed.storeUrl).replace(/\/$/, ''),
        consumerKey: String(parsed.consumerKey),
        consumerSecret: String(parsed.consumerSecret),
      };
    }
  } catch {
    // fallback env
  }

  const storeUrl = String(process.env.WC_STORE_URL || '').trim().replace(/\/$/, '');
  const consumerKey = String(process.env.WC_CONSUMER_KEY || '').trim();
  const consumerSecret = String(process.env.WC_CONSUMER_SECRET || '').trim();

  if (!storeUrl || !consumerKey || !consumerSecret) {
    throw new Error('Credenziali WooCommerce mancanti (file o env).');
  }

  return { storeUrl, consumerKey, consumerSecret };
}

function resolveWpCredentials() {
  const username = String(process.env.WP_API_USERNAME || process.env.WP_USERNAME || '').trim();
  const appPassword = String(process.env.WP_APP_PASSWORD || '').trim();

  if (!username || !appPassword) {
    return null;
  }

  return { username, appPassword };
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildWooUrl(settings, endpointPath) {
  const authQuery = `consumer_key=${encodeURIComponent(settings.consumerKey)}&consumer_secret=${encodeURIComponent(
    settings.consumerSecret
  )}`;
  const separator = endpointPath.includes('?') ? '&' : '?';
  return `${settings.storeUrl}/wp-json/wc/v3/${endpointPath}${separator}${authQuery}`;
}

async function wooRequest(settings, method, endpointPath, body) {
  const response = await fetchWithTimeout(buildWooUrl(settings, endpointPath), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Woo ${method} ${endpointPath} -> ${response.status}: ${text.slice(0, 260)}`);
  }

  return response.json();
}

async function wooFetchAll(settings, endpointPath) {
  const all = [];
  let page = 1;

  while (true) {
    const list = await wooRequest(
      settings,
      'GET',
      `${endpointPath}${endpointPath.includes('?') ? '&' : '?'}per_page=100&page=${page}`
    );

    if (!Array.isArray(list) || list.length === 0) {
      break;
    }

    all.push(...list);
    if (list.length < 100) {
      break;
    }

    page += 1;
  }

  return all;
}

async function fetchAllVariationsForProduct(settings, productId) {
  const endpoint = `products/${productId}/variations?_fields=id,image`;
  return wooFetchAll(settings, endpoint);
}

function normalizeSrc(src) {
  return String(src || '').trim().replace(/^https?:\/\//i, '').toLowerCase();
}

function dedupeProductImages(images) {
  const seen = new Set();
  const deduped = [];
  const removed = [];

  for (const image of images) {
    const id = Number(image?.id || 0);
    const src = String(image?.src || '').trim();
    const key = id > 0 ? `id:${id}` : `src:${normalizeSrc(src)}`;

    if (!key || key === 'src:') {
      continue;
    }

    if (seen.has(key)) {
      removed.push(image);
      continue;
    }

    seen.add(key);
    deduped.push(image);
  }

  return { deduped, removed };
}

function isLikelyAppPhotoMedia(media) {
  const title = String(media?.title?.rendered || '')
    .toLowerCase()
    .replace(/&[^;]+;/g, ' ');
  const alt = String(media?.alt_text || '').toLowerCase();
  const url = String(media?.source_url || '').toLowerCase();
  const probe = `${title} ${alt} ${url}`;

  return (
    probe.includes('farway milano') ||
    probe.includes('di-farway-milano') ||
    probe.includes('cover-archivio') ||
    probe.includes('cover archivio')
  );
}

async function listWordPressMedia(baseUrl, wpCreds) {
  const auth = Buffer.from(`${wpCreds.username}:${wpCreds.appPassword}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}` };
  const all = [];
  let page = 1;

  while (true) {
    const endpoint = `${baseUrl}/wp-json/wp/v2/media?per_page=100&page=${page}&_fields=id,source_url,title,alt_text,mime_type`;
    const response = await fetchWithTimeout(endpoint, { headers }, 60000);

    if (response.status === 400) {
      // invalid page / end
      break;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`WP media GET page ${page} -> ${response.status}: ${text.slice(0, 240)}`);
    }

    const list = await response.json();
    if (!Array.isArray(list) || list.length === 0) {
      break;
    }

    all.push(...list);
    if (list.length < 100) {
      break;
    }

    page += 1;
  }

  return { all, headers };
}

async function deleteWordPressMedia(baseUrl, mediaId, headers) {
  const endpoint = `${baseUrl}/wp-json/wp/v2/media/${mediaId}?force=true`;
  const response = await fetchWithTimeout(endpoint, { method: 'DELETE', headers }, 60000);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WP media DELETE ${mediaId} -> ${response.status}: ${text.slice(0, 240)}`);
  }
}

async function writeReport(report) {
  const outputDir = path.join(process.cwd(), 'data');
  await fs.mkdir(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(outputDir, `unused-app-media-cleanup-${timestamp}.json`);
  const latestPath = path.join(outputDir, 'unused-app-media-cleanup-latest.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(latestPath, JSON.stringify(report, null, 2), 'utf8');
  return { reportPath, latestPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const woo = await resolveWooSettings();
  const wpCreds = resolveWpCredentials();

  const productStatusFilter = args.includeDrafts ? 'any' : 'publish';
  const report = {
    createdAt: new Date().toISOString(),
    mode: {
      applyGallery: args.applyGallery,
      applyDelete: args.applyDelete,
    },
    scope: {
      includeDrafts: args.includeDrafts,
      limitProducts: args.limitProducts,
    },
    summary: {
      productsScanned: 0,
      productsWithGalleryDuplicates: 0,
      duplicateImagesInProducts: 0,
      galleryDedupeApplied: 0,
      usedProductImageIds: 0,
      usedCategoryImageIds: 0,
      usedVariationImageIds: 0,
      appMediaCandidates: 0,
      unusedAppMedia: 0,
      deletedMedia: 0,
      errors: 0,
    },
    galleryDuplicates: [],
    mediaCandidates: [],
    unusedMedia: [],
    deletedMedia: [],
    warnings: [],
    errors: [],
  };

  console.log(`[cleanup] scan prodotti (status=${productStatusFilter})...`);
  let products = await wooFetchAll(
    woo,
    `products?status=${encodeURIComponent(productStatusFilter)}&_fields=id,name,images`
  );
  if (args.limitProducts > 0) {
    products = products.slice(0, args.limitProducts);
  }

  report.summary.productsScanned = products.length;

  const usedProductImageIds = new Set();
  const usedVariationImageIds = new Set();
  const usedCategoryImageIds = new Set();
  const usedSrcs = new Set();

  for (let index = 0; index < products.length; index += 1) {
    const product = products[index];
    const images = Array.isArray(product.images) ? product.images : [];
    const { deduped, removed } = dedupeProductImages(images);

    for (const image of deduped) {
      const imageId = Number(image?.id || 0);
      if (imageId > 0) {
        usedProductImageIds.add(imageId);
      } else {
        usedSrcs.add(normalizeSrc(image?.src));
      }
    }

    if (removed.length > 0) {
      report.summary.productsWithGalleryDuplicates += 1;
      report.summary.duplicateImagesInProducts += removed.length;
      report.galleryDuplicates.push({
        productId: product.id,
        productName: product.name,
        before: images.length,
        after: deduped.length,
        removed: removed.length,
      });

      if (args.applyGallery) {
        const payloadImages = deduped.map((image) => {
          const imageId = Number(image?.id || 0);
          if (imageId > 0) {
            return { id: imageId };
          }

          return {
            src: String(image?.src || ''),
            name: String(image?.name || ''),
            alt: String(image?.alt || ''),
          };
        });

        await wooRequest(woo, 'PUT', `products/${product.id}`, { images: payloadImages });
        report.summary.galleryDedupeApplied += 1;
      }
    }

    try {
      const variations = await fetchAllVariationsForProduct(woo, product.id);
      for (const variation of variations) {
        const imageId = Number(variation?.image?.id || 0);
        if (imageId > 0) {
          usedVariationImageIds.add(imageId);
        } else if (variation?.image?.src) {
          usedSrcs.add(normalizeSrc(variation.image.src));
        }
      }
    } catch (error) {
      report.errors.push({
        area: 'variations-scan',
        productId: product.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log('[cleanup] scan categorie...');
  const categories = await wooFetchAll(woo, 'products/categories?_fields=id,name,image');
  for (const category of categories) {
    const imageId = Number(category?.image?.id || 0);
    if (imageId > 0) {
      usedCategoryImageIds.add(imageId);
    } else if (category?.image?.src) {
      usedSrcs.add(normalizeSrc(category.image.src));
    }
  }

  report.summary.usedProductImageIds = usedProductImageIds.size;
  report.summary.usedVariationImageIds = usedVariationImageIds.size;
  report.summary.usedCategoryImageIds = usedCategoryImageIds.size;

  if (!wpCreds) {
    report.warnings.push(
      'Credenziali WP API non presenti (WP_API_USERNAME + WP_APP_PASSWORD). Duplicati prodotto analizzati; cleanup Media Library non eseguibile.'
    );
  } else {
    console.log('[cleanup] scan media library WordPress...');
    try {
      const { all: mediaList, headers } = await listWordPressMedia(woo.storeUrl, wpCreds);
      const usedIds = new Set([
        ...Array.from(usedProductImageIds),
        ...Array.from(usedVariationImageIds),
        ...Array.from(usedCategoryImageIds),
      ]);

      const appCandidates = mediaList.filter(isLikelyAppPhotoMedia);
      report.summary.appMediaCandidates = appCandidates.length;

      const unusedAppMedia = appCandidates.filter((media) => {
        const mediaId = Number(media?.id || 0);
        const normalizedSource = normalizeSrc(media?.source_url);

        if (mediaId > 0 && usedIds.has(mediaId)) {
          return false;
        }

        if (normalizedSource && usedSrcs.has(normalizedSource)) {
          return false;
        }

        return true;
      });

      report.summary.unusedAppMedia = unusedAppMedia.length;
      report.mediaCandidates = appCandidates.map((media) => ({
        id: media.id,
        source_url: media.source_url,
        title: media?.title?.rendered || '',
      }));
      report.unusedMedia = unusedAppMedia.map((media) => ({
        id: media.id,
        source_url: media.source_url,
        title: media?.title?.rendered || '',
      }));

      if (args.applyDelete) {
        for (const media of unusedAppMedia) {
          try {
            await deleteWordPressMedia(woo.storeUrl, media.id, headers);
            report.deletedMedia.push({
              id: media.id,
              source_url: media.source_url,
              title: media?.title?.rendered || '',
            });
          } catch (error) {
            report.errors.push({
              area: 'media-delete',
              mediaId: media.id,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }

        report.summary.deletedMedia = report.deletedMedia.length;
      }
    } catch (error) {
      report.errors.push({
        area: 'wp-media-scan',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  report.summary.errors = report.errors.length;
  const { reportPath, latestPath } = await writeReport(report);

  console.log('[cleanup] completato.');
  console.log(`[cleanup] prodotti con duplicati: ${report.summary.productsWithGalleryDuplicates}`);
  console.log(`[cleanup] duplicati in galleria: ${report.summary.duplicateImagesInProducts}`);
  console.log(`[cleanup] app media candidati: ${report.summary.appMediaCandidates}`);
  console.log(`[cleanup] app media non usati: ${report.summary.unusedAppMedia}`);
  console.log(`[cleanup] media eliminati: ${report.summary.deletedMedia}`);
  console.log(`[cleanup] report: ${reportPath}`);
  console.log(`[cleanup] latest: ${latestPath}`);
}

main().catch((error) => {
  console.error('[cleanup] errore fatale:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
