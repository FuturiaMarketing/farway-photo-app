import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { NextResponse } from 'next/server';
import {
  getAcfFieldsForProduct,
  inferAcfFieldsFromMetaData,
  normalizeAcfValue,
} from '@/lib/server/acf-fields';
import {
  clearBinaryAssetsByNamespace,
  ensureInitialDatabaseCompaction,
  hasDatabaseConnection,
  readJsonValue,
  writeJsonValue,
  writeBinaryAsset,
} from '@/lib/server/db';
import { getResolvedWooCommerceSettings } from '@/lib/server/woocommerce-settings';

type GeneratedResult = {
  key: string;
  kind: 'hero' | 'front' | 'gallery' | 'extra' | 'alternate';
  pose: string;
  color: string;
  url: string;
};

type SyncRequest = {
  projectName: string;
  productId: number;
  productName: string;
  generatedResults: GeneratedResult[];
  productDescriptionHtml?: string;
  productShortDescriptionHtml?: string;
  acfValues?: Record<string, unknown>;
  selectedAdditionalScenarioLabels?: string[];
  selectedUrbanExtraScenarioLocation?: string;
  selectedExtraUrbanScenarioLocation?: string;
  primarySyncResultKey?: string;
  companionProductIds?: number[];
  syncMode?: 'replace' | 'keep-existing';
};

type WooVariation = {
  id: number;
  attributes?: Array<{
    id?: number;
    name?: string;
    option?: string;
  }>;
};

type WooProductResponse = {
  id?: number;
  type?: string;
  attributes?: Array<Record<string, unknown>>;
  default_attributes?: Array<Record<string, unknown>>;
  cross_sell_ids?: number[];
  categories?: Array<{
    id: number;
    name: string;
    slug?: string;
    parent?: number;
  }>;
  meta_data?: Array<{
    id?: number;
    key?: string;
    value?: unknown;
  }>;
  images?: Array<{
    id?: number;
    src?: string;
    name?: string;
    alt?: string;
  }>;
  tags?: Array<{
    id?: number;
    name?: string;
    slug?: string;
  }>;
};

type SyncJob = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  phase: string;
  message: string | null;
  result?: {
    syncMode: 'replace' | 'keep-existing';
    updatedVariationIds: number[];
    productImageCount: number;
    crossSellCount: number;
  };
  createdAt: number;
};

type GeminiTextResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
};

const syncJobs = new Map<string, SyncJob>();
const syncJobNamespace = 'sync-jobs';
const occasionDusoFieldName = 'occasione_duso';
const occasionDusoChoiceByLabel = new Map<string, string>([
  ['a casa dei nonni', 'casa_nonni'],
  ['passeggiata con mamma e papa', 'passeggiata_famiglia'],
  ['passeggiata con mamma e papà', 'passeggiata_famiglia'],
  ['compleanno', 'compleanno'],
  ['il vestito della domenica', 'vestito_domenica'],
  ["una sera d'estate: gelato con gli amici", 'sera_estate_gelato'],
  ['una sera d’estate: gelato con gli amici', 'sera_estate_gelato'],
  ['pranzi semplici ed eleganti', 'occasioni_eleganti'],
  ['cene o pranzi semplici ed eleganti', 'occasioni_eleganti'],
  ['cerimonia in famiglia', 'cerimonia_in-famiglia'],
  ['picnic al parco', 'picnic_al_parco'],
  ['pomeriggio al museo', 'pomeriggio_al_museo'],
  ['weekend al lago', 'weekend_al_lago'],
]);

function sanitizeSegment(value: string) {
  return (
    value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}

function sanitizeFileName(value: string) {
  return (
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}

function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!match) return null;

  return {
    mimeType: match[1],
    base64: match[2],
  };
}

