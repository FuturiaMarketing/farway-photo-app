#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

function parseArgs(argv) {
  const args = {
    scope: 'all',
    minLongEdge: 2048,
    apply: false,
    limitProducts: 0,
    limitCategories: 0,
    appUrl: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || '');

    if (value === '--apply') {
      args.apply = true;
      continue;
    }

    if (value === '--scope') {
      args.scope = String(argv[index + 1] || 'all').toLowerCase();
      index += 1;
      continue;
    }

    if (value === '--min-long-edge') {
      const parsed = Number(argv[index + 1] || 0);
      if (Number.isFinite(parsed) && parsed >= 512) {
        args.minLongEdge = Math.round(parsed);
      }
      index += 1;
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

    if (value === '--limit-categories') {
      const parsed = Number(argv[index + 1] || 0);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.limitCategories = Math.round(parsed);
      }
      index += 1;
      continue;
    }

    if (value === '--app-url') {
      args.appUrl = String(argv[index + 1] || '').trim().replace(/\/$/, '');
      index += 1;
      continue;
    }
  }

  if (!['all', 'products', 'categories'].includes(args.scope)) {
    args.scope = 'all';
  }

  return args;
}

async function readWooSettings() {
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
    throw new Error(
      'Credenziali WooCommerce mancanti. Configura data/woocommerce-settings.json oppure WC_STORE_URL/WC_CONSUMER_KEY/WC_CONSUMER_SECRET.'
    );
  }

  return { storeUrl, consumerKey, consumerSecret };
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 30000) {
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
  const response = await fetchWithTimeout(
    buildWooUrl(settings, endpointPath),
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    },
    60000
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Woo API ${method} ${endpointPath} -> ${response.status}: ${text.slice(0, 280)}`);
  }

  return response.json();
}

async function wooFetchAll(settings, endpointPath) {
  const results = [];
  let page = 1;

  while (true) {
    const current = await wooRequest(settings, 'GET', `${endpointPath}${endpointPath.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(current) || current.length === 0) {
      break;
    }

    results.push(...current);
    if (current.length < 100) {
      break;
    }

    page += 1;
  }

  return results;
}

async function probeImage(src) {
  const response = await fetchWithTimeout(
    src,
    {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    },
    45000
  );

  if (!response.ok) {
    throw new Error(`Download immagine fallito (${response.status})`);
  }

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const bytes = Buffer.from(await response.arrayBuffer());
  const metadata = await sharp(bytes).metadata();

  return {
    bytes,
    contentType,
    width: metadata.width || 0,
    height: metadata.height || 0,
    format: String(metadata.format || '').toLowerCase(),
    hasAlpha: Boolean(metadata.hasAlpha),
  };
}

async function upscaleImage(bytes, probe, minLongEdge) {
  const sourceWidth = probe.width;
  const sourceHeight = probe.height;
  const longEdge = Math.max(sourceWidth, sourceHeight);
  const scale = minLongEdge / longEdge;
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  let pipeline = sharp(bytes).resize({
    width,
    height,
    fit: 'fill',
    kernel: sharp.kernel.lanczos3,
    withoutEnlargement: false,
  });

  const format = probe.format;
  if (format === 'png') {
    pipeline = pipeline.png({
      compressionLevel: 9,
      adaptiveFiltering: true,
      palette: false,
    });

    return {
      bytes: await pipeline.toBuffer(),
      mimeType: 'image/png',
      extension: 'png',
      width,
      height,
    };
  }

  if (format === 'webp') {
    pipeline = pipeline.webp({
      quality: 98,
      alphaQuality: 100,
      nearLossless: true,
      smartSubsample: true,
    });

    return {
      bytes: await pipeline.toBuffer(),
      mimeType: 'image/webp',
      extension: 'webp',
      width,
      height,
    };
  }

  pipeline = pipeline.jpeg({
    quality: 96,
    mozjpeg: true,
    chromaSubsampling: '4:4:4',
  });

  return {
    bytes: await pipeline.toBuffer(),
    mimeType: 'image/jpeg',
    extension: 'jpg',
    width,
    height,
  };
}