function getFileExtension(mimeType: string) {
  if (mimeType.includes('jpeg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  return 'png';
}

function buildPublicImageUrl(baseUrl: string, assetId: string, filename: string) {
  return `${baseUrl}/api/public-image/${encodeURIComponent(assetId)}/${encodeURIComponent(filename)}`;
}

function resolveProvidedImageUrl(baseUrl: string, value: string) {
  const trimmed = String(value || '').trim();

  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }

  if (trimmed.startsWith('/')) {
    return `${baseUrl}${trimmed}`;
  }

  return `${baseUrl}/${trimmed.replace(/^\/+/, '')}`;
}

function normalizeColor(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeOccasionLabel(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTagName(value: string) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function markdownToWooHtml(markdown: string) {
  const normalized = String(markdown || '').replace(/\r\n/g, '\n').trim();

  if (!normalized) {
    return '';
  }

  const formatInline = (value: string) =>
    escapeHtml(value)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br />');

  return normalized
    .split(/\n{2,}/)
    .map((block) => `<p>${formatInline(block.trim())}</p>`)
    .join('');
}

function stripHtml(value: string) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeMarkdownWhitespace(markdown: string) {
  return String(markdown || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildShortDescriptionFallback(markdown: string) {
  const normalized = normalizeMarkdownWhitespace(markdown);

  if (!normalized) {
    return '';
  }

  const firstBlock =
    normalized
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .find(Boolean) || normalized;

  if (firstBlock.length <= 280) {
    return firstBlock;
  }

  const trimmed = firstBlock.slice(0, 277);
  const lastSpace = trimmed.lastIndexOf(' ');

  return `${(lastSpace > 180 ? trimmed.slice(0, lastSpace) : trimmed).trim()}...`;
}

async function generateWooShortDescriptionMarkdown(
  productName: string,
  descriptionMarkdown: string
) {
  const normalizedDescription = normalizeMarkdownWhitespace(descriptionMarkdown);

  if (!normalizedDescription) {
    return '';
  }

  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || '';

  if (!apiKey) {
    return buildShortDescriptionFallback(normalizedDescription);
  }

  try {
    const prompt = [
      'Write a WooCommerce short description in Italian, in markdown only, with no code fences.',
      productName ? `Product title: ${productName}.` : '',
      `Base long description: ${normalizedDescription}`,
      'Rewrite it into a short premium excerpt for the area above the purchase button.',
      'Address the buyer, not the child who wears the garment.',
      'Speak to a parent, relative, or family friend choosing the garment for a child.',
      'Keep the tone refined, warm, high-end, and persuasive, but concise.',
      'Length: one short paragraph, usually 2 to 4 sentences.',
      'Use at most one or two **bold** phrases.',
      'Do not use bullet lists.',
      'Do not invent technical facts not present in the long description.',
      'Never state a specific fabric composition, material certification, or fiber claim unless it is explicitly present in the long description.',
      'In particular, never write "cotone biologico" unless that exact claim is already present in the long description.',
      'Return only the final markdown excerpt.',
    ]
      .filter(Boolean)
      .join(' ');

    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            responseModalities: ['TEXT'],
          },
        }),
      }
    );

    const result = (await response.json()) as GeminiTextResponse;

    if (!response.ok) {
      console.error('Errore Gemini short description:', result);
      return buildShortDescriptionFallback(normalizedDescription);
    }

    const markdown = (
      result.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('\n')
        .trim() || ''
    )
      .replace(/^```[a-z]*\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim();

    return markdown || buildShortDescriptionFallback(normalizedDescription);
  } catch (error) {
    console.error('Errore generazione short description:', error);
    return buildShortDescriptionFallback(normalizedDescription);
  }
}

function mapScenarioLabelsToOccasionValues(labels: string[]) {
  return Array.from(
    new Set(
      labels
        .map((label) => occasionDusoChoiceByLabel.get(normalizeOccasionLabel(label)))
        .filter((value): value is string => Boolean(value))
    )
  );
}

function buildPublicBaseUrl(req: Request) {
  return (
    process.env.APP_PUBLIC_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    new URL(req.url).origin
  ).replace(/\/$/, '');
}

function isLocalOnlyUrl(value: string) {
  try {
    const url = new URL(value);
    return ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname);
  } catch {
    return true;
  }
}

function findColorFromVariation(variation: WooVariation, knownColors: string[]) {
  const normalizedKnownColors = knownColors.map((color) => ({
    original: color,
    normalized: normalizeColor(color),
  }));

  for (const attribute of variation.attributes || []) {
    const option = attribute.option || '';
    const normalizedOption = normalizeColor(option);

    const exactMatch = normalizedKnownColors.find((color) => color.normalized === normalizedOption);
    if (exactMatch) {
      return exactMatch.original;
    }

    const looksLikeColorAttribute =
      (attribute.name || '').toLowerCase().includes('color') ||
      (attribute.name || '').toLowerCase().includes('colore');

    if (looksLikeColorAttribute && option) {
      return option;
    }
  }

  return null;
}

async function createJob() {
  const id = Math.random().toString(36).slice(2, 12);
  const job: SyncJob = {
    id,
    status: 'queued',
    progress: 0,
    phase: 'In coda',
    message: null,
    createdAt: Date.now(),
  };

  syncJobs.set(id, job);
  if (hasDatabaseConnection()) {
    await writeJsonValue(syncJobNamespace, id, job);
  }
  return job;
}

async function readJob(jobId: string) {
  const inMemory = syncJobs.get(jobId);

  if (inMemory) {
    return inMemory;
  }

  if (!hasDatabaseConnection()) {
    return null;
  }

  const stored = await readJsonValue<SyncJob>(syncJobNamespace, jobId);

  if (stored) {
    syncJobs.set(jobId, stored);
  }

  return stored;
}

async function updateJob(jobId: string, patch: Partial<SyncJob>) {
  const current = syncJobs.get(jobId);
  const source = current || (await readJob(jobId));
  if (!source) return;

  const nextJob = { ...source, ...patch };
  syncJobs.set(jobId, nextJob);
  if (hasDatabaseConnection()) {
    await writeJsonValue(syncJobNamespace, jobId, nextJob);
  }
}

async function failJob(jobId: string, message: string) {
  await updateJob(jobId, {
    status: 'failed',
    progress: 100,
    phase: 'Errore',
    message,
  });
}

async function ensureWooProductTagId(
  cleanUrl: string,
  authQuery: string,
  tagName: string
) {
  const normalizedTarget = normalizeTagName(tagName);
  if (!normalizedTarget) {
    return null;
  }

  const tagsEndpoint = `${cleanUrl}/wp-json/wc/v3/products/tags?search=${encodeURIComponent(tagName)}&per_page=100&${authQuery}`;
  const tagsRes = await fetch(tagsEndpoint, { method: 'GET' });

  if (!tagsRes.ok) {
    throw new Error(`Lettura tag WooCommerce fallita: ${tagsRes.status}`);
  }

  const existingTags = (await tagsRes.json()) as Array<{
    id?: number;
    name?: string;
    slug?: string;
  }>;

  const exactMatch = existingTags.find(
    (tag) => typeof tag.id === 'number' && normalizeTagName(tag.name || '') === normalizedTarget
  );

  if (exactMatch?.id) {
    return exactMatch.id;
  }

  const createRes = await fetch(`${cleanUrl}/wp-json/wc/v3/products/tags?${authQuery}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: tagName,
    }),
  });

  if (!createRes.ok) {
    const createError = await createRes.text();
    throw new Error(`Creazione tag WooCommerce fallita: ${createRes.status} ${createError}`);
  }

  const createdTag = (await createRes.json()) as { id?: number };
  return typeof createdTag.id === 'number' ? createdTag.id : null;
}