function bufferToDataUrl(buffer, mimeType) {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function sanitizeFileName(value) {
  return (
    String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'image'
  );
}

async function uploadRetrofittedImage(appUrl, payload) {
  const response = await fetchWithTimeout(
    `${appUrl}/api/settings/reference-image`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    60000
  );

  const text = await response.text();
  let parsed = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {};
    }
  }

  if (!response.ok || !parsed.url) {
    const reason = parsed.error || text || `HTTP ${response.status}`;
    throw new Error(`Upload retrofit fallito: ${reason}`);
  }

  return parsed.url;
}

async function maybeSleep(ms) {
  if (!ms || ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function processProduct(settings, appUrl, product, options, report) {
  const images = Array.isArray(product.images) ? product.images : [];
  if (images.length === 0) {
    return;
  }

  const replacements = [];

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const src = String(image?.src || '').trim();
    if (!src) {
      continue;
    }

    try {
      const probe = await probeImage(src);
      const longEdge = Math.max(probe.width, probe.height);
      const underThreshold = longEdge > 0 && longEdge < options.minLongEdge;

      if (!underThreshold) {
        continue;
      }

      const issue = {
        entityType: 'product',
        entityId: product.id,
        entityName: String(product.name || `product-${product.id}`),
        imageIndex: index,
        imageId: Number(image.id || 0) || null,
        sourceUrl: src,
        width: probe.width,
        height: probe.height,
        longEdge,
        minLongEdge: options.minLongEdge,
      };

      report.issues.push(issue);

      if (!options.apply) {
        continue;
      }

      const upscaled = await upscaleImage(probe.bytes, probe, options.minLongEdge);
      const fileBase = sanitizeFileName(`retrofit-product-${product.id}-${index + 1}-${Date.now()}`);
      const uploadedUrl = await uploadRetrofittedImage(appUrl, {
        projectId: 'quality-retrofit',
        settingId: `product_${product.id}_${index}_${Date.now()}`,
        namespace: 'quality-retrofit',
        fileName: `${fileBase}.${upscaled.extension}`,
        dataUrl: bufferToDataUrl(upscaled.bytes, upscaled.mimeType),
      });

      replacements.push({
        index,
        src: uploadedUrl,
        name: String(image.name || `${product.name} image ${index + 1}`),
        alt: String(image.alt || image.name || product.name || `Prodotto ${product.id}`),
        before: { width: probe.width, height: probe.height },
        after: { width: upscaled.width, height: upscaled.height },
      });
    } catch (error) {
      report.errors.push({
        entityType: 'product',
        entityId: product.id,
        sourceUrl: src,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    await maybeSleep(60);
  }

  if (!options.apply || replacements.length === 0) {
    return;
  }

  const replacementMap = new Map(replacements.map((entry) => [entry.index, entry]));
  const updatedImages = images.map((image, index) => {
    const replacement = replacementMap.get(index);
    if (replacement) {
      return {
        src: replacement.src,
        name: replacement.name,
        alt: replacement.alt,
      };
    }

    if (typeof image.id === 'number' && image.id > 0) {
      return { id: image.id };
    }

    return {
      src: String(image.src || ''),
      name: String(image.name || ''),
      alt: String(image.alt || ''),
    };
  });

  await wooRequest(settings, 'PUT', `products/${product.id}`, { images: updatedImages });

  report.applied.push({
    entityType: 'product',
    entityId: product.id,
    entityName: String(product.name || `product-${product.id}`),
    replacements: replacements.length,
  });
}

async function processCategory(settings, appUrl, category, options, report) {
  const image = category?.image || null;
  const src = String(image?.src || '').trim();
  if (!src) {
    return;
  }

  try {
    const probe = await probeImage(src);
    const longEdge = Math.max(probe.width, probe.height);
    const underThreshold = longEdge > 0 && longEdge < options.minLongEdge;

    if (!underThreshold) {
      return;
    }

    report.issues.push({
      entityType: 'category',
      entityId: category.id,
      entityName: String(category.name || `category-${category.id}`),
      imageIndex: 0,
      imageId: Number(image.id || 0) || null,
      sourceUrl: src,
      width: probe.width,
      height: probe.height,
      longEdge,
      minLongEdge: options.minLongEdge,
    });

    if (!options.apply) {
      return;
    }

    const upscaled = await upscaleImage(probe.bytes, probe, options.minLongEdge);
    const fileBase = sanitizeFileName(`retrofit-category-${category.id}-${Date.now()}`);
    const uploadedUrl = await uploadRetrofittedImage(appUrl, {
      projectId: 'quality-retrofit',
      settingId: `category_${category.id}_${Date.now()}`,
      namespace: 'quality-retrofit',
      fileName: `${fileBase}.${upscaled.extension}`,
      dataUrl: bufferToDataUrl(upscaled.bytes, upscaled.mimeType),
    });

    await wooRequest(settings, 'PUT', `products/categories/${category.id}`, {
      image: {
        src: uploadedUrl,
        alt: String(image.alt || image.name || `Cover ${category.name || category.id}`),
        name: String(image.name || `Cover ${category.name || category.id}`),
      },
    });

    report.applied.push({
      entityType: 'category',
      entityId: category.id,
      entityName: String(category.name || `category-${category.id}`),
      replacements: 1,
    });
  } catch (error) {
    report.errors.push({
      entityType: 'category',
      entityId: category.id,
      sourceUrl: src,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function writeReport(report) {
  const outputDir = path.join(process.cwd(), 'data');
  await fs.mkdir(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(outputDir, `woo-image-quality-retrofit-report-${timestamp}.json`);
  const latestPath = path.join(outputDir, 'woo-image-quality-retrofit-report-latest.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(latestPath, JSON.stringify(report, null, 2), 'utf8');
  return { reportPath, latestPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const settings = await readWooSettings();
  const appUrl =
    options.appUrl ||
    String(process.env.APP_PUBLIC_URL || process.env.NEXT_PUBLIC_APP_URL || '')
      .trim()
      .replace(/\/$/, '');

  if (options.apply && !appUrl) {
    throw new Error('Per --apply serve un APP_PUBLIC_URL pubblico (oppure --app-url).');
  }

  const report = {
    createdAt: new Date().toISOString(),
    mode: options.apply ? 'apply' : 'dry-run',
    scope: options.scope,
    minLongEdge: options.minLongEdge,
    appUrl: appUrl || null,
    summary: {
      scannedProducts: 0,
      scannedCategories: 0,
      issues: 0,
      appliedEntities: 0,
      errors: 0,
    },
    issues: [],
    applied: [],
    errors: [],
  };

  console.log(`[farway] Avvio scan qualità immagini (scope=${options.scope}, minLongEdge=${options.minLongEdge}, mode=${report.mode})`);

  if (options.scope === 'all' || options.scope === 'products') {
    let products = await wooFetchAll(
      settings,
      'products?status=publish&_fields=id,name,images'
    );
    if (options.limitProducts > 0) {
      products = products.slice(0, options.limitProducts);
    }

    report.summary.scannedProducts = products.length;
    for (let index = 0; index < products.length; index += 1) {
      const product = products[index];
      console.log(`[farway] Prodotti ${index + 1}/${products.length} -> #${product.id} ${product.name || ''}`);
      await processProduct(settings, appUrl, product, options, report);
    }
  }

  if (options.scope === 'all' || options.scope === 'categories') {
    let categories = await wooFetchAll(
      settings,
      'products/categories?_fields=id,name,image'
    );
    if (options.limitCategories > 0) {
      categories = categories.slice(0, options.limitCategories);
    }

    report.summary.scannedCategories = categories.length;
    for (let index = 0; index < categories.length; index += 1) {
      const category = categories[index];
      console.log(`[farway] Categorie ${index + 1}/${categories.length} -> #${category.id} ${category.name || ''}`);
      await processCategory(settings, appUrl, category, options, report);
    }
  }

  report.summary.issues = report.issues.length;
  report.summary.appliedEntities = report.applied.length;
  report.summary.errors = report.errors.length;

  const { reportPath, latestPath } = await writeReport(report);

  console.log('[farway] Completato.');
  console.log(`[farway] Issues trovati: ${report.summary.issues}`);
  console.log(`[farway] Entita aggiornate: ${report.summary.appliedEntities}`);
  console.log(`[farway] Errori: ${report.summary.errors}`);
  console.log(`[farway] Report: ${reportPath}`);
  console.log(`[farway] Latest: ${latestPath}`);
}

main().catch((error) => {
  console.error('[farway] Errore fatale:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