async function runSyncJob(jobId: string, req: Request, body: SyncRequest) {
  try {
    await ensureInitialDatabaseCompaction();

    const settings = await getResolvedWooCommerceSettings();

    if (!settings) {
      throw new Error('Configurazione WooCommerce mancante. Salvala prima nelle impostazioni.');
    }

    const syncMode = body.syncMode === 'keep-existing' ? 'keep-existing' : 'replace';
    const companionProductIds = Array.from(
      new Set(
        (body.companionProductIds || [])
          .filter((value): value is number => Number.isInteger(value) && value > 0 && value !== body.productId)
      )
    );
    const selectedUrbanExtraScenarioLocation = String(
      body.selectedUrbanExtraScenarioLocation || ''
    ).trim();
    const selectedExtraUrbanScenarioLocation = String(
      body.selectedExtraUrbanScenarioLocation || ''
    ).trim();
    const descriptionHtml = String(body.productDescriptionHtml || '').trim();
    const shortDescriptionHtml =
      String(body.productShortDescriptionHtml || '').trim() ||
      markdownToWooHtml(
        await generateWooShortDescriptionMarkdown(
          body.productName,
          stripHtml(descriptionHtml)
        )
      );
    const occasioneDusoValues = mapScenarioLabelsToOccasionValues(
      body.selectedAdditionalScenarioLabels || []
    );

    if (
      !body.projectName ||
      !body.productId ||
      !body.productName ||
      !Array.isArray(body.generatedResults) ||
      body.generatedResults.length === 0
    ) {
      throw new Error('Payload di sincronizzazione non valido.');
    }

    const frontResults = body.generatedResults.filter((result) => result.kind === 'front');
    const galleryResults = body.generatedResults.filter((result) => result.kind === 'gallery');
    const extraResults = body.generatedResults.filter((result) => result.kind === 'extra');
    const selectedPrimaryResult =
      body.generatedResults.find((result) => result.key === body.primarySyncResultKey) || null;
    const actionResult =
      galleryResults.find((result) => result.pose.toLowerCase().includes('action')) ||
      body.generatedResults.find((result) => result.pose.toLowerCase().includes('action'));

    if (!actionResult) {
      throw new Error('Manca una foto "In Action" da usare come immagine predefinita.');
    }

    const publicBaseUrl = buildPublicBaseUrl(req);

    if (isLocalOnlyUrl(publicBaseUrl)) {
      throw new Error(
        "L'app sta fornendo immagini da un URL locale non raggiungibile da WooCommerce. Imposta APP_PUBLIC_URL (o NEXT_PUBLIC_APP_URL) con un URL pubblico HTTPS della tua app, oppure esponi temporaneamente il server con un tunnel pubblico."
      );
    }

    await updateJob(jobId, {
      status: 'running',
      progress: 10,
      phase: 'Esporto immagini',
      message: null,
    });

    const syncedImageUrls = new Map<string, string>();
    const shouldUseDatabaseAssetStorage = hasDatabaseConnection();

    if (shouldUseDatabaseAssetStorage) {
      await clearBinaryAssetsByNamespace('woo-sync');
    }

    let exportDir = '';
    if (!shouldUseDatabaseAssetStorage) {
      exportDir = path.join(
        process.cwd(),
        'public',
        'woo-sync',
        sanitizeSegment(body.projectName),
        sanitizeSegment(body.productName)
      );

      await mkdir(exportDir, { recursive: true });
    }

    for (const result of body.generatedResults) {
      const parsed = parseDataUrl(result.url);
      const assetLabel = `${body.productName} ${result.color} ${result.pose} di Farway Milano`;
      if (parsed) {
        const extension = getFileExtension(parsed.mimeType);
        const filename = `${sanitizeFileName(assetLabel)}.${extension}`;

        if (shouldUseDatabaseAssetStorage) {
          const assetId = await writeBinaryAsset({
            namespace: 'woo-sync',
            key: [
              sanitizeSegment(body.projectName),
              sanitizeSegment(body.productName),
              result.key,
              filename,
            ].join('__'),
            mimeType: parsed.mimeType,
            bytes: Buffer.from(parsed.base64, 'base64'),
            metadata: {
              projectName: body.projectName,
              productName: body.productName,
              resultKey: result.key,
              filename,
              label: assetLabel,
            },
          });

          syncedImageUrls.set(result.key, buildPublicImageUrl(publicBaseUrl, assetId, filename));
        } else {
          const absoluteFile = path.join(exportDir, filename);
          const publicFile = `${publicBaseUrl}/woo-sync/${sanitizeSegment(body.projectName)}/${sanitizeSegment(body.productName)}/${filename}`;

          await writeFile(absoluteFile, Buffer.from(parsed.base64, 'base64'));
          syncedImageUrls.set(result.key, publicFile);
        }
        continue;
      }

      const resolvedImageUrl = resolveProvidedImageUrl(publicBaseUrl, result.url);

      if (!resolvedImageUrl) {
        throw new Error(`Immagine non valida per ${result.pose} ${result.color}`);
      }

      syncedImageUrls.set(result.key, resolvedImageUrl);
    }

    const galleryOrder = [
      ...frontResults,
      ...extraResults,
      ...galleryResults.filter((result) => result.pose === 'Back'),
      ...galleryResults.filter((result) => result.pose === 'Side'),
      ...galleryResults.filter((result) => result.pose === 'In Action'),
    ];

    const cleanUrl = settings.storeUrl.replace(/\/$/, '');
    const authQuery = `consumer_key=${settings.consumerKey}&consumer_secret=${settings.consumerSecret}`;
    const productEndpoint = `${cleanUrl}/wp-json/wc/v3/products/${body.productId}?${authQuery}`;
    const variationsEndpoint = `${cleanUrl}/wp-json/wc/v3/products/${body.productId}/variations?per_page=100&${authQuery}`;

    await updateJob(jobId, {
      progress: 35,
      phase: 'Leggo prodotto e varianti',
    });

    const [productRes, variationsRes] = await Promise.all([
      fetch(productEndpoint, { method: 'GET' }),
      fetch(variationsEndpoint, { method: 'GET' }),
    ]);

    if (!productRes.ok) {
      throw new Error(`Errore WooCommerce prodotto: ${productRes.status}`);
    }

    if (!variationsRes.ok) {
      throw new Error(`Errore WooCommerce variazioni: ${variationsRes.status}`);
    }

    const product = (await productRes.json()) as WooProductResponse;
    const variations = (await variationsRes.json()) as WooVariation[];
    const preservedProductFields = {
      ...(product.type ? { type: product.type } : {}),
      ...(product.attributes ? { attributes: product.attributes } : {}),
      ...(product.default_attributes ? { default_attributes: product.default_attributes } : {}),
    };
    const applicableAcfFields = await getAcfFieldsForProduct({
      postType: 'product',
      categories: (product.categories || []).map((category) => ({
        id: category.id,
        name: category.name,
        slug: category.slug || '',
        parentId: category.parent || 0,
      })),
    });
    const inferredAcfFields = inferAcfFieldsFromMetaData(
      product.meta_data || [],
      applicableAcfFields
    );
    const allApplicableAcfFields = [...applicableAcfFields, ...inferredAcfFields].filter(
      (field) => field.name !== occasionDusoFieldName
    );
    const submittedAcfValues = body.acfValues || {};
    const knownColors = Array.from(new Set(frontResults.map((result) => result.color)));
    const frontByColor = new Map(
      frontResults.map((result) => [normalizeColor(result.color), syncedImageUrls.get(result.key) || ''])
    );
    const variationColors = Array.from(
      new Set(
        variations
          .map((variation) => findColorFromVariation(variation, knownColors))
          .filter((value): value is string => Boolean(value))
      )
    );
    const missingFrontColors = variationColors.filter(
      (color) => !frontByColor.has(normalizeColor(color))
    );
    const buildAssetName = (result: GeneratedResult) =>
      `${body.productName} ${result.color} ${result.pose} di Farway Milano`;

    const featuredResult = selectedPrimaryResult || actionResult;

    const desiredProductImages = [
      featuredResult,
      ...galleryOrder,
    ].map((result) => ({
      assetKey: result.key,
      src: syncedImageUrls.get(result.key) || '',
      name: buildAssetName(result),
      alt: buildAssetName(result),
    }));

    const existingProductImages =
      syncMode === 'keep-existing'
        ? (product.images || [])
            .filter((image) => typeof image.id === 'number' || image.src)
            .map((image) => (typeof image.id === 'number' ? { id: image.id } : { src: image.src }))
        : [];

    const existingImageIdByName = new Map(
      (product.images || [])
        .filter((image): image is Required<Pick<NonNullable<WooProductResponse['images']>[number], 'id' | 'name'>> => typeof image.id === 'number' && Boolean(image.name))
        .map((image) => [image.name, image.id])
    );
    const preservedExistingFrontImages =
      syncMode === 'replace'
        ? (product.images || [])
            .filter((image) =>
              Boolean(
                image.name &&
                  missingFrontColors.some(
                    (color) =>
                      image.name === `${body.productName} ${color} Front di Farway Milano`
                  )
              )
            )
            .map((image) =>
              typeof image.id === 'number' ? { id: image.id } : image.src ? { src: image.src } : null
            )
            .filter((image): image is { id: number } | { src: string } => image !== null)
        : [];
    const existingMetaByKey = new Map(
      (product.meta_data || [])
        .filter(
          (meta): meta is Required<Pick<NonNullable<WooProductResponse['meta_data']>[number], 'key'>> &
            Pick<NonNullable<WooProductResponse['meta_data']>[number], 'id'> =>
            Boolean(meta.key)
        )
        .map((meta) => [meta.key, meta.id])
    );
    const existingTagIds = (product.tags || [])
      .map((tag) => (typeof tag.id === 'number' ? tag.id : null))
      .filter((value): value is number => value !== null);
    const selectedScenarioLabelsNormalized = (body.selectedAdditionalScenarioLabels || []).map((label) =>
      normalizeOccasionLabel(label)
    );
    const hasUrbanScenario = selectedScenarioLabelsNormalized.some(
      (label) =>
        label.includes('passeggiata con mamma e papa') ||
        label.includes("una sera d'estate: gelato con gli amici") ||
        label.includes('pomeriggio al museo')
    );
    const hasExtraUrbanScenario = selectedScenarioLabelsNormalized.some(
      (label) => label.includes('weekend al lago') || label.includes('picnic al parco')
    );
    const desiredLocationTagNames = Array.from(
      new Set(
        [
          hasUrbanScenario ? selectedUrbanExtraScenarioLocation : '',
          hasExtraUrbanScenario ? selectedExtraUrbanScenarioLocation : '',
        ].filter(Boolean)
      )
    );
    const selectedLocationTagIds = (
      await Promise.all(
        desiredLocationTagNames.map((tagName) =>
          ensureWooProductTagId(cleanUrl, authQuery, tagName)
        )
      )
    ).filter((value): value is number => typeof value === 'number');
    const acfMetaPayload = allApplicableAcfFields.flatMap((field) => {
      const normalizedSubmittedValue = Object.prototype.hasOwnProperty.call(
        submittedAcfValues,
        field.name
      )
        ? normalizeAcfValue(field, submittedAcfValues[field.name])
        : null;

      const finalValue =
        field.name === occasionDusoFieldName
          ? Array.from(
              new Set([
                ...(Array.isArray(normalizedSubmittedValue) ? normalizedSubmittedValue : []),
                ...occasioneDusoValues,
              ])
            )
          : normalizedSubmittedValue;

      if (
        finalValue === null ||
        (Array.isArray(finalValue) && finalValue.length === 0) ||
        (typeof finalValue === 'string' && !finalValue.trim())
      ) {
        return [];
      }

      return [
        existingMetaByKey.has(field.name)
          ? {
              id: existingMetaByKey.get(field.name),
              key: field.name,
              value: finalValue,
            }
          : {
              key: field.name,
              value: finalValue,
            },
        existingMetaByKey.has(`_${field.name}`)
          ? {
              id: existingMetaByKey.get(`_${field.name}`),
              key: `_${field.name}`,
              value: field.key,
            }
          : {
              key: `_${field.name}`,
              value: field.key,
            },
      ];
    });

    const uniqueAssets = Array.from(
      new Map(desiredProductImages.map((asset) => [asset.assetKey, asset])).values()
    );
    const assetIdByKey = new Map<string, number>();

    for (const asset of uniqueAssets) {
      const existingId = existingImageIdByName.get(asset.name);
      if (existingId) {
        assetIdByKey.set(asset.assetKey, existingId);
      }
    }

    const assetsNeedingUpload = uniqueAssets.filter((asset) => !assetIdByKey.has(asset.assetKey));

    if (assetsNeedingUpload.length > 0) {
      await updateJob(jobId, {
        progress: 50,
        phase: 'Carico nuovi asset media',
      });

      const uploadRes = await fetch(productEndpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...preservedProductFields,
          images: assetsNeedingUpload.map((asset) => ({
            src: asset.src,
            name: asset.name,
            alt: asset.alt,
          })),
        }),
      });

      if (!uploadRes.ok) {
        const uploadError = await uploadRes.text();
        throw new Error(`Upload asset WooCommerce fallito: ${uploadRes.status} ${uploadError}`);
      }

      const uploadedProduct = (await uploadRes.json()) as WooProductResponse;

      for (const asset of assetsNeedingUpload) {
        const uploadedImage = (uploadedProduct.images || []).find(
          (image) => image.name === asset.name && typeof image.id === 'number'
        );

        if (uploadedImage?.id) {
          assetIdByKey.set(asset.assetKey, uploadedImage.id);
        }
      }
    }

    const productImagesPayload = [
      ...desiredProductImages.map((asset) =>
        assetIdByKey.has(asset.assetKey)
          ? { id: assetIdByKey.get(asset.assetKey) }
          : { src: asset.src, name: asset.name, alt: asset.alt }
      ),
      ...preservedExistingFrontImages,
      ...existingProductImages,
    ];

    await updateJob(jobId, {
      progress: 60,
      phase: 'Aggiorno galleria e testi prodotto',
    });

    const productUpdateRes = await fetch(productEndpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...preservedProductFields,
        images: productImagesPayload,
        ...(descriptionHtml ? { description: descriptionHtml } : {}),
        ...(shortDescriptionHtml ? { short_description: shortDescriptionHtml } : {}),
        cross_sell_ids: Array.from(
          new Set([...(product.cross_sell_ids || []), ...companionProductIds])
        ),
        ...(selectedLocationTagIds.length > 0
          ? {
              tags: Array.from(new Set([...existingTagIds, ...selectedLocationTagIds])).map(
                (id) => ({
                  id,
                })
              ),
            }
          : {}),
        ...(acfMetaPayload.length > 0 ? { meta_data: acfMetaPayload } : {}),
      }),
    });

    if (!productUpdateRes.ok) {
      const productError = await productUpdateRes.text();
      throw new Error(`Aggiornamento prodotto fallito: ${productUpdateRes.status} ${productError}`);
    }

    const updatedProduct = (await productUpdateRes.json()) as WooProductResponse;
    const updatedCrossSellIds = updatedProduct.cross_sell_ids || [];
    const frontAttachmentByColor = new Map<string, number>();

    for (const frontResult of frontResults) {
      const expectedName = buildAssetName(frontResult);

      const matchingImage = (updatedProduct.images || []).find(
        (image) => image.name === expectedName && typeof image.id === 'number'
      );

      if (matchingImage?.id) {
        frontAttachmentByColor.set(normalizeColor(frontResult.color), matchingImage.id);
      }
    }

    await updateJob(jobId, {
      progress: 78,
      phase: 'Aggiorno varianti colore',
    });

    const updatedVariationIds: number[] = [];

    for (let index = 0; index < variations.length; index += 1) {
      const variation = variations[index];
      const variationColor = findColorFromVariation(variation, knownColors);
      if (!variationColor) continue;

      const frontImageUrl = frontByColor.get(normalizeColor(variationColor));
      if (!frontImageUrl) continue;

      const variationEndpoint = `${cleanUrl}/wp-json/wc/v3/products/${body.productId}/variations/${variation.id}?${authQuery}`;
      const galleryAttachmentId = frontAttachmentByColor.get(normalizeColor(variationColor));
      const variationRes = await fetch(variationEndpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: galleryAttachmentId
            ? {
                id: galleryAttachmentId,
              }
            : {
                src: frontImageUrl,
                name: `${body.productName} ${variationColor} front`,
                alt: `${body.productName} ${variationColor} front`,
              },
        }),
      });

      if (!variationRes.ok) {
        const variationError = await variationRes.text();
        throw new Error(`Aggiornamento variante ${variation.id} fallito: ${variationRes.status} ${variationError}`);
      }

      updatedVariationIds.push(variation.id);

      const variationProgress = Math.min(
        95,
        78 + Math.round(((index + 1) / Math.max(variations.length, 1)) * 17)
      );
      await updateJob(jobId, {
        progress: variationProgress,
        phase: `Aggiorno varianti colore (${index + 1}/${variations.length})`,
      });
    }

    const crossSellMessage =
      companionProductIds.length > 0
        ? ` Articoli collegati aggiornati con ${updatedCrossSellIds.length} cross-sell totali.`
        : '';
    const locationTagMessage =
      desiredLocationTagNames.length > 0
        ? ` Tag location aggiornati: ${desiredLocationTagNames.join(', ')}.`
        : '';
    const occasionMessage = ` Campo ACF occasioni d'uso aggiornato con ${occasioneDusoValues.length} valori.`;

    const message = `${
      syncMode === 'keep-existing'
        ? 'Sincronizzazione completata mantenendo anche le immagini gia presenti in galleria.'
        : 'Sincronizzazione completata sostituendo la galleria con il nuovo set.'
    } Galleria prodotto aggiornata con ${productImagesPayload.length} immagini e ${updatedVariationIds.length} varianti collegate.${crossSellMessage}${locationTagMessage}${occasionMessage}`;

    await updateJob(jobId, {
      status: 'completed',
      progress: 100,
      phase: 'Completata',
      message,
      result: {
        syncMode,
        updatedVariationIds,
        productImageCount: productImagesPayload.length,
        crossSellCount: updatedCrossSellIds.length,
      },
    });
  } catch (error: unknown) {
    await failJob(jobId, error instanceof Error ? error.message : 'Errore sconosciuto');
  }
}

export async function POST(req: Request) {
  const body = (await req.json()) as SyncRequest;
  const job = await createJob();

  await runSyncJob(job.id, req, body);
  const finalJob = (await readJob(job.id)) || job;

  return NextResponse.json({
    jobId: finalJob.id,
    status: finalJob.status,
    progress: finalJob.progress,
    phase: finalJob.phase,
    message: finalJob.message,
    result: finalJob.result,
  });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get('jobId');

  if (!jobId) {
    return NextResponse.json({ error: 'jobId mancante.' }, { status: 400 });
  }

  const job = await readJob(jobId);

  if (!job) {
    return NextResponse.json({ error: 'Job non trovato.' }, { status: 404 });
  }

  return NextResponse.json(job);
}
