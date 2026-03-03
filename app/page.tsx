"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, Camera, Check, CheckCircle2, ChevronDown, CircleDashed, Download, ExternalLink, Loader2, RefreshCw, Settings, Upload, Wand2, X, XCircle } from 'lucide-react';

const genders = ['Maschio', 'Femmina'];
const ethnicities = ['Caucasico', 'Italiano', 'Mediterraneo', 'Scandinavo', 'Medio Orientale', 'Latino-Americano', 'Asiatico', 'Sud-Asiatico', 'Afroamericano', 'Misto'];
const garmentFitOptions = ['Morbida leggermente oversize', 'Oversize', 'A carota'] as const;
const garmentLengthOptions = ['Sopra al ginocchio', 'Sotto al ginocchio', 'A tre quarti', 'Lungo che copre le caviglie'] as const;
const sourceViewOptions = ['front', 'back', 'side'] as const;
const galleryPoses = [
  { key: 'back', label: 'Back', prompt: 'back view, full body, studio catalog photo' },
  { key: 'side', label: 'Side', prompt: 'side view, full body, studio catalog photo' },
  { key: 'action', label: 'In Action', prompt: 'natural action pose, realistic movement, commercial fashion photo' },
] as const;
const sourceViewLabels: Record<SourceView, string> = {
  front: 'Front',
  back: 'Back',
  side: 'Side',
};

type AmbientazioneSetting = { id: string; label: string; hasReferenceImage: boolean };
type AmbientazioneCollection = { studio: AmbientazioneSetting[]; realLife: AmbientazioneSetting[] };
type ProductCategory = {
  id: number;
  name: string;
  parentId: number;
  parentName: string | null;
  topLevelParentId: number;
  topLevelParentName: string;
  level: number;
  lineageIds: number[];
};
type AcfField = {
  key: string;
  name: string;
  label: string;
  type: 'checkbox' | 'radio' | 'text' | 'wysiwyg';
  instructions: string;
  choices: Array<{ value: string; label: string }>;
  allowCustom: boolean;
  allowNull: boolean;
  placeholder: string;
  append: string;
  groupKey: string;
  groupTitle: string;
};
type AcfFieldValues = Record<string, string | string[]>;
type SourceView = (typeof sourceViewOptions)[number];
type SourceReferenceMode = 'garment-only' | 'worn';
type Product = { id: number; name: string; images: string[]; image: string; colors: string[]; sizes: string[]; description?: string; sku?: string; frontendUrl?: string; backendUrl?: string; categories: ProductCategory[]; acfFields: AcfField[]; acfValues: AcfFieldValues };
type Job = { id: string; modelAge: string; gender: string; ethnicity: string; scenario: string; fit: string; length: string; status: 'pending' };
type SelectedSourceImage = { url: string; view: SourceView; color: string; mode: SourceReferenceMode };
type GeneratedResult = { key: string; kind: 'hero' | 'front' | 'gallery' | 'extra' | 'alternate'; pose: string; color: string; url: string };
type ActiveTab = 'products' | 'setup' | 'gallery';
type Stage = 'idle' | 'hero' | 'production';
type WooSyncMode = 'replace' | 'keep-existing';
type ProductProgressFilter = 'all' | 'todo' | 'in-progress' | 'completed';
type ManualProductStatus = ProductProgressFilter | 'auto';
type CompanionRole = string;
type ProductSession = {
  selectedSourceImages: SelectedSourceImage[];
  manualSourceImages: string[];
  job: Job | null;
  selectedColor: string;
  companionProductId: number | null;
  companionRole: CompanionRole;
  companionImageUrl: string;
  companionFit: string;
  companionLength: string;
  secondaryCompanionProductId: number | null;
  secondaryCompanionRole: CompanionRole;
  secondaryCompanionImageUrl: string;
  secondaryCompanionFit: string;
  secondaryCompanionLength: string;
  selectedAdditionalScenarios: string[];
  generatedDescriptionHtml: string;
  generatedShortDescriptionHtml: string;
  acfValues: AcfFieldValues;
  activeTab: ActiveTab;
  isPreviewApproved: boolean;
};

const sessionDbName = 'futuria-session-db';
const sessionStoreName = 'generated-results';
const settingsDbName = 'futuria-settings-db';
const ambientazioniStoreName = 'ambientazioni-references';
const defaultStudioSettings: AmbientazioneSetting[] = [
  { id: 'default-studio-bianco', label: 'Studio sfondo bianco', hasReferenceImage: false },
  { id: 'default-studio-caldo', label: 'Studio sfondo neutro caldo', hasReferenceImage: false },
  { id: 'default-cameretta', label: 'Cameretta luminosa', hasReferenceImage: false },
  { id: 'default-parco', label: 'Parco soleggiato', hasReferenceImage: false },
  { id: 'default-spiaggia', label: 'Spiaggia sabbia chiara', hasReferenceImage: false },
];
const defaultRealLifeSettings: AmbientazioneSetting[] = [
  { id: 'default-nonni', label: 'A casa dei nonni', hasReferenceImage: false },
  { id: 'default-passeggiata', label: 'Passeggiata con mamma e papa', hasReferenceImage: false },
  { id: 'default-compleanno', label: 'Compleanno', hasReferenceImage: false },
  { id: 'default-domenica', label: 'Il vestito della domenica', hasReferenceImage: false },
  { id: 'default-gelato', label: "Una sera d'estate: gelato con gli amici", hasReferenceImage: false },
  { id: 'default-pranzi', label: 'Pranzi semplici ed eleganti', hasReferenceImage: false },
];
const defaultAmbientazioniCollection: AmbientazioneCollection = {
  studio: defaultStudioSettings,
  realLife: defaultRealLifeSettings,
};
function buildProductSessionKey(projectId: string, productId: number) {
  return `futuria-product-session-${projectId}-${productId}`;
}

function buildProjectSelectionKey(projectId: string) {
  return `futuria-current-product-${projectId}`;
}

function normalizeAmbientazioniMap(raw: string | null) {
  if (!raw) {
    return { default: defaultAmbientazioniCollection } as Record<string, AmbientazioneCollection>;
  }

  const normalizeList = (projectKey: string, settings: AmbientazioneSetting[] | string[] | undefined, fallback: AmbientazioneSetting[]) =>
    Array.isArray(settings)
      ? settings.map((setting, index) =>
          typeof setting === 'string'
            ? {
                id: `${projectKey}-${index}-${setting.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
                label: setting,
                hasReferenceImage: false,
              }
            : {
                id: setting.id,
                label: setting.label,
                hasReferenceImage: Boolean(setting.hasReferenceImage),
              }
        )
      : [...fallback];

  const parsed = JSON.parse(raw) as Record<
    string,
    AmbientazioneCollection | AmbientazioneSetting[] | string[]
  >;

  return Object.fromEntries(
    Object.entries(parsed).map(([projectKey, settings]) => {
      if (Array.isArray(settings)) {
        return [
          projectKey,
          {
            studio: normalizeList(projectKey, settings, defaultStudioSettings),
            realLife: [...defaultRealLifeSettings],
          },
        ];
      }

      return [
        projectKey,
        {
          studio: normalizeList(projectKey, settings?.studio, defaultStudioSettings),
          realLife: normalizeList(projectKey, settings?.realLife, defaultRealLifeSettings),
        },
      ];
    })
  );
}

function openSessionDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(sessionDbName, 1);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(sessionStoreName)) {
        db.createObjectStore(sessionStoreName, { keyPath: 'sessionKey' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openSettingsDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(settingsDbName, 1);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(ambientazioniStoreName)) {
        db.createObjectStore(ambientazioniStoreName, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readAmbientazioneReference(projectId: string, settingId: string) {
  const db = await openSettingsDb();
  const key = `${projectId}:${settingId}`;

  return new Promise<string | null>((resolve, reject) => {
    const transaction = db.transaction(ambientazioniStoreName, 'readonly');
    const store = transaction.objectStore(ambientazioniStoreName);
    const request = store.get(key);

    request.onsuccess = () => {
      const record = request.result as { key: string; dataUrl: string } | undefined;
      resolve(record?.dataUrl || null);
    };
    request.onerror = () => reject(request.error);
  });
}

async function readGeneratedResultsFromDb(sessionKey: string) {
  const db = await openSessionDb();

  return new Promise<GeneratedResult[]>((resolve, reject) => {
    const transaction = db.transaction(sessionStoreName, 'readonly');
    const store = transaction.objectStore(sessionStoreName);
    const request = store.get(sessionKey);

    request.onsuccess = () => {
      const record = request.result as { sessionKey: string; results: GeneratedResult[] } | undefined;
      resolve(record?.results || []);
    };
    request.onerror = () => reject(request.error);
  });
}

async function writeGeneratedResultsToDb(sessionKey: string, results: GeneratedResult[]) {
  const db = await openSessionDb();

  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(sessionStoreName, 'readwrite');
    const store = transaction.objectStore(sessionStoreName);
    const request = store.put({ sessionKey, results });

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function listGeneratedProductIdsFromDb(projectId: string) {
  const db = await openSessionDb();
  const sessionPrefix = `futuria-product-session-${projectId}-`;

  return new Promise<number[]>((resolve, reject) => {
    const transaction = db.transaction(sessionStoreName, 'readonly');
    const store = transaction.objectStore(sessionStoreName);
    const request = store.getAll();

    request.onsuccess = () => {
      const records = (request.result || []) as Array<{ sessionKey: string; results: GeneratedResult[] }>;
      const productIds = records
        .filter(
          (record) =>
            typeof record.sessionKey === 'string' &&
            record.sessionKey.startsWith(sessionPrefix) &&
            Array.isArray(record.results) &&
            record.results.length > 0
        )
        .map((record) => Number(record.sessionKey.slice(sessionPrefix.length)))
        .filter((value) => Number.isInteger(value) && value > 0);

      resolve(Array.from(new Set(productIds)));
    };
    request.onerror = () => reject(request.error);
  });
}

function getDataUrlByteSize(dataUrl: string) {
  const base64 = dataUrl.split(',')[1] || '';
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function loadBrowserImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Impossibile ottimizzare l'immagine generata."));
    image.src = src;
  });
}

async function optimizeGeneratedImage(dataUrl: string, maxBytes = 2_400_000) {
  if (!dataUrl.startsWith('data:image/')) {
    return dataUrl;
  }

  const sourceImage = await loadBrowserImage(dataUrl);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  if (!context) {
    return dataUrl;
  }

  let width = sourceImage.naturalWidth;
  let height = sourceImage.naturalHeight;
  const maxDimension = 2400;

  if (Math.max(width, height) > maxDimension) {
    const ratio = maxDimension / Math.max(width, height);
    width = Math.max(1, Math.round(width * ratio));
    height = Math.max(1, Math.round(height * ratio));
  }

  let bestCandidate = dataUrl;
  const preferredMimeType = 'image/webp';

  for (let scaleAttempt = 0; scaleAttempt < 6; scaleAttempt += 1) {
    canvas.width = width;
    canvas.height = height;
    context.clearRect(0, 0, width, height);
    context.drawImage(sourceImage, 0, 0, width, height);

    for (const quality of [0.96, 0.92, 0.88, 0.84, 0.8, 0.74]) {
      const candidate = canvas.toDataURL(preferredMimeType, quality);
      bestCandidate = candidate;

      if (getDataUrlByteSize(candidate) <= maxBytes) {
        return candidate;
      }
    }

    width = Math.max(1, Math.round(width * 0.88));
    height = Math.max(1, Math.round(height * 0.88));
  }

  return bestCandidate;
}

function LoadingCard({ label }: { label: string }) {
  return (
    <div className="rounded-2xl border border-[#D7D9DD] p-4">
      <div className="relative mb-3 aspect-[3/4] overflow-hidden rounded-xl bg-slate-100">
        <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-slate-100 to-slate-200" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="rounded-full bg-white/90 p-3 text-[#103D66] shadow">
            <Loader2 size={18} className="animate-spin" />
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-slate-500">{label}</span>
        <span className="text-[10px] font-black uppercase text-slate-400">Loading</span>
      </div>
    </div>
  );
}

function getCategoryName(category: ProductCategory | string) {
  return typeof category === 'string' ? category : category.name;
}

function normalizeReferenceColor(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getProductCategoryStrings(product: Product | null) {
  if (!product) return [];

  return [
    ...product.categories.map((category) => category.name),
    ...product.categories.map((category) => category.parentName || ''),
    ...product.categories.map((category) => category.topLevelParentName),
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
}

function isShortsLikeProduct(product: Product | null) {
  const values = getProductCategoryStrings(product);
  return values.some(
    (value) =>
      value.includes('pantalonc') ||
      value.includes('short') ||
      value.includes('bermuda')
  );
}

function isPantsLikeProduct(product: Product | null) {
  const values = getProductCategoryStrings(product);
  return values.some(
    (value) =>
      value.includes('pantalon') ||
      value.includes('jeans') ||
      value.includes('legging') ||
      value.includes('jogger')
  );
}

function supportsLengthSelection(product: Product | null) {
  return isPantsLikeProduct(product) || isShortsLikeProduct(product);
}

function getDefaultLengthForProduct(product: Product | null) {
  if (isShortsLikeProduct(product)) {
    return 'Sopra al ginocchio';
  }

  if (isPantsLikeProduct(product)) {
    return 'Lungo che copre le caviglie';
  }

  return '';
}

function normalizeAcfValueForField(field: AcfField, rawValue: unknown) {
  if (field.type === 'checkbox') {
    const values = Array.isArray(rawValue)
      ? rawValue
      : typeof rawValue === 'string'
        ? [rawValue]
        : [];
    const normalized = Array.from(
      new Set(
        values
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      )
    );

    return normalized.length > 0 ? normalized : [];
  }

  return String(rawValue || '').trim();
}

function buildInitialAcfValues(product: Product) {
  return Object.fromEntries(
    (product.acfFields || []).map((field) => [
      field.name,
      normalizeAcfValueForField(field, product.acfValues?.[field.name]),
    ])
  ) as AcfFieldValues;
}

export default function Home() {
  const [products, setProducts] = useState<Product[]>([]);
  const [progressFilter, setProgressFilter] = useState<ProductProgressFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [productSearch, setProductSearch] = useState('');
  const [startedProductIds, setStartedProductIds] = useState<number[]>([]);
  const [syncedProductIds, setSyncedProductIds] = useState<number[]>([]);
  const [generatedProductIds, setGeneratedProductIds] = useState<number[]>([]);
  const [manualProductStatuses, setManualProductStatuses] = useState<Record<number, ManualProductStatus>>({});
  const [openStatusMenuProductId, setOpenStatusMenuProductId] = useState<number | null>(null);
  const [isLoadingProducts, setIsLoadingProducts] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [selectedSourceImages, setSelectedSourceImages] = useState<SelectedSourceImage[]>([]);
  const [manualSourceImages, setManualSourceImages] = useState<string[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [projectId, setProjectId] = useState('default');
  const [projectName, setProjectName] = useState('Futuria');
  const [shootingSettings, setShootingSettings] = useState<AmbientazioneCollection>(defaultAmbientazioniCollection);
  const [shootingReferenceImages, setShootingReferenceImages] = useState<Record<string, string>>({});
  const [selectedColor, setSelectedColor] = useState('');
  const [companionProductId, setCompanionProductId] = useState<number | null>(null);
  const [companionRole, setCompanionRole] = useState<CompanionRole>('');
  const [companionImageUrl, setCompanionImageUrl] = useState('');
  const [companionFit, setCompanionFit] = useState('');
  const [companionLength, setCompanionLength] = useState('');
  const [secondaryCompanionProductId, setSecondaryCompanionProductId] = useState<number | null>(null);
  const [secondaryCompanionRole, setSecondaryCompanionRole] = useState<CompanionRole>('');
  const [secondaryCompanionImageUrl, setSecondaryCompanionImageUrl] = useState('');
  const [secondaryCompanionFit, setSecondaryCompanionFit] = useState('');
  const [secondaryCompanionLength, setSecondaryCompanionLength] = useState('');
  const [companionProductSearch, setCompanionProductSearch] = useState('');
  const [isCompanionPickerOpen, setIsCompanionPickerOpen] = useState(false);
  const [companionPickerTarget, setCompanionPickerTarget] = useState<1 | 2>(1);
  const [selectedAdditionalScenarios, setSelectedAdditionalScenarios] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<ActiveTab>('products');
  const [generatedResults, setGeneratedResults] = useState<GeneratedResult[]>([]);
  const [generatedDescriptionHtml, setGeneratedDescriptionHtml] = useState('');
  const [generatedShortDescriptionHtml, setGeneratedShortDescriptionHtml] = useState('');
  const [acfValues, setAcfValues] = useState<AcfFieldValues>({});
  const [genError, setGenError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [isPreviewApproved, setIsPreviewApproved] = useState(false);
  const [stage, setStage] = useState<Stage>('idle');
  const [isGeneratingDescription, setIsGeneratingDescription] = useState(false);
  const [hasLoadedSession, setHasLoadedSession] = useState(false);
  const [isSyncingWoo, setIsSyncingWoo] = useState(false);
  const [wooSyncMode, setWooSyncMode] = useState<WooSyncMode>('replace');
  const [wooSyncProgress, setWooSyncProgress] = useState(0);
  const [wooSyncPhase, setWooSyncPhase] = useState<string | null>(null);
  const [wooSyncMessage, setWooSyncMessage] = useState<string | null>(null);
  const [showWooSyncCompleteModal, setShowWooSyncCompleteModal] = useState(false);
  const [lightboxResult, setLightboxResult] = useState<GeneratedResult | null>(null);
  const [openRegenerationKey, setOpenRegenerationKey] = useState<string | null>(null);
  const [regenerationDrafts, setRegenerationDrafts] = useState<Record<string, string>>({});
  const [regeneratingKey, setRegeneratingKey] = useState<string | null>(null);
  const [pendingRegenerationComparison, setPendingRegenerationComparison] = useState<{
    key: string;
    previous: GeneratedResult;
    next: GeneratedResult;
  } | null>(null);
  const companionSearchInputRef = useRef<HTMLInputElement | null>(null);
  const manualSourceInputRef = useRef<HTMLInputElement | null>(null);

  const previewResult = generatedResults.find((r) => r.kind === 'hero') || null;
  const frontResults = generatedResults.filter((r) => r.kind === 'front');
  const galleryResults = generatedResults.filter((r) => r.kind === 'gallery');
  const extraScenarioResults = generatedResults.filter((r) => r.kind === 'extra');
  const alternateGenderResults = generatedResults.filter((r) => r.kind === 'alternate');
  const isBusy = stage !== 'idle';
  const availableCategories = Array.from(
    new Map(
      products
        .flatMap((product) => product.categories || [])
        .map((category) => [category.id, category])
    ).values()
  ).sort((a, b) => a.name.localeCompare(b.name, 'it'));
  const topLevelCategorySummaries = Array.from(
    new Map(
      availableCategories.map((category) => [
        category.topLevelParentId,
        {
          id: category.topLevelParentId,
          name: category.topLevelParentName,
        },
      ])
    ).values()
  );
  const preferredGroupOrder = ['abbigliamento', 'accessori', 'genere'];
  const orderedCategoryGroups = topLevelCategorySummaries
    .sort((a, b) => {
      const aIndex = preferredGroupOrder.indexOf(a.name.toLowerCase());
      const bIndex = preferredGroupOrder.indexOf(b.name.toLowerCase());
      const safeA = aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex;
      const safeB = bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex;

      if (safeA !== safeB) {
        return safeA - safeB;
      }

      return a.name.localeCompare(b.name, 'it');
    })
    .map((parentCategory) => ({
      parent: parentCategory,
      children: availableCategories
        .filter(
          (category) =>
            category.level === 1 && category.topLevelParentId === parentCategory.id
        )
        .sort((a, b) => a.name.localeCompare(b.name, 'it')),
    }));
  const normalizedSearch = productSearch.trim().toLowerCase();
  const visibleProducts = products.filter((product) => {
    const derivedStatus = getProductStatus(product.id);
    const matchesProgress =
      progressFilter === 'all' ||
      derivedStatus === progressFilter;

    const matchesCategory =
      categoryFilter === 'all' ||
      product.categories.some((category) =>
        category.lineageIds.includes(Number(categoryFilter))
      );

    const matchesSearch =
      normalizedSearch.length === 0 ||
      product.name.toLowerCase().includes(normalizedSearch) ||
      String(product.sku || product.id).toLowerCase().includes(normalizedSearch);

    return matchesProgress && matchesCategory && matchesSearch;
  });
  const studioSettings = shootingSettings.studio;
  const realLifeSettings = shootingSettings.realLife;
  const selectedScenarioSetting =
    studioSettings.find((setting) => setting.id === job?.scenario) ||
    studioSettings.find((setting) => setting.label === job?.scenario) ||
    null;
  const selectedScenarioLabel = selectedScenarioSetting?.label || job?.scenario || defaultStudioSettings[0].label;
  const selectedScenarioReferenceUrl =
    selectedScenarioSetting ? shootingReferenceImages[selectedScenarioSetting.id] : undefined;
  const selectedAdditionalScenarioSettings = realLifeSettings.filter(
    (setting) => selectedAdditionalScenarios.includes(setting.id) || selectedAdditionalScenarios.includes(setting.label)
  );
  const isUnisexProduct = Boolean(
    selectedProduct?.categories.some((category) =>
      [category.name, category.parentName, category.topLevelParentName]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes('unisex'))
    )
  );
  const alternateGender = job?.gender === 'Maschio' ? 'Femmina' : job?.gender === 'Femmina' ? 'Maschio' : '';
  const companionProduct =
    companionProductId && selectedProduct?.id !== companionProductId
      ? products.find((product) => product.id === companionProductId) || null
      : null;
  const secondaryCompanionProduct =
    secondaryCompanionProductId &&
    selectedProduct?.id !== secondaryCompanionProductId &&
    secondaryCompanionProductId !== companionProductId
      ? products.find((product) => product.id === secondaryCompanionProductId) || null
      : null;
  const companionRoleOptions = Array.from(
    new Set(
      [
        ...availableCategories
          .filter(
            (category) =>
              (
                category.topLevelParentName.toLowerCase() === 'abbigliamento' ||
                (
                  category.topLevelParentName.toLowerCase() === 'accessori' &&
                  category.level >= 1
                )
              ) &&
              category.name.trim() &&
              category.name.toLowerCase() !== category.topLevelParentName.toLowerCase()
          )
          .map((category) => category.name.trim()),
        'Borse',
      ]
    )
  ).sort((a, b) => a.localeCompare(b, 'it'));
  const getDefaultCompanionRoleForProduct = useCallback(
    (product: Product | null) => {
      if (!product) {
        return companionRoleOptions[0] || '';
      }

      const matchingCategory = [...(product.categories || [])]
        .filter(
          (category) =>
            (
              category.topLevelParentName.toLowerCase() === 'abbigliamento' ||
              (
                category.topLevelParentName.toLowerCase() === 'accessori' &&
                category.level >= 1
              )
            ) &&
            category.name.toLowerCase() !== category.topLevelParentName.toLowerCase() &&
            companionRoleOptions.includes(category.name)
        )
        .sort((a, b) => b.level - a.level)[0];

      return matchingCategory?.name || companionRoleOptions[0] || '';
    },
    [companionRoleOptions]
  );
  const selectedCompanionEntries = [
    companionProduct
      ? {
          slot: 1 as const,
          product: companionProduct,
          productId: companionProductId as number,
          role: companionRole,
          fit: companionFit,
          length: companionLength,
          imageUrl: companionImageUrl || companionProduct.image,
        }
      : null,
    secondaryCompanionProduct
      ? {
          slot: 2 as const,
          product: secondaryCompanionProduct,
          productId: secondaryCompanionProductId as number,
          role: secondaryCompanionRole,
          fit: secondaryCompanionFit,
          length: secondaryCompanionLength,
          imageUrl: secondaryCompanionImageUrl || secondaryCompanionProduct.image,
        }
      : null,
  ].filter(
    (
      entry
    ): entry is {
      slot: 1 | 2;
      product: Product;
      productId: number;
      role: CompanionRole;
      fit: string;
      length: string;
      imageUrl: string;
    } => Boolean(entry)
  );
  const canAddAnotherCompanion = selectedCompanionEntries.length < 2;
  const normalizedCompanionSearch = companionProductSearch.trim().toLowerCase();
  const companionProductOptions = selectedProduct
    ? products
        .filter(
          (product) =>
            product.id !== selectedProduct.id &&
            product.id !== companionProductId &&
            product.id !== secondaryCompanionProductId &&
            normalizedCompanionSearch.length > 0 &&
            (product.name.toLowerCase().includes(normalizedCompanionSearch) ||
              String(product.sku || product.id).toLowerCase().includes(normalizedCompanionSearch))
        )
        .slice(0, 8)
    : [];
  const sizeRequiresSelection = (selectedProduct?.sizes.length || 0) > 1;
  const colorRequiresSelection = (selectedProduct?.colors.length || 0) > 1;
  const sourceColorsComplete =
    !colorRequiresSelection || selectedSourceImages.every((image) => Boolean(image.color));
  const areCompanionRolesComplete =
    (!companionProduct || Boolean(companionRole)) &&
    (!secondaryCompanionProduct || Boolean(secondaryCompanionRole));
  const isSetupComplete =
    Boolean(job) &&
    (!sizeRequiresSelection || Boolean(job?.modelAge)) &&
    Boolean(job?.gender) &&
    Boolean(job?.ethnicity) &&
    (!colorRequiresSelection || Boolean(selectedColor)) &&
    areCompanionRolesComplete &&
    selectedSourceImages.length > 0 &&
    sourceColorsComplete;
  const nextUnsyncedProduct = selectedProduct
    ? [...products.slice(products.findIndex((product) => product.id === selectedProduct.id) + 1), ...products.slice(0, Math.max(products.findIndex((product) => product.id === selectedProduct.id), 0))]
        .find((product) => product.id !== selectedProduct.id && getProductStatus(product.id) !== 'completed') || null
    : null;

  function getProductStatus(productId: number): ProductProgressFilter {
    const manualStatus = manualProductStatuses[productId] || 'auto';

    if (manualStatus !== 'auto') {
      return manualStatus;
    }

    if (syncedProductIds.includes(productId)) {
      return 'completed';
    }

    if (generatedProductIds.includes(productId)) {
      return 'in-progress';
    }

    return 'todo';
  }

  const setProductManualStatus = (productId: number, nextStatus: ManualProductStatus) => {
    setManualProductStatuses((prev) => {
      const next = { ...prev };

      if (nextStatus === 'auto') {
        delete next[productId];
      } else {
        next[productId] = nextStatus;
      }

      return next;
    });
  };

  const loadProducts = async (forceFresh = false) => {
    try {
      setIsLoadingProducts(true);
      setError(null);
      const endpoint = forceFresh ? `/api/products?fresh=1&ts=${Date.now()}` : '/api/products';
      const res = await fetch(endpoint, {
        cache: forceFresh ? 'no-store' : 'default',
      });
      const data = (await res.json()) as Product[] | { error?: string };
      if (!res.ok) throw new Error('error' in data ? data.error || 'Errore caricamento' : 'Errore caricamento');
      setProducts(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Errore sconosciuto');
    } finally {
      setIsLoadingProducts(false);
    }
  };

  useEffect(() => {
    loadProducts();
  }, []);

  const loadProductState = useCallback(async (product: Product) => {
    const defaultColor = product.colors.length === 1 ? product.colors[0] || '' : '';
    const defaultState: ProductSession = {
      selectedSourceImages: product.image ? [{ url: product.image, view: 'front', color: defaultColor, mode: 'garment-only' }] : [],
      manualSourceImages: [],
      job: {
        id: Math.random().toString(36).slice(2, 11),
        modelAge: product.sizes.length === 1 ? product.sizes[0] || '' : '',
        gender: genders.length === 1 ? genders[0] : '',
        ethnicity: ethnicities.length === 1 ? ethnicities[0] : '',
        scenario: studioSettings[0]?.id || defaultStudioSettings[0].id,
        fit: '',
        length: getDefaultLengthForProduct(product),
        status: 'pending',
      },
      selectedColor: defaultColor,
      companionProductId: null,
      companionRole: '',
      companionImageUrl: '',
      companionFit: '',
      companionLength: '',
      secondaryCompanionProductId: null,
      secondaryCompanionRole: '',
      secondaryCompanionImageUrl: '',
      secondaryCompanionFit: '',
      secondaryCompanionLength: '',
      selectedAdditionalScenarios: [],
      generatedDescriptionHtml: '',
      generatedShortDescriptionHtml: '',
      acfValues: buildInitialAcfValues(product),
      activeTab: 'setup',
      isPreviewApproved: false,
    };

    setHasLoadedSession(false);
    setSelectedProduct(product);
    setGenError(null);
    setStage('idle');
    setShowWooSyncCompleteModal(false);

    const sessionKey = buildProductSessionKey(projectId, product.id);
    const selectionKey = buildProjectSelectionKey(projectId);
    const rawSession = window.localStorage.getItem(sessionKey);

    let nextState = defaultState;

    if (rawSession) {
      try {
        const parsed = JSON.parse(rawSession) as ProductSession;
        nextState = {
          ...defaultState,
          ...parsed,
          job: parsed.job || defaultState.job,
          selectedSourceImages:
            Array.isArray(parsed.selectedSourceImages) && parsed.selectedSourceImages.length > 0
              ? parsed.selectedSourceImages.map((image) => ({
                  ...image,
                  mode: image.mode === 'worn' ? 'worn' : 'garment-only',
                }))
              : defaultState.selectedSourceImages,
        };
      } catch {
        nextState = defaultState;
      }
    }

    let storedResults: GeneratedResult[] = [];

    try {
      storedResults = await readGeneratedResultsFromDb(sessionKey);
    } catch {
      storedResults = [];
    }

    setSelectedSourceImages(nextState.selectedSourceImages);
    setManualSourceImages(
      Array.isArray(nextState.manualSourceImages)
        ? nextState.manualSourceImages.filter((image): image is string => typeof image === 'string' && image.length > 0)
        : []
    );
    setJob(nextState.job);
    setSelectedColor(nextState.selectedColor);
    setCompanionProductId(
      nextState.companionProductId && nextState.companionProductId !== product.id
        ? nextState.companionProductId
        : null
    );
    setCompanionRole(nextState.companionRole || '');
    setCompanionImageUrl(nextState.companionImageUrl || '');
    setCompanionFit(nextState.companionFit || '');
    setCompanionLength(nextState.companionLength || '');
    setSecondaryCompanionProductId(
      nextState.secondaryCompanionProductId &&
      nextState.secondaryCompanionProductId !== product.id &&
      nextState.secondaryCompanionProductId !== nextState.companionProductId
        ? nextState.secondaryCompanionProductId
        : null
    );
    setSecondaryCompanionRole(nextState.secondaryCompanionRole || '');
    setSecondaryCompanionImageUrl(nextState.secondaryCompanionImageUrl || '');
    setSecondaryCompanionFit(nextState.secondaryCompanionFit || '');
    setSecondaryCompanionLength(nextState.secondaryCompanionLength || '');
    setCompanionProductSearch('');
    setIsCompanionPickerOpen(false);
    setCompanionPickerTarget(1);
    setSelectedAdditionalScenarios(nextState.selectedAdditionalScenarios || []);
    setGeneratedDescriptionHtml(nextState.generatedDescriptionHtml || '');
    setGeneratedShortDescriptionHtml(nextState.generatedShortDescriptionHtml || '');
    setAcfValues(
      Object.fromEntries(
        product.acfFields.map((field) => [
          field.name,
          normalizeAcfValueForField(
            field,
            Object.prototype.hasOwnProperty.call(nextState.acfValues || {}, field.name)
              ? nextState.acfValues?.[field.name]
              : defaultState.acfValues[field.name]
          ),
        ])
      )
    );
    setDescriptionError(null);
    setActiveTab(
      storedResults.length > 0
        ? nextState.activeTab === 'setup'
          ? 'setup'
          : 'gallery'
        : 'setup'
    );
    setGeneratedResults(storedResults);
    setIsPreviewApproved(Boolean(nextState.isPreviewApproved));
    window.localStorage.setItem(selectionKey, String(product.id));
    setHasLoadedSession(true);
  }, [projectId, studioSettings]);

  useEffect(() => {
    if (!selectedProduct || products.length === 0) return;

    const freshProduct = products.find((product) => product.id === selectedProduct.id);

    if (freshProduct) {
      setSelectedProduct(freshProduct);
    }
  }, [products, selectedProduct]);

  useEffect(() => {
    if (!selectedProduct) return;

    setAcfValues((prev) => {
      const nextDefaults = buildInitialAcfValues(selectedProduct);

      return Object.fromEntries(
        selectedProduct.acfFields.map((field) => [
          field.name,
          Object.prototype.hasOwnProperty.call(prev, field.name)
            ? normalizeAcfValueForField(field, prev[field.name])
            : normalizeAcfValueForField(field, nextDefaults[field.name]),
        ])
      );
    });
  }, [selectedProduct]);

  useEffect(() => {
    if (!companionProductId) return;

    if (selectedProduct?.id === companionProductId) {
      setCompanionProductId(null);
      setCompanionRole('');
      setCompanionImageUrl('');
      return;
    }

    if (!products.some((product) => product.id === companionProductId)) {
      setCompanionProductId(null);
      setCompanionRole('');
      setCompanionImageUrl('');
    }
  }, [companionImageUrl, companionProductId, products, selectedProduct]);

  useEffect(() => {
    if (!secondaryCompanionProductId) return;

    if (
      selectedProduct?.id === secondaryCompanionProductId ||
      secondaryCompanionProductId === companionProductId
    ) {
      setSecondaryCompanionProductId(null);
      setSecondaryCompanionRole('');
      setSecondaryCompanionImageUrl('');
      return;
    }

    if (!products.some((product) => product.id === secondaryCompanionProductId)) {
      setSecondaryCompanionProductId(null);
      setSecondaryCompanionRole('');
      setSecondaryCompanionImageUrl('');
    }
  }, [companionProductId, products, secondaryCompanionProductId, selectedProduct]);

  useEffect(() => {
    if (!companionProduct) {
      if (companionImageUrl) {
        setCompanionImageUrl('');
      }
      return;
    }

    if (companionImageUrl && companionProduct.images.includes(companionImageUrl)) {
      return;
    }

    setCompanionImageUrl(companionProduct.image || companionProduct.images[0] || '');
  }, [companionImageUrl, companionProduct]);

  useEffect(() => {
    if (!secondaryCompanionProduct) {
      if (secondaryCompanionImageUrl) {
        setSecondaryCompanionImageUrl('');
      }
      return;
    }

    if (
      secondaryCompanionImageUrl &&
      secondaryCompanionProduct.images.includes(secondaryCompanionImageUrl)
    ) {
      return;
    }

    setSecondaryCompanionImageUrl(
      secondaryCompanionProduct.image || secondaryCompanionProduct.images[0] || ''
    );
  }, [secondaryCompanionImageUrl, secondaryCompanionProduct]);

  useEffect(() => {
    if (!companionRole) return;
    if (companionRoleOptions.includes(companionRole)) return;
    setCompanionRole('');
  }, [companionRole, companionRoleOptions]);

  useEffect(() => {
    if (!secondaryCompanionRole) return;
    if (companionRoleOptions.includes(secondaryCompanionRole)) return;
    setSecondaryCompanionRole('');
  }, [companionRoleOptions, secondaryCompanionRole]);

  useEffect(() => {
    if (!companionProduct || companionRole) return;
    setCompanionRole(getDefaultCompanionRoleForProduct(companionProduct));
  }, [companionProduct, companionRole, getDefaultCompanionRoleForProduct]);

  useEffect(() => {
    if (!companionProduct) {
      if (companionLength) {
        setCompanionLength('');
      }
      return;
    }

    if (!supportsLengthSelection(companionProduct)) {
      if (companionLength) {
        setCompanionLength('');
      }
      return;
    }

    if (!companionLength) {
      setCompanionLength(getDefaultLengthForProduct(companionProduct));
    }
  }, [companionLength, companionProduct]);

  useEffect(() => {
    if (!secondaryCompanionProduct || secondaryCompanionRole) return;
    setSecondaryCompanionRole(getDefaultCompanionRoleForProduct(secondaryCompanionProduct));
  }, [getDefaultCompanionRoleForProduct, secondaryCompanionProduct, secondaryCompanionRole]);

  useEffect(() => {
    if (!secondaryCompanionProduct) {
      if (secondaryCompanionLength) {
        setSecondaryCompanionLength('');
      }
      return;
    }

    if (!supportsLengthSelection(secondaryCompanionProduct)) {
      if (secondaryCompanionLength) {
        setSecondaryCompanionLength('');
      }
      return;
    }

    if (!secondaryCompanionLength) {
      setSecondaryCompanionLength(getDefaultLengthForProduct(secondaryCompanionProduct));
    }
  }, [secondaryCompanionLength, secondaryCompanionProduct]);

  useEffect(() => {
    if (!selectedProduct || !job) return;

    const shouldHaveLength = supportsLengthSelection(selectedProduct);
    const defaultLength = getDefaultLengthForProduct(selectedProduct);

    if (!shouldHaveLength && job.length) {
      updateJob('length', '');
      return;
    }

    if (shouldHaveLength && !job.length && defaultLength) {
      updateJob('length', defaultLength);
    }
  }, [job, selectedProduct]);

  useEffect(() => {
    if (categoryFilter === 'all') return;
    if (!availableCategories.some((category) => String(category.id) === categoryFilter)) {
      setCategoryFilter('all');
    }
  }, [availableCategories, categoryFilter]);

  useEffect(() => {
    setHasLoadedSession(false);
    setSelectedProduct(null);
    setSelectedSourceImages([]);
    setManualSourceImages([]);
    setJob(null);
    setSelectedColor('');
    setCompanionProductId(null);
    setCompanionRole('');
    setCompanionImageUrl('');
    setCompanionFit('');
    setCompanionLength('');
    setSecondaryCompanionProductId(null);
    setSecondaryCompanionRole('');
    setSecondaryCompanionImageUrl('');
    setSecondaryCompanionFit('');
    setSecondaryCompanionLength('');
    setCompanionProductSearch('');
    setIsCompanionPickerOpen(false);
    setCompanionPickerTarget(1);
    setSelectedAdditionalScenarios([]);
    setActiveTab('products');
    setGeneratedResults([]);
    setGeneratedDescriptionHtml('');
    setGeneratedShortDescriptionHtml('');
    setAcfValues({});
    setIsPreviewApproved(false);
    setGenError(null);
    setDescriptionError(null);
    setIsGeneratingDescription(false);
    setStage('idle');
  }, [projectId]);

  const scrollToSection = (elementId: string, delayMs = 0) => {
    const runScroll = () => {
      const element = document.getElementById(elementId);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };

    if (delayMs > 0) {
      window.setTimeout(runScroll, delayMs);
      return;
    }

    window.requestAnimationFrame(runScroll);
  };

  const openCompanionPicker = (slot: 1 | 2) => {
    setCompanionPickerTarget(slot);
    setCompanionProductSearch('');
    setIsCompanionPickerOpen(true);
    scrollToSection('companion-picker', 80);
    window.setTimeout(() => {
      companionSearchInputRef.current?.focus();
    }, 100);
  };

  useEffect(() => {
    if (products.length === 0 || selectedProduct) return;

    const rawSelectedProductId = window.localStorage.getItem(buildProjectSelectionKey(projectId));

    if (!rawSelectedProductId) {
      setHasLoadedSession(true);
      return;
    }

    const restoredProduct = products.find((product) => String(product.id) === rawSelectedProductId);

    if (!restoredProduct) {
      setHasLoadedSession(true);
      return;
    }

    void loadProductState(restoredProduct);
  }, [loadProductState, projectId, products, selectedProduct]);

  useEffect(() => {
    const rawShootingSettings = window.localStorage.getItem('futuria-shooting-settings');

    if (!rawShootingSettings) {
      setShootingSettings(defaultAmbientazioniCollection);
      return;
    }

    try {
      const parsed = normalizeAmbientazioniMap(rawShootingSettings);
      const nextSettings = parsed[projectId];
      setShootingSettings(nextSettings || defaultAmbientazioniCollection);
    } catch {
      setShootingSettings(defaultAmbientazioniCollection);
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;

    const loadScenarioReferences = async () => {
      const allSettings = [...shootingSettings.studio, ...shootingSettings.realLife];
      const entries = await Promise.all(
        allSettings.map(async (setting) => [setting.id, await readAmbientazioneReference(projectId, setting.id)] as const)
      );

      if (!cancelled) {
        setShootingReferenceImages(
          Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry[1])))
        );
      }
    };

    void loadScenarioReferences();

    return () => {
      cancelled = true;
    };
  }, [projectId, shootingSettings]);

  useEffect(() => {
    if (!job) return;

    const matchingSetting = studioSettings.find((setting) => setting.label === job.scenario);

    if (matchingSetting && matchingSetting.id !== job.scenario) {
      setJob((prev) => (prev ? { ...prev, scenario: matchingSetting.id } : prev));
    }
  }, [job, studioSettings]);

  useEffect(() => {
    setSelectedAdditionalScenarios((prev) =>
      prev
        .map((value) => realLifeSettings.find((setting) => setting.id === value || setting.label === value)?.id || null)
        .filter((value): value is string => Boolean(value))
    );
  }, [realLifeSettings]);

  useEffect(() => {
    const rawStartedProducts = window.localStorage.getItem(`futuria-started-products-${projectId}`);
    const rawSyncedProducts = window.localStorage.getItem(`futuria-synced-products-${projectId}`);
    const rawManualStatuses = window.localStorage.getItem(`futuria-manual-product-statuses-${projectId}`);

    try {
      const parsedStarted = rawStartedProducts ? (JSON.parse(rawStartedProducts) as number[]) : [];
      setStartedProductIds(Array.isArray(parsedStarted) ? parsedStarted : []);
    } catch {
      setStartedProductIds([]);
    }

    try {
      const parsedSynced = rawSyncedProducts ? (JSON.parse(rawSyncedProducts) as number[]) : [];
      setSyncedProductIds(Array.isArray(parsedSynced) ? parsedSynced : []);
    } catch {
      setSyncedProductIds([]);
    }

    try {
      const parsedManual = rawManualStatuses ? (JSON.parse(rawManualStatuses) as Record<string, ManualProductStatus>) : {};
      const normalizedManual = Object.fromEntries(
        Object.entries(parsedManual).map(([productId, status]) => [Number(productId), status])
      ) as Record<number, ManualProductStatus>;
      setManualProductStatuses(normalizedManual);
    } catch {
      setManualProductStatuses({});
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;

    const loadGeneratedProductIds = async () => {
      try {
        const ids = await listGeneratedProductIdsFromDb(projectId);

        if (!cancelled) {
          setGeneratedProductIds(ids);
        }
      } catch {
        if (!cancelled) {
          setGeneratedProductIds([]);
        }
      }
    };

    void loadGeneratedProductIds();

    return () => {
      cancelled = true;
    };
  }, [projectId, products.length]);

  useEffect(() => {
    window.localStorage.setItem(
      `futuria-started-products-${projectId}`,
      JSON.stringify(startedProductIds)
    );
  }, [projectId, startedProductIds]);

  useEffect(() => {
    window.localStorage.setItem(
      `futuria-synced-products-${projectId}`,
      JSON.stringify(syncedProductIds)
    );
  }, [projectId, syncedProductIds]);

  useEffect(() => {
    window.localStorage.setItem(
      `futuria-manual-product-statuses-${projectId}`,
      JSON.stringify(manualProductStatuses)
    );
  }, [manualProductStatuses, projectId]);

  useEffect(() => {
    if (products.length === 0) return;

    const normalizedTarget = (value: string) =>
      value
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

    const manuallyCompletedMatchers = [
      (normalizedName: string) => normalizedName.includes('abito ariel') && normalizedName.includes('test'),
      (normalizedName: string) => normalizedName.includes('camicia smanicata unisex'),
    ];

    const manuallyCompletedIds = products
      .filter((product) => {
        const normalizedName = normalizedTarget(product.name);
        return manuallyCompletedMatchers.some((matcher) => matcher(normalizedName));
      })
      .map((product) => product.id);

    if (manuallyCompletedIds.length === 0) return;

    setSyncedProductIds((prev) => {
      const next = [...prev];

      for (const productId of manuallyCompletedIds) {
        if (!next.includes(productId)) {
          next.push(productId);
        }
      }

      return next;
    });
  }, [products]);

  useEffect(() => {
    const rawProjects = window.localStorage.getItem('futuria-projects');
    const rawCurrent = window.localStorage.getItem('futuria-current-project-id');

    if (!rawProjects) {
      return;
    }

    try {
      const parsed = JSON.parse(rawProjects) as Array<{ id: string; name: string }>;
      const safeProjects = parsed.length > 0 ? parsed : [{ id: 'default', name: 'Futuria' }];
      const current = safeProjects.find((project) => project.id === rawCurrent) || safeProjects[0];

      setProjectId(current.id);
      setProjectName(current.name);
    } catch {}
  }, []);

  useEffect(() => {
    if (!hasLoadedSession) return;

    if (!selectedProduct) return;

    const sessionKey = buildProductSessionKey(projectId, selectedProduct.id);
    const session: ProductSession = {
      selectedSourceImages,
      manualSourceImages,
      job,
      selectedColor,
      companionProductId,
      companionRole,
      companionImageUrl,
      companionFit,
      companionLength,
      secondaryCompanionProductId,
      secondaryCompanionRole,
      secondaryCompanionImageUrl,
      secondaryCompanionFit,
      secondaryCompanionLength,
      selectedAdditionalScenarios,
      generatedDescriptionHtml,
      generatedShortDescriptionHtml,
      acfValues,
      activeTab,
      isPreviewApproved,
    };

    window.localStorage.setItem(sessionKey, JSON.stringify(session));
  }, [
    activeTab,
    hasLoadedSession,
    isPreviewApproved,
    job,
    manualSourceImages,
    projectId,
    selectedColor,
    companionProductId,
    companionRole,
    companionImageUrl,
    companionFit,
    companionLength,
    secondaryCompanionProductId,
    secondaryCompanionRole,
    secondaryCompanionImageUrl,
    secondaryCompanionFit,
    secondaryCompanionLength,
    selectedAdditionalScenarios,
    generatedDescriptionHtml,
    generatedShortDescriptionHtml,
    acfValues,
    selectedProduct,
    selectedSourceImages,
  ]);

  useEffect(() => {
    if (!hasLoadedSession || !selectedProduct) return;

    const sessionKey = buildProductSessionKey(projectId, selectedProduct.id);

    void writeGeneratedResultsToDb(sessionKey, generatedResults);

    setGeneratedProductIds((prev) => {
      const hasResults = generatedResults.length > 0;
      const alreadyIncluded = prev.includes(selectedProduct.id);

      if (hasResults && !alreadyIncluded) {
        return [...prev, selectedProduct.id];
      }

      if (!hasResults && alreadyIncluded) {
        return prev.filter((productId) => productId !== selectedProduct.id);
      }

      return prev;
    });
  }, [generatedResults, hasLoadedSession, projectId, selectedProduct]);

  const selectProduct = (product: Product) => {
    void (async () => {
      await loadProductState(product);
      scrollToSection('workflow-top');
    })();
  };

  const updateJob = <K extends keyof Job>(field: K, value: Job[K]) => setJob((prev) => (prev ? { ...prev, [field]: value } : prev));
  const getSource = (url: string) => selectedSourceImages.find((img) => img.url === url);
  const availableSourceImages = Array.from(
    new Set([...(selectedProduct?.images || []), ...manualSourceImages])
  );
  const toggleSource = (url: string) => {
    if (!selectedProduct) return;
    const defaultColor = selectedProduct.colors.length === 1 ? selectedProduct.colors[0] || '' : '';
    setSelectedSourceImages((prev) => prev.some((img) => img.url === url) ? prev.filter((img) => img.url !== url) : [...prev, { url, view: 'front', color: defaultColor, mode: 'garment-only' }]);
  };
  const updateSource = (url: string, patch: Partial<SelectedSourceImage>) => setSelectedSourceImages((prev) => prev.map((img) => (img.url === url ? { ...img, ...patch } : img)));
  const handleManualSourceUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);

    if (files.length === 0) {
      return;
    }

    const uploadedImages = await Promise.all(
      files
        .filter((file) => file.type.startsWith('image/'))
        .map(
          (file) =>
            new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                if (typeof reader.result === 'string') {
                  resolve(reader.result);
                  return;
                }

                reject(new Error('Formato file non supportato.'));
              };
              reader.onerror = () => reject(reader.error || new Error('Caricamento immagine fallito.'));
              reader.readAsDataURL(file);
            })
        )
    );

    setManualSourceImages((prev) => Array.from(new Set([...prev, ...uploadedImages])));
    event.target.value = '';
  };

  const getRelevantSourceImages = (pose: string, targetColor: string) => {
    const normalizedPose = pose.toLowerCase();
    const prioritizeGarmentOnly = (images: SelectedSourceImage[]) =>
      [...images].sort((a, b) => (a.mode === b.mode ? 0 : a.mode === 'garment-only' ? -1 : 1));
    const dedupeByUrl = (images: SelectedSourceImage[]) =>
      Array.from(new Map(images.map((image) => [image.url, image])).values());

    let poseRelevantImages = selectedSourceImages;

    if (normalizedPose.includes('back')) {
      const backAndSide = selectedSourceImages.filter(
        (image) => image.view === 'back' || image.view === 'side'
      );
      poseRelevantImages = backAndSide.length > 0 ? backAndSide : selectedSourceImages;
    } else if (normalizedPose.includes('side')) {
      const sideAndFront = selectedSourceImages.filter(
        (image) => image.view === 'side' || image.view === 'front'
      );
      poseRelevantImages = sideAndFront.length > 0 ? sideAndFront : selectedSourceImages;
    } else if (normalizedPose.includes('front')) {
      const frontAndSide = selectedSourceImages.filter(
        (image) => image.view === 'front' || image.view === 'side'
      );
      poseRelevantImages = frontAndSide.length > 0 ? frontAndSide : selectedSourceImages;
    }

    const normalizedTargetColor = normalizeReferenceColor(targetColor);
    const matchingColorEverywhere = normalizedTargetColor
      ? selectedSourceImages.filter(
          (image) => normalizeReferenceColor(image.color) === normalizedTargetColor
        )
      : [];
    const matchingColorPoseRelevant = normalizedTargetColor
      ? poseRelevantImages.filter(
          (image) => normalizeReferenceColor(image.color) === normalizedTargetColor
        )
      : [];

    const prioritizedImages = dedupeByUrl([
      ...matchingColorPoseRelevant,
      ...matchingColorEverywhere,
      ...poseRelevantImages,
    ]);

    return prioritizeGarmentOnly(prioritizedImages.length > 0 ? prioritizedImages : selectedSourceImages);
  };

  const getStrictColorSourceImages = (
    images: SelectedSourceImage[],
    targetColor: string
  ) => {
    const normalizedTargetColor = normalizeReferenceColor(targetColor);
    const prioritizeGarmentOnly = (items: SelectedSourceImage[]) =>
      [...items].sort((a, b) => (a.mode === b.mode ? 0 : a.mode === 'garment-only' ? -1 : 1));

    if (!normalizedTargetColor) {
      return prioritizeGarmentOnly(images);
    }

    const exactMatches = images.filter(
      (image) => normalizeReferenceColor(image.color) === normalizedTargetColor
    );

    if (exactMatches.length > 0) {
      return prioritizeGarmentOnly(exactMatches);
    }

    const garmentOnlyFallback = images.filter((image) => image.mode === 'garment-only');

    return prioritizeGarmentOnly(
      garmentOnlyFallback.length > 0 ? garmentOnlyFallback : images
    );
  };

  const buildReferencePromptForImages = (
    images: SelectedSourceImage[],
    _startIndex: number,
    targetColor: string
  ) =>
    images
      .map((img) => {
        const viewInstruction =
          img.view === 'front'
            ? 'This reference shows the FRONT of the garment. Use it to understand front-facing details and front silhouette.'
            : img.view === 'back'
              ? 'This reference shows the BACK of the garment. Use it to understand rear-facing details and back silhouette.'
              : 'This reference shows the SIDE of the garment. Use it to understand the side silhouette, side seams, and lateral proportions.';
        const modeInstruction =
          img.mode === 'garment-only'
            ? 'This is a GARMENT-ONLY reference. Prioritize it strongly as the safest source for garment shape, fabric, and details.'
            : 'This is a WORN reference. Use it only for the clothing item. If a person is visible, ignore the wearer completely and do not copy the wearer identity, face, body, or ethnicity.';
        const colorInstruction =
          normalizeReferenceColor(img.color) === normalizeReferenceColor(targetColor)
            ? 'This reference matches the requested target color exactly. Use its exact visible hue, undertone, saturation, and brightness as the color source of truth.'
            : 'If this reference is a different colorway, use it only for garment construction and never for the final garment color.';

        return `A provided garment reference shows the ${img.color} colorway from the ${img.view} view. ${viewInstruction} ${modeInstruction} ${colorInstruction}`;
      })
      .join(' ');

  const expandShootingPrompt = (settingLabel: string) => {
    const normalized = settingLabel.toLowerCase();
    const qualities = [
      'professional commercial fashion photography',
      'clean premium e-commerce composition',
      'accurate garment color rendering',
      'high detail fabric texture',
      'natural shadows',
      'balanced exposure',
      'catalog-ready retouching',
    ];

    if (normalized.includes('studio') && normalized.includes('bianco')) {
      qualities.push('pure white seamless studio background', 'soft diffused studio lighting', 'minimal visual distractions');
    } else if (normalized.includes('studio')) {
      qualities.push('controlled indoor studio lighting', 'clean background matching the requested studio mood');
    } else if (normalized.includes('parco')) {
      qualities.push('outdoor natural daylight', 'pleasant environmental depth', 'soft natural atmosphere');
    } else if (normalized.includes('spiaggia')) {
      qualities.push('bright airy outdoor light', 'clean open background', 'sunlit coastal atmosphere');
    } else if (normalized.includes('cameretta')) {
      qualities.push('soft indoor lifestyle lighting', 'warm family-friendly environment', 'bright natural room ambience');
    }

    if (normalized.includes('passeggiata con mamma e papa')) {
      qualities.push(
        'set this lifestyle scene in an iconic outdoor Milan location',
        'recognisable elegant Milan atmosphere such as Brera streets, Parco Sempione, or the area near the Duomo',
        'family walk feeling in refined, upscale Milan surroundings'
      );
    }

    if (
      normalized.includes("una sera d'estate") ||
      normalized.includes('gelato con gli amici')
    ) {
      qualities.push(
        'set this lifestyle scene in an iconic Milan summer location',
        'recognisable Milan context such as Navigli, Brera, or elegant central Milan streets',
        'warm early evening light with a refined urban Milan atmosphere'
      );
    }

    return `Shooting direction from user setting "${settingLabel}": ${qualities.join(', ')}. Keep the final image visually consistent with this setting.`;
  };

  const buildMainGarmentShapePrompt = () => {
    const instructions: string[] = [];

    if (job?.fit) {
      instructions.push(`Main garment fit requirement: ${job.fit}.`);
    }

    if (supportsLengthSelection(selectedProduct)) {
      const effectiveLength = job?.length || getDefaultLengthForProduct(selectedProduct);

      if (effectiveLength) {
        instructions.push(`Main garment length requirement: ${effectiveLength}.`);

        if (effectiveLength === 'Lungo che copre le caviglie') {
          instructions.push(
            'If the main garment is trousers, the hem must reach below the ankle and cover the ankles. No cropped trouser length and no exposed ankles are allowed.'
          );
        } else if (effectiveLength === 'A tre quarti') {
          instructions.push(
            'If the main garment is trousers, the hem must stop around mid-calf. It must not extend to the ankle.'
          );
        } else if (effectiveLength === 'Sotto al ginocchio') {
          instructions.push(
            'If the main garment is shorts or lower-body bottoms, the hem must fall clearly below the knee.'
          );
        } else if (effectiveLength === 'Sopra al ginocchio') {
          instructions.push(
            'If the main garment is shorts or lower-body bottoms, the hem must stay clearly above the knee.'
          );
        }
      }
    }

    return instructions.join(' ');
  };

  const buildCompanionGarmentShapePrompt = (entry: {
    role: string;
    fit: string;
    length: string;
    product: Product;
  }) => {
    const instructions: string[] = [];

    if (entry.fit) {
      instructions.push(`Fit requirement for this secondary garment: ${entry.fit}.`);
    }

    if (supportsLengthSelection(entry.product)) {
      const effectiveLength = entry.length || getDefaultLengthForProduct(entry.product);

      if (effectiveLength) {
        instructions.push(`Length requirement for this secondary garment: ${effectiveLength}.`);

        if (effectiveLength === 'Lungo che copre le caviglie') {
          instructions.push(
            'If this secondary garment is trousers, the hem must reach below the ankle and cover the ankles. No cropped trouser length and no exposed ankles are allowed.'
          );
        } else if (effectiveLength === 'A tre quarti') {
          instructions.push(
            'If this secondary garment is trousers, the hem must stop around mid-calf.'
          );
        } else if (effectiveLength === 'Sotto al ginocchio') {
          instructions.push(
            'If this secondary garment is shorts or lower-body bottoms, the hem must fall clearly below the knee.'
          );
        } else if (effectiveLength === 'Sopra al ginocchio') {
          instructions.push(
            'If this secondary garment is shorts or lower-body bottoms, the hem must stay clearly above the knee.'
          );
        }
      }
    }

    return instructions.join(' ');
  };

  const sanitizeFilePart = (value: string) =>
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'image';

  const buildFilename = (result: GeneratedResult) => {
    const productName = sanitizeFilePart(selectedProduct?.name || 'product');
    const color = sanitizeFilePart(result.color || selectedColor || 'default');
    const pose = sanitizeFilePart(result.pose);
    const extension = result.url.startsWith('data:image/webp')
      ? 'webp'
      : result.url.startsWith('data:image/jpeg')
        ? 'jpg'
        : 'png';
    return `${productName} ${color} ${pose} di Farway Milano.${extension}`;
  };

  const downloadResult = (result: GeneratedResult) => {
    const link = document.createElement('a');
    link.href = result.url;
    link.download = buildFilename(result);
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const downloadAllResults = async () => {
    for (const result of generatedResults) {
      downloadResult(result);
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
  };

  const getDescriptionReferenceUrls = (results: GeneratedResult[]) => {
    const picked: GeneratedResult[] = [];
    const addIfPresent = (result: GeneratedResult | undefined) => {
      if (!result) return;
      if (picked.some((item) => item.key === result.key)) return;
      picked.push(result);
    };

    addIfPresent(results.find((result) => result.kind === 'hero'));
    addIfPresent(
      results.find(
        (result) =>
          result.kind === 'front' &&
          normalizeReferenceColor(result.color) === normalizeReferenceColor(selectedColor)
      ) || results.find((result) => result.kind === 'front')
    );
    addIfPresent(
      results.find(
        (result) => result.kind === 'gallery' && result.pose.toLowerCase().includes('back')
      ) || results.find((result) => result.kind === 'gallery')
    );
    addIfPresent(
      results.find(
        (result) => result.kind === 'gallery' && result.pose.toLowerCase().includes('action')
      )
    );
    addIfPresent(results.find((result) => result.kind === 'extra'));

    return picked.slice(0, 5).map((result) => result.url);
  };

  const setAcfFieldValue = (field: AcfField, value: string | string[]) => {
    setAcfValues((prev) => ({
      ...prev,
      [field.name]: normalizeAcfValueForField(field, value),
    }));
  };

  const toggleAcfCheckboxValue = (field: AcfField, optionValue: string) => {
    const currentValue = Array.isArray(acfValues[field.name]) ? acfValues[field.name] : [];
    const nextValue = currentValue.includes(optionValue)
      ? currentValue.filter((value) => value !== optionValue)
      : [...currentValue, optionValue];

    setAcfFieldValue(field, nextValue);
  };

  const renderAcfFieldControl = (field: AcfField) => {
    const fieldValue = normalizeAcfValueForField(field, acfValues[field.name]);

    if (field.type === 'checkbox') {
      const selectedValues = Array.isArray(fieldValue) ? fieldValue : [];
      const knownChoiceValues = new Set(field.choices.map((choice) => choice.value));
      const customValues = selectedValues.filter((value) => !knownChoiceValues.has(value));

      return (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {field.choices.map((choice) => {
              const isActive = selectedValues.includes(choice.value);

              return (
                <button
                  key={choice.value}
                  type="button"
                  onClick={() => toggleAcfCheckboxValue(field, choice.value)}
                  className={`rounded-full px-3 py-2 text-xs font-black uppercase tracking-wide transition-all ${
                    isActive
                      ? 'bg-[#103D66] text-white'
                      : 'border border-[#D7D9DD] bg-white text-[#4C6583]'
                  }`}
                >
                  {choice.label}
                </button>
              );
            })}
          </div>
          {field.allowCustom ? (
            <div className="space-y-2">
              {customValues.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {customValues.map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() =>
                        setAcfFieldValue(
                          field,
                          selectedValues.filter((item) => item !== value)
                        )
                      }
                      className="rounded-full border border-dashed border-[#D7D9DD] px-3 py-2 text-xs font-bold text-[#103D66]"
                    >
                      {value} <span className="text-slate-400">x</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  const nextValue = window.prompt('Inserisci una voce personalizzata');
                  if (!nextValue) return;
                  setAcfFieldValue(field, [...selectedValues, nextValue]);
                }}
                className="text-xs font-bold text-[#103D66] underline"
              >
                Aggiungi voce personalizzata
              </button>
            </div>
          ) : null}
          {selectedValues.length > 0 ? (
            <button
              type="button"
              onClick={() => setAcfFieldValue(field, [])}
              className="text-xs font-bold text-slate-400 underline"
            >
              Svuota selezione
            </button>
          ) : null}
        </div>
      );
    }

    if (field.type === 'radio') {
      const selectedValue = typeof fieldValue === 'string' ? fieldValue : '';
      const isPresetChoice = field.choices.some((choice) => choice.value === selectedValue);

      return (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {field.choices.map((choice) => {
              const isActive = selectedValue === choice.value;

              return (
                <button
                  key={choice.value}
                  type="button"
                  onClick={() => setAcfFieldValue(field, choice.value)}
                  className={`rounded-full px-3 py-2 text-xs font-black uppercase tracking-wide transition-all ${
                    isActive
                      ? 'bg-[#6DA34D] text-white'
                      : 'border border-[#D7D9DD] bg-white text-[#4C6583]'
                  }`}
                >
                  {choice.label}
                </button>
              );
            })}
          </div>
          {field.allowCustom ? (
            <input
              type="text"
              value={isPresetChoice ? '' : selectedValue}
              onChange={(event) => setAcfFieldValue(field, event.target.value)}
              placeholder="Oppure inserisci un valore personalizzato"
              className="w-full rounded-2xl border border-[#D7D9DD] bg-[#F8FAFB] px-4 py-3 text-sm text-[#103D66] outline-none"
            />
          ) : null}
          {selectedValue ? (
            <button
              type="button"
              onClick={() => setAcfFieldValue(field, '')}
              className="text-xs font-bold text-slate-400 underline"
            >
              Nessun valore
            </button>
          ) : null}
        </div>
      );
    }

    if (field.type === 'wysiwyg') {
      const htmlValue = typeof fieldValue === 'string' ? fieldValue : '';

      return (
        <div
          contentEditable
          suppressContentEditableWarning
          onBlur={(event) => setAcfFieldValue(field, event.currentTarget.innerHTML)}
          className="min-h-[140px] rounded-2xl border border-[#D7D9DD] bg-[#F8FAFB] px-4 py-3 text-sm leading-7 text-[#103D66] outline-none [&_p]:mb-4 [&_p:last-child]:mb-0 [&_strong]:font-black"
          dangerouslySetInnerHTML={{
            __html: htmlValue || '<p></p>',
          }}
        />
      );
    }

    const textValue = typeof fieldValue === 'string' ? fieldValue : '';

    return (
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={textValue}
          onChange={(event) => setAcfFieldValue(field, event.target.value)}
          placeholder={field.placeholder || 'Inserisci un valore'}
          className="w-full rounded-2xl border border-[#D7D9DD] bg-[#F8FAFB] px-4 py-3 text-sm text-[#103D66] outline-none"
        />
        {field.append ? (
          <span className="shrink-0 text-xs font-black uppercase text-slate-400">
            {field.append}
          </span>
        ) : null}
      </div>
    );
  };

  const generateProductDescription = async (resultsOverride?: GeneratedResult[]) => {
    if (!selectedProduct) return;

    const effectiveResults = resultsOverride && resultsOverride.length > 0
      ? resultsOverride
      : generatedResults;

    if (effectiveResults.length === 0) return;

    setIsGeneratingDescription(true);
    setDescriptionError(null);

    try {
      const response = await fetch('/api/generate-description', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productName: selectedProduct.name,
          currentDescription: selectedProduct.description || '',
          categories: selectedProduct.categories.map((category) => category.name),
          selectedAdditionalScenarioLabels: selectedAdditionalScenarioSettings.map(
            (scenario) => scenario.label
          ),
          generatedImageUrls: getDescriptionReferenceUrls(effectiveResults),
        }),
      });

      const data = (await response.json()) as {
        descriptionHtml?: string;
        shortDescriptionHtml?: string;
        error?: string;
      };

      if (!response.ok || !data.descriptionHtml) {
        throw new Error(data.error || 'Generazione descrizione fallita');
      }

      setGeneratedDescriptionHtml(data.descriptionHtml);
      setGeneratedShortDescriptionHtml(data.shortDescriptionHtml || '');
    } catch (error: unknown) {
      setDescriptionError(
        error instanceof Error ? error.message : 'Errore generazione descrizione'
      );
    } finally {
      setIsGeneratingDescription(false);
    }
  };

  const syncToWooCommerce = async () => {
    if (!selectedProduct || generatedResults.length === 0) return;

    setIsSyncingWoo(true);
    setShowWooSyncCompleteModal(false);
    setWooSyncProgress(0);
    setWooSyncPhase('Avvio sincronizzazione');
    setWooSyncMessage(null);

    try {
      const res = await fetch('/api/sync-woocommerce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectName,
          productId: selectedProduct.id,
          productName: selectedProduct.name,
          generatedResults,
          productDescriptionHtml: generatedDescriptionHtml,
          productShortDescriptionHtml: generatedShortDescriptionHtml,
          acfValues,
          selectedAdditionalScenarioLabels: selectedAdditionalScenarioSettings.map(
            (scenario) => scenario.label
          ),
          companionProductIds: [companionProductId, secondaryCompanionProductId].filter(
            (value): value is number => Boolean(value)
          ),
          syncMode: wooSyncMode,
        }),
      });

      const data = (await res.json()) as {
        jobId?: string;
        error?: string;
        progress?: number;
        phase?: string;
      };

      if (!res.ok || !data.jobId) {
        throw new Error(data.error || 'Sincronizzazione WooCommerce fallita');
      }

      setWooSyncProgress(data.progress || 0);
      setWooSyncPhase(data.phase || 'In coda');

      while (true) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));

        const statusRes = await fetch(`/api/sync-woocommerce?jobId=${encodeURIComponent(data.jobId)}`, {
          cache: 'no-store',
        });

        const statusData = (await statusRes.json()) as {
          error?: string;
          status?: 'queued' | 'running' | 'completed' | 'failed';
          progress?: number;
          phase?: string;
          message?: string | null;
        };

        if (!statusRes.ok) {
          throw new Error(statusData.error || 'Stato sincronizzazione non disponibile');
        }

        setWooSyncProgress(statusData.progress || 0);
        setWooSyncPhase(statusData.phase || null);

        if (statusData.status === 'completed') {
          setSyncedProductIds((prev) =>
            prev.includes(selectedProduct.id) ? prev : [...prev, selectedProduct.id]
          );
          const syncedCover =
            galleryResults.find((result) => result.pose === 'In Action') ||
            previewResult ||
            generatedResults[0] ||
            null;

          if (syncedCover) {
            setProducts((prev) =>
              prev.map((product) =>
                product.id === selectedProduct.id
                  ? {
                      ...product,
                      image: syncedCover.url,
                      images: [syncedCover.url, ...product.images.filter((image) => image !== syncedCover.url)],
                    }
                  : product
              )
            );
            setSelectedProduct((prev) =>
              prev && prev.id === selectedProduct.id
                ? {
                    ...prev,
                    image: syncedCover.url,
                    images: [syncedCover.url, ...prev.images.filter((image) => image !== syncedCover.url)],
                  }
                : prev
            );
          }
          setWooSyncMessage(statusData.message || 'Sincronizzazione completata.');
          setShowWooSyncCompleteModal(true);
          break;
        }

        if (statusData.status === 'failed') {
          throw new Error(statusData.message || 'Sincronizzazione WooCommerce fallita');
        }
      }
    } catch (error: unknown) {
      setWooSyncProgress(100);
      setWooSyncPhase('Errore');
      setWooSyncMessage(error instanceof Error ? error.message : 'Errore sconosciuto');
    } finally {
      setIsSyncingWoo(false);
      window.setTimeout(() => {
        setWooSyncProgress(0);
        setWooSyncPhase(null);
      }, 900);
    }
  };

  const requestImage = async (args: {
    key: string; kind: 'hero' | 'front' | 'gallery' | 'extra' | 'alternate'; pose: string; posePrompt: string; targetColor: string; anchorImageUrl?: string; anchorInstruction?: string; scenarioOverrideLabel?: string; scenarioOverrideReferenceUrl?: string; genderOverride?: string; additionalCorrectionPrompt?: string;
  }) => {
    if (!job) throw new Error('Configurazione non pronta.');
    const normalizedRequestPose = args.pose.toLowerCase();
    const relevantSourceImages = getRelevantSourceImages(args.pose, args.targetColor);
    const strictColorSourceImages = getStrictColorSourceImages(
      relevantSourceImages,
      args.targetColor
    );
    const effectiveGender = args.genderOverride || job.gender;
    const scenarioLabel = args.scenarioOverrideLabel || selectedScenarioLabel;
    const scenarioReferenceUrl =
      args.scenarioOverrideReferenceUrl !== undefined
        ? args.scenarioOverrideReferenceUrl
        : args.scenarioOverrideLabel
          ? undefined
          : selectedScenarioReferenceUrl;
    const companionReferences = selectedCompanionEntries.map((entry) => ({
      productName: entry.product.name,
      role: entry.role,
      fit: entry.fit,
      length: entry.length,
      product: entry.product,
      imageUrl: entry.imageUrl,
    }));
    const imageUrls = [
      ...(args.anchorImageUrl ? [args.anchorImageUrl] : []),
      ...relevantSourceImages.map((img) => img.url),
      ...(scenarioReferenceUrl ? [scenarioReferenceUrl] : []),
      ...companionReferences.map((entry) => entry.imageUrl).filter(Boolean),
    ];
    const finalGenerationImageUrls = Array.from(
      new Set(
        [
          ...(args.anchorImageUrl ? [args.anchorImageUrl] : []),
          ...(strictColorSourceImages[0]?.url
            ? [strictColorSourceImages[0].url]
            : relevantSourceImages[0]?.url
              ? [relevantSourceImages[0].url]
              : []),
          ...(scenarioReferenceUrl ? [scenarioReferenceUrl] : []),
          ...companionReferences.map((entry) => entry.imageUrl).filter(Boolean),
        ].filter(Boolean)
      )
    );
    const companionReferenceStartIndex =
      (args.anchorImageUrl ? 1 : 0) + relevantSourceImages.length + (scenarioReferenceUrl ? 1 : 0) + 1;
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageUrls,
        finalGenerationImageUrls,
        generationKind: args.kind,
        garmentReferenceImageUrls: relevantSourceImages.map((img) => img.url),
        colorReferenceImageUrls: strictColorSourceImages.map((img) => img.url),
        targetColorLabel: args.targetColor,
        productName: selectedProduct?.name || '',
        prompt: [
          'Follow this workflow exactly: first isolate the garment from the original product references, then lock garment construction and details from those references only, then lock color from the matching target-color references only, and only after that use any anchor image for continuity.',
          `Target product title: ${selectedProduct?.name || ''}.`,
          'The target garment is the product named in the title above.',
          'Any mention of "capo" or garment always means the clothing item only, never the head, face, or any body part.',
          'If any reference image contains multiple garments, multiple looks, multiple children, or more than one product, identify only the target garment that matches the product title and ignore every other garment or subject completely.',
          'Do not blend, combine, borrow, or average details from any other garment visible in the reference images.',
          'The garment must remain absolutely faithful to the references. Do not invent, add, redesign, embellish, or stylize any garment detail.',
          'Garment construction, silhouette, trims, seams, decorative elements, and every clothing detail must come only from the original product reference images, never from the anchor image and never from text labels.',
          'If a decorative element is not explicitly visible in the original product references, it is forbidden in the output.',
          'Never improve, complete, embellish, or "make more premium" the garment. Simpler is always safer than inventing.',
          'Do not add bows, ruffles, pleats, buttons, belts, pockets, trims, embroidery, stitching, prints, logos, seams, collars, sleeves, ties, textures, layers, or accessories unless they are clearly visible in the provided references.',
          'If a garment detail is not clearly visible in the references, omit it rather than guessing.',
          'The safest behavior is strict fidelity: reproduce only what is explicitly present in the references and nothing else.',
          'Keep the full model and all garments comfortably inside the frame with visible safety margin on top, bottom, left, and right edges.',
          'Leave roughly 8 to 12 percent breathing room around the subject for possible frontend cropping. Do not crop close to any edge.',
          `Size/Age: ${job.modelAge}.`,
          `Gender: ${effectiveGender}.`,
          `The visible model for this shot must clearly read as ${effectiveGender}.`,
          args.kind === 'alternate'
            ? `This is an alternate-gender generation. Create a brand new ${effectiveGender.toLowerCase()} model from scratch for this shot. Do not preserve, mimic, or continue the model identity from any previously generated image.`
            : '',
          args.kind === 'alternate'
            ? 'Do not use any previously generated image as an identity reference for this shot. Keep only the garment fidelity and color fidelity from the original product references.'
            : '',
          `Required model ethnicity: ${job.ethnicity}.`,
          `The generated model must visibly read as ${job.ethnicity} and this ethnicity must stay consistent across every generated shot in this batch.`,
          buildMainGarmentShapePrompt(),
          args.kind === 'extra'
            ? 'For special-occasion lifestyle scenes, the model must be visibly in action and doing something natural that clearly fits the environment, moment, and space. Avoid static standing poses in these images.'
            : '',
          normalizedRequestPose.includes('action')
            ? 'The model should look moderately happy, with a soft natural smile and a pleasant positive expression.'
            : 'Even in catalog poses, the model should look gently happy and approachable, with a visible soft natural smile rather than a neutral expression.',
          'Avoid exaggerated laughter, overly dramatic expressions, or a blank emotionless face.',
          'The human subject shown in any product reference image is never the target model for the output.',
          'If a product reference shows a child, adult, face, hair, skin tone, body shape, pose, or identity, treat all of that as irrelevant noise and ignore it completely.',
          'Use product references only to extract garment information. Never copy the reference model, never preserve the reference face, and never inherit the reference ethnicity from any reference image.',
          'Treat every human subject visible in the product references as a forbidden source for identity. Their face, hairstyle, skin tone, age appearance, body shape, and ethnicity must not appear in the output.',
          'The output person must look clearly different from any person visible in the references.',
          'If a reference image shows the garment worn by a real child or model, mentally crop out only the clothing item and discard the wearer completely.',
          'Do not preserve the same child, do not create a lookalike, and do not keep the same face or ethnicity as the wearer in the reference image.',
          'The output model must be a completely new person created from the written configuration only, especially the selected age/size, gender, and ethnicity.',
          `The selected ethnicity (${job.ethnicity}) is mandatory and overrides any ethnicity implied by the reference photos.`,
          `If the reference person appears to be a different ethnicity than ${job.ethnicity}, ignore the reference person and still generate a new ${job.ethnicity} model.`,
          'If there is any conflict between the reference model appearance and the written configuration, always obey the written configuration and ignore the reference model appearance.',
          `Scenario label: ${scenarioLabel}.`,
          expandShootingPrompt(scenarioLabel),
          scenarioReferenceUrl
            ? 'The last reference image is the environment reference for the selected ambientazione. Interpret it as guidance for background, light direction, styling mood, and set design only. Do not copy any person or garment from that image.'
            : '',
          ...companionReferences.flatMap((entry, index) => {
            const referenceIndex = companionReferenceStartIndex + index;
            return [
              `Additional same-brand outfit product ${index + 1}: "${entry.productName}". The model must also wear this exact extra product together with the main product, keeping all garments clearly distinct and faithful to their own references.`,
              `Role of additional same-brand garment ${index + 1}: ${entry.role}. Place and style this secondary product as a ${entry.role.toLowerCase()} in the outfit.`,
              buildCompanionGarmentShapePrompt(entry),
              `Keep the secondary garment "${entry.productName}" in its own exact visible color from its own dedicated reference image. Never recolor it to match the main product colorway.`,
              `Reference image ${referenceIndex} is the outfit companion reference for "${entry.productName}". Use that image only to reproduce that secondary garment. Do not confuse it with the main product or with any other companion garment.`,
            ];
          }),
          `Target garment colorway: ${args.targetColor}.`,
          'Only use the requested colorway for the final garment.',
          'The color label is only a routing key used to identify which reference images belong to the target colorway. It is never a visual instruction.',
          'Do not infer, approximate, shift, or stylize the garment color from the wording of the color label, category, or product name.',
          'The exact visible garment color in the matching target-color reference images is the only allowed source of truth for hue, undertone, saturation, brightness, and depth.',
          'If the text label suggests a shade but the matching target-color reference image shows a different exact shade, always follow the exact visible shade from the matching reference image.',
          'When there is any conflict between text and the visible color in the matching reference images, the visible color in the matching reference images must win completely.',
          'The requested target colorway applies only to the main product garment.',
          'Do not recolor, tint, harmonize, or shift any secondary garment, companion garment, or accessory to the main product colorway.',
          'Every secondary garment must preserve its own original color exactly as shown in its own reference image.',
          'The final output must be one single portrait image in a strict 4:5 aspect ratio.',
          'Output exactly one single final photograph.',
          'Never create a collage, diptych, split-screen, side-by-side comparison, before/after layout, contact sheet, mirrored composition, or any multi-panel image.',
          'Do not show two versions of the model, two crops, or two framings in the same image.',
          'Do not crop the image into left/right sections or combine a full-body view with a close-up in one frame.',
          'The result must be one coherent single-camera shot with one subject and one continuous background.',
          'If an anchor image is provided, use it only for model identity, expression, framing, and continuity. Never use the anchor image as a garment-design reference.',
          'The anchor image must not introduce new trims, bows, belts, waist details, prints, or construction changes.',
          'Respect front/back/side labels strictly and use only the provided pose-relevant references to understand the visible side of the garment.',
          'For a front pose, the visible front of the garment must face the camera. For a back pose, the visible back of the garment must face the camera.',
          'Use source images only to understand the garment. Ignore any visible person, face, body, child, mannequin, skin tone, hairstyle, or styling of the human subject in those source images.',
          args.additionalCorrectionPrompt
            ? `Apply these additional correction instructions to this new render: ${args.additionalCorrectionPrompt}.`
            : '',
          buildReferencePromptForImages(relevantSourceImages, args.anchorImageUrl ? 2 : 1, args.targetColor),
          args.anchorImageUrl ? `If an anchor image is provided, use it only for model identity, expression, framing, and continuity. Never use it as the source of truth for garment design, garment color, trims, bows, decorations, or construction details. ${args.anchorInstruction || ''}` : 'Create a clean front hero image for the requested color.',
          `Pose: ${args.posePrompt}.`,
        ].join(' '),
      }),
    });
    const data = (await response.json()) as { image?: string; error?: string };
    if (!response.ok || !data.image) throw new Error(data.error || "L'IA ha risposto con un errore");
    const optimizedUrl = await optimizeGeneratedImage(`data:image/png;base64,${data.image}`);
    return { key: args.key, kind: args.kind, pose: args.pose, color: args.targetColor, url: optimizedUrl } satisfies GeneratedResult;
  };

  const startGeneration = async () => {
    if (!isSetupComplete) return;
    if (selectedProduct) {
      setStartedProductIds((prev) =>
        prev.includes(selectedProduct.id) ? prev : [...prev, selectedProduct.id]
      );
    }
    setStage('hero');
    setGenError(null);
    setDescriptionError(null);
    setGeneratedResults([]);
    setGeneratedDescriptionHtml('');
    setGeneratedShortDescriptionHtml('');
    setIsPreviewApproved(false);
    setActiveTab('gallery');
    scrollToSection('step-4-hero', 80);
    try {
      const hero = await requestImage({
        key: `hero-${selectedColor}`,
        kind: 'hero',
        pose: 'Front Hero',
        posePrompt: 'front view, full body, clean studio catalog hero shot',
        targetColor: selectedColor,
      });
      setGeneratedResults([hero]);
    } catch (err: unknown) {
      setGenError(err instanceof Error ? err.message : 'Errore sconosciuto');
    } finally {
      setStage('idle');
    }
  };

  const toggleAdditionalScenario = (scenario: string) => {
    setSelectedAdditionalScenarios((prev) =>
      prev.includes(scenario) ? prev.filter((item) => item !== scenario) : [...prev, scenario]
    );
  };

  const approveAndGenerateAll = async () => {
    if (!selectedProduct || !previewResult || isPreviewApproved) return;
    if (
      selectedAdditionalScenarioSettings.length === 0 &&
      !window.confirm(
        'Non hai selezionato ambientazioni extra opzionali. Vuoi continuare comunque e generare solo il set principale?'
      )
    ) {
      return;
    }
    setStage('production');
    setGenError(null);
    setIsPreviewApproved(true);
    scrollToSection('step-5-output', 80);
    try {
      const next: GeneratedResult[] = [previewResult];
      for (const color of selectedProduct.colors) {
        next.push(await requestImage({
          key: `front-${color}`,
          kind: 'front',
          pose: 'Front',
          posePrompt: 'front view, full body, same studio setup, very similar pose to the anchor image',
          targetColor: color,
          anchorImageUrl: previewResult.url,
          anchorInstruction: [
            'Keep the same generated model identity, framing, lighting, and studio setup as the anchor image.',
            `Keep the exact same visible ethnicity as the anchor image (${job?.ethnicity}).`,
            'Do not drift toward another ethnicity or different facial features.',
            'Keep the pose very similar but not exactly identical.',
            'Generate a fresh new image, not an edited copy of the anchor image.',
            'Use the anchor only for continuity. Rebuild the garment only from the original product references for the requested target colorway.',
            'Do not transfer garment details from the anchor image. The original product references remain the only authority for garment construction and decorative details.',
          ].join(' '),
        }));
        setGeneratedResults([...next]);
      }
      const galleryAnchor = next.find((r) => r.key === `front-${selectedColor}`) || next.find((r) => r.key === `hero-${selectedColor}`) || previewResult;
      for (const pose of galleryPoses) {
        next.push(await requestImage({
          key: `gallery-${selectedColor}-${pose.key}`,
          kind: 'gallery',
          pose: pose.label,
          posePrompt: pose.prompt,
          targetColor: selectedColor,
          anchorImageUrl: galleryAnchor.url,
          anchorInstruction: `Keep the same generated model identity and the same visible ethnicity as the anchor image (${job?.ethnicity}). Do not drift toward another ethnicity. Use the anchor only for identity and continuity. The original product references remain the only authority for garment design and color. Generate a fresh new shot and change only the pose for this image.`,
        }));
        setGeneratedResults([...next]);
      }
      for (const scenario of selectedAdditionalScenarioSettings) {
        next.push(await requestImage({
          key: `extra-${selectedColor}-${sanitizeFilePart(scenario.label)}`,
          kind: 'extra',
          pose: scenario.label,
          posePrompt: 'full body lifestyle fashion photo, premium editorial storytelling, the model is actively doing something natural and believable that clearly fits the requested scenario and environment',
          targetColor: selectedColor,
          anchorImageUrl: galleryAnchor.url,
          anchorInstruction: `Keep the same generated model identity and the same visible ethnicity as the anchor image (${job?.ethnicity}). Do not drift toward another ethnicity. Use the anchor only for continuity. The original product references remain the only authority for garment design and color. Generate a fresh new image and adapt only the environment and mood to the requested scenario.`,
          scenarioOverrideLabel: scenario.label,
          scenarioOverrideReferenceUrl: shootingReferenceImages[scenario.id],
        }));
        setGeneratedResults([...next]);
      }
      if (isUnisexProduct && alternateGender) {
        next.push(await requestImage({
          key: `alternate-${selectedColor}-front-${sanitizeFilePart(alternateGender)}`,
          kind: 'alternate',
          pose: `Front ${alternateGender}`,
          posePrompt: 'front view, full body, same studio setup, clean catalog photo',
          targetColor: selectedColor,
          genderOverride: alternateGender,
        }));
        setGeneratedResults([...next]);
        next.push(await requestImage({
          key: `alternate-${selectedColor}-action-${sanitizeFilePart(alternateGender)}`,
          kind: 'alternate',
          pose: `In Action ${alternateGender}`,
          posePrompt: 'natural action pose, realistic movement, commercial fashion photo',
          targetColor: selectedColor,
          genderOverride: alternateGender,
        }));
        setGeneratedResults([...next]);
      }
      await generateProductDescription(next);
    } catch (err: unknown) {
      setGenError(err instanceof Error ? err.message : 'Errore sconosciuto');
      setIsPreviewApproved(false);
    } finally {
      setStage('idle');
    }
  };

  const regenerateGeneratedResult = async (result: GeneratedResult) => {
    if (!selectedProduct || !job) return;

    const correctionPrompt = (regenerationDrafts[result.key] || '').trim();

    setRegeneratingKey(result.key);
    setGenError(null);

    try {
      const baseAnchorInstruction = [
        'Reference image 1 is the current generated shot for this image.',
        'Use it only as a composition and continuity anchor.',
        'Never use it as the source of truth for garment construction, trims, decorative details, or color nuances.',
        'Generate a fresh new image, not a copy.',
        'Keep the same garment intent, exact colorway, pose intent, model identity, and overall shot type unless the correction instructions explicitly require a visible change.',
        'Re-lock every garment detail to the original product references before rendering the new image.',
      ].join(' ');

      let regenerated: GeneratedResult;

      if (result.kind === 'front') {
        regenerated = await requestImage({
          key: result.key,
          kind: result.kind,
          pose: result.pose,
          posePrompt: 'front view, full body, same studio setup, clean catalog photo',
          targetColor: result.color,
          anchorImageUrl: result.url,
          anchorInstruction: `${baseAnchorInstruction} Keep this as a front catalog image.`,
          additionalCorrectionPrompt: correctionPrompt,
        });
      } else if (result.kind === 'gallery') {
        const poseConfig =
          galleryPoses.find((pose) => pose.label.toLowerCase() === result.pose.toLowerCase()) ||
          galleryPoses.find((pose) => result.pose.toLowerCase().includes(pose.key));

        regenerated = await requestImage({
          key: result.key,
          kind: result.kind,
          pose: result.pose,
          posePrompt: poseConfig?.prompt || 'full body commercial fashion photo',
          targetColor: result.color,
          anchorImageUrl: result.url,
          anchorInstruction: `${baseAnchorInstruction} Keep this as the same ${result.pose.toLowerCase()} shot.`,
          additionalCorrectionPrompt: correctionPrompt,
        });
      } else if (result.kind === 'extra') {
        const matchingScenario = realLifeSettings.find((scenario) => scenario.label === result.pose);

        regenerated = await requestImage({
          key: result.key,
          kind: result.kind,
          pose: result.pose,
          posePrompt: 'full body lifestyle fashion photo, premium editorial storytelling, natural elegant pose coherent with the requested scenario',
          targetColor: result.color,
          anchorImageUrl: result.url,
          anchorInstruction: `${baseAnchorInstruction} Keep this as the same lifestyle scenario image.`,
          scenarioOverrideLabel: result.pose,
          scenarioOverrideReferenceUrl: matchingScenario
            ? shootingReferenceImages[matchingScenario.id]
            : undefined,
          additionalCorrectionPrompt: correctionPrompt,
        });
      } else if (result.kind === 'alternate') {
        const alternatePosePrompt = result.pose.toLowerCase().includes('action')
          ? 'natural action pose, realistic movement, commercial fashion photo'
          : 'front view, full body, same studio setup, clean catalog photo';
        const alternateGenderOverride = result.pose.toLowerCase().includes('femmina')
          ? 'Femmina'
          : result.pose.toLowerCase().includes('maschio')
            ? 'Maschio'
            : undefined;

        regenerated = await requestImage({
          key: result.key,
          kind: result.kind,
          pose: result.pose,
          posePrompt: alternatePosePrompt,
          targetColor: result.color,
          genderOverride: alternateGenderOverride,
          additionalCorrectionPrompt: correctionPrompt,
        });
      } else {
        return;
      }

      setPendingRegenerationComparison({
        key: result.key,
        previous: result,
        next: regenerated,
      });
      setOpenRegenerationKey(result.key);
    } catch (err: unknown) {
      setGenError(err instanceof Error ? err.message : 'Errore sconosciuto');
    } finally {
      setRegeneratingKey(null);
    }
  };

  const discardPendingRegeneration = (key: string) => {
    if (pendingRegenerationComparison?.key !== key) return;

    setPendingRegenerationComparison(null);
    setOpenRegenerationKey(null);
    setRegenerationDrafts((prev) => ({ ...prev, [key]: '' }));
  };

  const applyPendingRegeneration = (key: string) => {
    if (pendingRegenerationComparison?.key !== key) return;

    const nextResult = pendingRegenerationComparison.next;

    setGeneratedResults((prev) =>
      prev.map((item) => (item.key === key ? nextResult : item))
    );
    setPendingRegenerationComparison(null);
    setOpenRegenerationKey(null);
    setRegenerationDrafts((prev) => ({ ...prev, [key]: '' }));
  };

  const renderGeneratedResultCard = (result: GeneratedResult) => {
    const isRegenerationOpen = openRegenerationKey === result.key;
    const isCurrentRegeneration = regeneratingKey === result.key;
    const pendingComparison =
      pendingRegenerationComparison?.key === result.key
        ? pendingRegenerationComparison
        : null;

    return (
      <div key={result.key} className="rounded-2xl border border-[#D7D9DD] p-4">
        <div className="relative mb-3 aspect-[3/4] overflow-hidden rounded-xl bg-slate-100">
          <button
            type="button"
            onClick={() => setLightboxResult(result)}
            className="absolute inset-0 z-[1]"
            aria-label={`Apri ${result.pose} ${result.color} in grande`}
          />
          <Image src={result.url} alt={`${result.pose} ${result.color}`} fill className="object-cover" unoptimized />
          <div className="absolute bottom-2 left-2 z-10 flex gap-2">
            <button
              onClick={() => downloadResult(result)}
              className="rounded-full bg-white/90 p-2 text-[#103D66] shadow"
              aria-label={`Scarica ${result.pose} ${result.color}`}
            >
              <Download size={16} />
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-bold">{result.pose}</span>
          <span className="rounded-full bg-[#EEF1F4] px-2 py-1 text-[10px] font-black uppercase text-[#103D66]">
            {result.color}
          </span>
        </div>
        <div className="mt-3">
          <button
            type="button"
            onClick={() =>
              setOpenRegenerationKey((prev) => (prev === result.key ? null : result.key))
            }
            className="w-full rounded-xl border border-[#D7D9DD] bg-white px-3 py-2 text-xs font-black uppercase text-[#103D66]"
          >
            Rigenera
          </button>
        </div>
        {isRegenerationOpen && (
          <div className="mt-3 rounded-xl border border-[#D7D9DD] bg-[#F8FAFB] p-3">
            {pendingComparison ? (
              <>
                <div className="mb-2 text-[10px] font-black uppercase tracking-wide text-[#4C6583]">
                  Confronta prima e dopo
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="mb-1 text-[10px] font-black uppercase tracking-wide text-[#4C6583]">
                      Prima
                    </div>
                    <div className="relative aspect-[3/4] overflow-hidden rounded-xl border border-[#D7D9DD] bg-slate-100">
                      <Image
                        src={pendingComparison.previous.url}
                        alt={`Prima ${pendingComparison.previous.pose} ${pendingComparison.previous.color}`}
                        fill
                        className="object-cover"
                        unoptimized
                      />
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 text-[10px] font-black uppercase tracking-wide text-[#4C6583]">
                      Dopo
                    </div>
                    <div className="relative aspect-[3/4] overflow-hidden rounded-xl border border-[#6DA34D] bg-slate-100">
                      <Image
                        src={pendingComparison.next.url}
                        alt={`Dopo ${pendingComparison.next.pose} ${pendingComparison.next.color}`}
                        fill
                        className="object-cover"
                        unoptimized
                      />
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => discardPendingRegeneration(result.key)}
                    className="flex-1 rounded-xl border border-[#D7D9DD] bg-white px-3 py-2 text-xs font-black uppercase text-[#103D66]"
                  >
                    Mantieni originale
                  </button>
                  <button
                    type="button"
                    onClick={() => applyPendingRegeneration(result.key)}
                    className="flex-1 rounded-xl bg-[#103D66] px-3 py-2 text-xs font-black uppercase text-white"
                  >
                    Usa nuova
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="mb-2 text-[10px] font-black uppercase tracking-wide text-[#4C6583]">
                  Correzioni aggiuntive
                </div>
                <textarea
                  value={regenerationDrafts[result.key] || ''}
                  onChange={(event) =>
                    setRegenerationDrafts((prev) => ({
                      ...prev,
                      [result.key]: event.target.value,
                    }))
                  }
                  rows={3}
                  placeholder="Scrivi qui le correzioni da applicare a questa immagine"
                  className="w-full rounded-xl border border-[#D7D9DD] bg-white px-3 py-2 text-sm font-bold outline-none"
                />
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setOpenRegenerationKey(null)}
                    disabled={isCurrentRegeneration}
                    className="flex-1 rounded-xl border border-[#D7D9DD] bg-white px-3 py-2 text-xs font-black uppercase text-[#103D66] disabled:bg-slate-100"
                  >
                    Annulla
                  </button>
                  <button
                    type="button"
                    onClick={() => regenerateGeneratedResult(result)}
                    disabled={isCurrentRegeneration}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#103D66] px-3 py-2 text-xs font-black uppercase text-white disabled:bg-slate-300"
                  >
                    {isCurrentRegeneration ? <Loader2 size={14} className="animate-spin" /> : null}
                    {isCurrentRegeneration ? 'Rigenerazione...' : 'Conferma rigenera'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#F4F4F5] text-[#103D66]">
      <nav className="sticky top-0 z-40 flex items-center justify-between border-b border-[#D7D9DD] bg-white px-6 py-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="relative h-10 w-10 overflow-hidden rounded-lg ring-1 ring-[#D7D9DD]">
            <Image src="/futuria-mark.jpeg" alt="Futuria" fill sizes="40px" className="object-cover" unoptimized />
          </div>
          <div>
            <h1 className="text-lg font-bold">Futuria AI Photo Studio <span className="ml-2 rounded-full bg-[#E6F0E0] px-1.5 py-0.5 text-[10px] uppercase text-[#6DA34D]">Pro</span></h1>
            <p className="text-xs text-[#4C6583]">Marketing content engine</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="rounded-xl border border-[#D7D9DD] bg-white px-3 py-2 text-sm font-bold">
            {projectName}
          </div>
          <Link
            href="/settings"
            className="rounded-xl border border-[#D7D9DD] bg-white p-2 text-[#103D66] transition-colors hover:bg-[#EEF1F4]"
            aria-label="Impostazioni"
          >
            <Settings size={18} />
          </Link>
          <button onClick={() => void loadProducts(true)} className="flex items-center gap-2 rounded-xl bg-[#EEF1F4] px-4 py-2 text-sm font-bold">
            <RefreshCw size={16} className={isLoadingProducts ? 'animate-spin' : ''} /> Aggiorna
          </button>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-6 pt-6">
        <div className="flex rounded-2xl border border-[#D7D9DD] bg-white px-2 shadow-sm">
          <button
            type="button"
            onClick={() => {
              setActiveTab('products');
              scrollToSection('products-top', 40);
            }}
            className={`border-b-2 px-6 py-4 text-xs font-black uppercase ${
              activeTab === 'products' ? 'border-[#6DA34D] text-[#103D66]' : 'border-transparent text-slate-400'
            }`}
          >
            Selezione prodotti
          </button>
          <button
            type="button"
            onClick={() => {
              if (selectedProduct) {
                setActiveTab('setup');
                scrollToSection('workflow-top', 40);
              }
            }}
            disabled={!selectedProduct}
            className={`border-b-2 px-6 py-4 text-xs font-black uppercase ${
              activeTab === 'setup' ? 'border-[#6DA34D] text-[#103D66]' : 'border-transparent text-slate-400'
            } disabled:cursor-not-allowed disabled:text-slate-300`}
          >
            Step 1-3
          </button>
          <button
            type="button"
            onClick={() => {
              if (previewResult) {
                setActiveTab('gallery');
                scrollToSection('step-4-hero', 40);
              }
            }}
            disabled={!previewResult}
            className={`border-b-2 px-6 py-4 text-xs font-black uppercase ${
              activeTab === 'gallery' ? 'border-[#6DA34D] text-[#103D66]' : 'border-transparent text-slate-400'
            } disabled:cursor-not-allowed disabled:text-slate-300`}
          >
            Step 4-7
          </button>
        </div>
      </div>

      <main className="mx-auto max-w-7xl p-6">
        {activeTab === 'products' && (
        <section id="products-top">
          <div className="rounded-2xl border border-[#D7D9DD] bg-white p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">Prodotti</h2>
                <p className="text-xs text-[#4C6583]">Filtra per stato, categoria e SKU</p>
              </div>
              <div className="rounded-full bg-[#EEF1F4] px-3 py-1 text-[10px] font-black uppercase text-[#103D66]">
                {visibleProducts.length}/{products.length}
              </div>
            </div>
            {error && <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{error}</div>}
            {!isLoadingProducts && (
              <div className="mb-4">
                <input
                  value={productSearch}
                  onChange={(event) => setProductSearch(event.target.value)}
                  placeholder="Cerca per nome o SKU"
                  className="w-full rounded-xl border border-[#D7D9DD] bg-white px-3 py-3 text-sm font-bold outline-none"
                />
              </div>
            )}
            {!isLoadingProducts && (
              <div className="mb-4 space-y-3">
                <div className="flex flex-wrap gap-3">
                  {orderedCategoryGroups
                    .filter((group) =>
                      group.parent.name.toLowerCase().includes('abbigliamento')
                    )
                    .map((group) => (
                      <div key={group.parent.id} className="w-full rounded-2xl border border-[#E4E7EB] bg-[#F8FAFB] p-3">
                        <div className="mb-2 text-[10px] font-black uppercase tracking-wide text-[#4C6583]">
                          {group.parent.name}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => setCategoryFilter(String(group.parent.id))}
                            className={`rounded-full px-3 py-2 text-[10px] font-black uppercase transition-all ${
                              categoryFilter === String(group.parent.id)
                                ? 'bg-[#103D66] text-white'
                                : 'border border-[#D7D9DD] bg-white text-[#103D66]'
                            }`}
                          >
                            {group.parent.name}
                          </button>
                          {group.children.map((category) => (
                            <button
                              key={category.id}
                              type="button"
                              onClick={() => setCategoryFilter(String(category.id))}
                              className={`rounded-full px-3 py-2 text-[10px] font-black uppercase transition-all ${
                                categoryFilter === String(category.id)
                                  ? 'bg-[#6DA34D] text-white'
                                  : 'border border-[#D7D9DD] bg-white text-[#103D66]'
                              }`}
                            >
                              {category.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                </div>
                <div className="flex flex-wrap gap-3">
                  <div className="w-full rounded-2xl border border-[#E4E7EB] bg-[#F8FAFB] p-3 md:flex-1 md:basis-[calc(33.333%-0.5rem)]">
                    <div className="mb-2 text-[10px] font-black uppercase tracking-wide text-[#4C6583]">
                      Stato lavorazione
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setProgressFilter('all')}
                        className={`rounded-full px-3 py-2 text-[10px] font-black uppercase transition-all ${
                          progressFilter === 'all'
                            ? 'bg-[#103D66] text-white'
                            : 'border border-[#D7D9DD] bg-white text-[#103D66]'
                        }`}
                      >
                        Tutti
                      </button>
                      <button
                        type="button"
                        onClick={() => setProgressFilter('todo')}
                        className={`rounded-full px-3 py-2 text-[10px] font-black uppercase transition-all ${
                          progressFilter === 'todo'
                            ? 'bg-[#103D66] text-white'
                            : 'border border-[#D7D9DD] bg-white text-[#103D66]'
                        }`}
                      >
                        Da iniziare
                      </button>
                      <button
                        type="button"
                        onClick={() => setProgressFilter('in-progress')}
                        className={`rounded-full px-3 py-2 text-[10px] font-black uppercase transition-all ${
                          progressFilter === 'in-progress'
                            ? 'bg-[#103D66] text-white'
                            : 'border border-[#D7D9DD] bg-white text-[#103D66]'
                        }`}
                      >
                        In corso
                      </button>
                      <button
                        type="button"
                        onClick={() => setProgressFilter('completed')}
                        className={`rounded-full px-3 py-2 text-[10px] font-black uppercase transition-all ${
                          progressFilter === 'completed'
                            ? 'bg-[#6DA34D] text-white'
                            : 'border border-[#D7D9DD] bg-white text-[#103D66]'
                        }`}
                      >
                        Completati
                      </button>
                    </div>
                  </div>
                  {orderedCategoryGroups
                    .filter(
                      (group) => !group.parent.name.toLowerCase().includes('abbigliamento')
                    )
                    .map((group) => (
                      <div
                        key={group.parent.id}
                        className="w-full rounded-2xl border border-[#E4E7EB] bg-[#F8FAFB] p-3 md:flex-1 md:basis-[calc(33.333%-0.5rem)]"
                      >
                        <div className="mb-2 text-[10px] font-black uppercase tracking-wide text-[#4C6583]">
                          {group.parent.name}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => setCategoryFilter(String(group.parent.id))}
                            className={`rounded-full px-3 py-2 text-[10px] font-black uppercase transition-all ${
                              categoryFilter === String(group.parent.id)
                                ? 'bg-[#103D66] text-white'
                                : 'border border-[#D7D9DD] bg-white text-[#103D66]'
                            }`}
                          >
                            {group.parent.name}
                          </button>
                          {group.children.map((category) => (
                            <button
                              key={category.id}
                              type="button"
                              onClick={() => setCategoryFilter(String(category.id))}
                              className={`rounded-full px-3 py-2 text-[10px] font-black uppercase transition-all ${
                                categoryFilter === String(category.id)
                                  ? 'bg-[#6DA34D] text-white'
                                  : 'border border-[#D7D9DD] bg-white text-[#103D66]'
                              }`}
                            >
                              {category.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}
            <div className="max-h-[70vh] overflow-y-auto pr-2">
              {isLoadingProducts ? <div className="flex justify-center py-8"><Loader2 className="animate-spin" /></div> : visibleProducts.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-400">
                  Nessun prodotto corrisponde ai filtri selezionati.
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {visibleProducts.map((product) => {
                    const productStatus = getProductStatus(product.id);

                    return (
                    <div key={product.id} onClick={() => selectProduct(product)} data-clickable="true" className={`flex w-full gap-4 rounded-xl border-2 p-3 text-left ${selectedProduct?.id === product.id ? 'border-[#6DA34D] bg-[#F1F7EC]' : 'border-slate-100 bg-[#FAFAFA]'}`}>
                      <div className="relative h-20 w-16 overflow-hidden rounded-lg border border-[#D7D9DD]"><Image src={product.image} alt={product.name} fill sizes="64px" className="object-cover" unoptimized /></div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="truncate text-sm font-bold">{product.name}</div>
                          <div
                            className="flex shrink-0 items-start gap-2"
                            onClick={(event) => event.stopPropagation()}
                          >
                            {productStatus === 'todo' && (
                              <span
                                className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#F1F3F5] text-slate-400"
                                aria-label="Da iniziare"
                                title="Da iniziare"
                              >
                                <CircleDashed size={14} />
                              </span>
                            )}
                            {productStatus === 'in-progress' && (
                              <span
                                className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#FFF4E8] text-[#E08A1E]"
                                aria-label="Lavorazione iniziata"
                                title="Lavorazione iniziata"
                              >
                                <CircleDashed size={14} />
                              </span>
                            )}
                            {productStatus === 'completed' && (
                              <span
                                className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#E6F0E0] text-[#6DA34D]"
                                aria-label="Sincronizzazione completata"
                                title="Sincronizzazione completata"
                              >
                                <CheckCircle2 size={16} />
                              </span>
                            )}
                            <div className="relative">
                              <button
                                type="button"
                                onClick={() =>
                                  setOpenStatusMenuProductId((prev) =>
                                    prev === product.id ? null : product.id
                                  )
                                }
                                className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[#D7D9DD] bg-white text-[#103D66]"
                                aria-label={`Apri stato ${product.name}`}
                              >
                                <ChevronDown size={14} />
                              </button>
                              {openStatusMenuProductId === product.id && (
                                <div className="absolute right-0 top-9 z-20 flex gap-1 rounded-xl border border-[#D7D9DD] bg-white p-1 shadow-lg">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setProductManualStatus(product.id, 'todo');
                                      setOpenStatusMenuProductId(null);
                                    }}
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-50"
                                    aria-label="Da iniziare"
                                    title="Da iniziare"
                                  >
                                    <CircleDashed size={14} />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setProductManualStatus(product.id, 'in-progress');
                                      setOpenStatusMenuProductId(null);
                                    }}
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[#E08A1E] hover:bg-[#FFF4E8]"
                                    aria-label="In corso"
                                    title="In corso"
                                  >
                                    <CircleDashed size={14} />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setProductManualStatus(product.id, 'completed');
                                      setOpenStatusMenuProductId(null);
                                    }}
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[#6DA34D] hover:bg-[#E6F0E0]"
                                    aria-label="Completato"
                                    title="Completato"
                                  >
                                    <CheckCircle2 size={16} />
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="text-[10px] uppercase text-slate-400">SKU: {product.sku || product.id}</div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {product.categories.slice(0, 3).map((category) => (
                            <span
                              key={`${product.id}-${category.id}`}
                              className="rounded-full bg-white px-2 py-1 text-[9px] font-black uppercase text-[#4C6583]"
                            >
                              {getCategoryName(category)}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  )})}
                </div>
              )}
            </div>
          </div>
        </section>
        )}

        {activeTab !== 'products' && (
        <section id="workflow-top">
          {genError && <div className="mb-6 flex gap-3 rounded-xl border border-red-200 bg-red-50 p-4"><XCircle className="mt-1 text-red-500" size={20} /><div><div className="font-bold text-red-800">Errore Generazione</div><div className="text-sm text-red-700">{genError}</div></div></div>}
          {selectedProduct && (
            <div className="rounded-2xl border border-[#D7D9DD] bg-white px-6 py-4">
              <div className="flex items-center gap-4">
                <div className="relative h-16 w-12 overflow-hidden rounded-lg border border-[#D7D9DD] bg-slate-50">
                  <Image src={selectedProduct.image} alt={selectedProduct.name} fill sizes="48px" className="object-cover" unoptimized />
                </div>
                <div>
                  <div className="text-[10px] font-black uppercase tracking-wide text-[#4C6583]">Prodotto selezionato</div>
                  <div className="mt-1 text-xl font-black text-[#103D66]">{selectedProduct.name}</div>
                </div>
              </div>
            </div>
          )}

          {!selectedProduct || !job ? (
            <div className="flex h-96 flex-col items-center justify-center rounded-2xl border border-[#D7D9DD] bg-white text-slate-400"><Camera size={48} className="mb-4 opacity-10" /><p>Seleziona un prodotto dalla tab prodotti per iniziare</p></div>
          ) : activeTab === 'setup' ? (
            <div className="space-y-6 pt-6">
              <div className="rounded-2xl border border-[#D7D9DD] bg-white p-6 shadow-sm">
                <div className="mb-4 font-bold">Step 1. Configurazione e colore target</div>
                <p className="mb-4 text-sm text-slate-500">Ordine menu: eta, genere, etnia, scenario, colore target unico. Questo colore verra usato sia per la hero front sia per back, side e in action.</p>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                  <select value={job.modelAge} onChange={(e) => updateJob('modelAge', e.target.value)} className="rounded-xl border-2 border-slate-100 bg-slate-50 p-3 text-sm font-bold">
                    {selectedProduct.sizes.length > 1 && <option value="">Seleziona eta/taglia</option>}
                    {selectedProduct.sizes.map((v) => <option key={v}>{v}</option>)}
                  </select>
                  <div className="flex flex-wrap gap-2 rounded-xl border-2 border-slate-100 bg-slate-50 p-2">
                    {genders.map((gender) => (
                      <button
                        key={gender}
                        type="button"
                        onClick={() => updateJob('gender', gender)}
                        className={`rounded-full px-4 py-2 text-sm font-black transition-all ${
                          job.gender === gender
                            ? 'bg-[#103D66] text-white'
                            : 'bg-white text-[#103D66]'
                        }`}
                      >
                        {gender}
                      </button>
                    ))}
                  </div>
                  <select value={job.ethnicity} onChange={(e) => updateJob('ethnicity', e.target.value)} className="rounded-xl border-2 border-slate-100 bg-slate-50 p-3 text-sm font-bold">
                    {ethnicities.length > 1 && <option value="">Seleziona etnia</option>}
                    {ethnicities.map((v) => <option key={v}>{v}</option>)}
                  </select>
                  <select value={job.scenario} onChange={(e) => updateJob('scenario', e.target.value)} className="rounded-xl border-2 border-slate-100 bg-slate-50 p-3 text-sm font-bold">{studioSettings.map((setting) => <option key={setting.id} value={setting.id}>{setting.label}{setting.hasReferenceImage ? ' (ref)' : ''}</option>)}</select>
                  <select value={selectedColor} onChange={(e) => setSelectedColor(e.target.value)} className="rounded-xl border-2 border-slate-100 bg-slate-50 p-3 text-sm font-bold">
                    {selectedProduct.colors.length > 1 && <option value="">Seleziona colore principale</option>}
                    {selectedProduct.colors.map((v) => <option key={v}>{v}</option>)}
                  </select>
                  <select value={job.fit} onChange={(e) => updateJob('fit', e.target.value)} className="rounded-xl border-2 border-slate-100 bg-slate-50 p-3 text-sm font-bold">
                    <option value="">Seleziona vestibilita (opzionale)</option>
                    {garmentFitOptions.map((option) => <option key={option}>{option}</option>)}
                  </select>
                  {supportsLengthSelection(selectedProduct) && (
                    <select value={job.length} onChange={(e) => updateJob('length', e.target.value)} className="rounded-xl border-2 border-slate-100 bg-slate-50 p-3 text-sm font-bold">
                      <option value="">Seleziona lunghezza</option>
                      {garmentLengthOptions.map((option) => <option key={option}>{option}</option>)}
                    </select>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-[#D7D9DD] bg-white p-6 shadow-sm">
                <div className="mb-4 font-bold">Step 2. Outfit coordinato dello stesso brand</div>
                <p className="mb-4 text-sm text-slate-500">
                  Puoi selezionare fino a 2 capi coordinati del catalogo. Per ogni capo il ruolo e obbligatorio: viene precompilato dalla categoria abbigliamento del prodotto, ma puoi cambiarlo.
                </p>
                {selectedCompanionEntries.length === 0 && !isCompanionPickerOpen && (
                  <div className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-[#D7D9DD] bg-[#F8FAFB] p-3">
                    <div>
                      <div className="text-sm font-bold">Nessuno</div>
                      <div className="text-[10px] uppercase text-slate-400">Nessun capo coordinato selezionato</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => openCompanionPicker(1)}
                      className="rounded-xl border border-[#D7D9DD] bg-white px-3 py-2 text-xs font-black uppercase text-[#103D66]"
                    >
                      Seleziona altro capo
                    </button>
                  </div>
                )}
                {selectedCompanionEntries.map((entry) => (
                  <div key={`companion-slot-${entry.slot}-${entry.product.id}`} className="mb-4 rounded-2xl border border-[#D7D9DD] bg-[#F8FAFB] p-3">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="relative h-16 w-12 overflow-hidden rounded-lg border border-[#D7D9DD] bg-white">
                          <Image src={entry.imageUrl} alt={entry.product.name} fill sizes="48px" className="object-cover" unoptimized />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-bold">{entry.product.name}</div>
                          <div className="text-[10px] uppercase text-slate-400">Capo coordinato {entry.slot}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => openCompanionPicker(entry.slot)}
                          className="rounded-xl border border-[#D7D9DD] bg-white px-3 py-2 text-xs font-black uppercase text-[#103D66]"
                        >
                          Cambia
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (entry.slot === 1) {
                              setCompanionProductId(null);
                              setCompanionRole('');
                              setCompanionImageUrl('');
                              setCompanionFit('');
                              setCompanionLength('');
                            } else {
                              setSecondaryCompanionProductId(null);
                              setSecondaryCompanionRole('');
                              setSecondaryCompanionImageUrl('');
                              setSecondaryCompanionFit('');
                              setSecondaryCompanionLength('');
                            }
                            setCompanionProductSearch('');
                            setIsCompanionPickerOpen(false);
                          }}
                          className="rounded-xl border border-[#D7D9DD] bg-white px-3 py-2 text-xs font-black uppercase text-[#103D66]"
                        >
                          Nessuno
                        </button>
                      </div>
                    </div>
                    <div className="mb-3">
                      <div className="mb-2 text-[10px] font-black uppercase tracking-wide text-[#4C6583]">Ruolo del capo coordinato</div>
                      <div className="flex flex-wrap gap-2">
                        {companionRoleOptions.map((roleOption) => (
                          <button
                            key={`${entry.slot}-${roleOption}`}
                            type="button"
                            onClick={() => {
                              if (entry.slot === 1) {
                                setCompanionRole(roleOption);
                              } else {
                                setSecondaryCompanionRole(roleOption);
                              }
                            }}
                            className={`rounded-full px-3 py-2 text-[10px] font-black uppercase transition-all ${
                              entry.role === roleOption
                                ? 'bg-[#103D66] text-white'
                                : 'border border-[#D7D9DD] bg-white text-[#103D66]'
                            }`}
                          >
                            {roleOption}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div>
                        <div className="mb-2 text-[10px] font-black uppercase tracking-wide text-[#4C6583]">Vestibilita del capo coordinato</div>
                        <select
                          value={entry.fit}
                          onChange={(e) => {
                            if (entry.slot === 1) {
                              setCompanionFit(e.target.value);
                            } else {
                              setSecondaryCompanionFit(e.target.value);
                            }
                          }}
                          className="w-full rounded-xl border-2 border-slate-100 bg-white p-3 text-sm font-bold"
                        >
                          <option value="">Seleziona vestibilita (opzionale)</option>
                          {garmentFitOptions.map((option) => <option key={`${entry.slot}-${option}`}>{option}</option>)}
                        </select>
                      </div>
                      {supportsLengthSelection(entry.product) ? (
                        <div>
                          <div className="mb-2 text-[10px] font-black uppercase tracking-wide text-[#4C6583]">Lunghezza del capo coordinato</div>
                          <select
                            value={entry.length || getDefaultLengthForProduct(entry.product)}
                            onChange={(e) => {
                              if (entry.slot === 1) {
                                setCompanionLength(e.target.value);
                              } else {
                                setSecondaryCompanionLength(e.target.value);
                              }
                            }}
                            className="w-full rounded-xl border-2 border-slate-100 bg-white p-3 text-sm font-bold"
                          >
                            <option value="">Seleziona lunghezza</option>
                            {garmentLengthOptions.map((option) => <option key={`${entry.slot}-length-${option}`}>{option}</option>)}
                          </select>
                        </div>
                      ) : (
                        <div className="rounded-xl border border-dashed border-slate-200 bg-white px-3 py-3 text-xs text-slate-400">
                          Lunghezza non necessaria per questo capo.
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="mb-2 text-[10px] font-black uppercase tracking-wide text-[#4C6583]">Immagine reference del capo coordinato</div>
                      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
                        {entry.product.images.map((imageUrl, index) => (
                          <button
                            key={`${entry.product.id}-reference-${index}`}
                            type="button"
                            onClick={() => {
                              if (entry.slot === 1) {
                                setCompanionImageUrl(imageUrl);
                              } else {
                                setSecondaryCompanionImageUrl(imageUrl);
                              }
                            }}
                            className={`rounded-2xl border-2 p-2 text-left ${
                              entry.imageUrl === imageUrl
                                ? 'border-[#6DA34D] bg-[#F1F7EC]'
                                : 'border-[#D7D9DD] bg-white'
                            }`}
                          >
                            <div className="relative aspect-[3/4] overflow-hidden rounded-xl bg-slate-50">
                              <Image src={imageUrl} alt={`${entry.product.name} reference ${index + 1}`} fill sizes="96px" className="object-cover" unoptimized />
                            </div>
                            <div className="mt-2 text-[10px] font-black uppercase text-slate-400">Ref {index + 1}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
                {selectedCompanionEntries.length > 0 && canAddAnotherCompanion && !isCompanionPickerOpen && (
                  <div className="mb-4 flex justify-end">
                    <button
                      type="button"
                      onClick={() => openCompanionPicker(companionProduct ? 2 : 1)}
                      className="rounded-xl border border-[#D7D9DD] bg-white px-3 py-2 text-xs font-black uppercase text-[#103D66]"
                    >
                      Aggiungi altro capo
                    </button>
                  </div>
                )}
                {isCompanionPickerOpen && (
                  <div id="companion-picker">
                    <div className="mb-3 rounded-2xl border border-[#D7D9DD] bg-[#F8FAFB] px-4 py-3">
                      <div className="text-[10px] font-black uppercase tracking-wide text-[#4C6583]">
                        {selectedCompanionEntries.some((entry) => entry.slot === companionPickerTarget)
                          ? `Stai cambiando il capo coordinato ${companionPickerTarget}/2`
                          : `Stai selezionando il capo coordinato ${companionPickerTarget}/2`}
                      </div>
                    </div>
                    <div className="mb-4">
                      <input
                        ref={companionSearchInputRef}
                        value={companionProductSearch}
                        onChange={(event) => setCompanionProductSearch(event.target.value)}
                        placeholder="Cerca un capo coordinato per nome o SKU"
                        className="w-full rounded-xl border border-[#D7D9DD] bg-white px-3 py-3 text-sm font-bold outline-none"
                      />
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {companionProductOptions.map((product) => (
                        <button
                          key={product.id}
                          type="button"
                          onClick={() => {
                            if (companionPickerTarget === 1) {
                              setCompanionProductId(product.id);
                              setCompanionRole(getDefaultCompanionRoleForProduct(product));
                              setCompanionImageUrl(product.image || product.images[0] || '');
                              setCompanionFit('');
                              setCompanionLength(getDefaultLengthForProduct(product));
                            } else {
                              setSecondaryCompanionProductId(product.id);
                              setSecondaryCompanionRole(getDefaultCompanionRoleForProduct(product));
                              setSecondaryCompanionImageUrl(product.image || product.images[0] || '');
                              setSecondaryCompanionFit('');
                              setSecondaryCompanionLength(getDefaultLengthForProduct(product));
                            }
                            setCompanionProductSearch('');
                            setIsCompanionPickerOpen(false);
                          }}
                          className={`flex items-center gap-3 rounded-2xl border p-3 text-left ${
                            companionProductId === product.id || secondaryCompanionProductId === product.id
                              ? 'border-[#6DA34D] bg-[#F1F7EC]'
                              : 'border-[#D7D9DD] bg-white'
                          }`}
                        >
                          <div className="relative h-16 w-12 overflow-hidden rounded-lg border border-[#D7D9DD] bg-slate-50">
                            <Image src={product.image} alt={product.name} fill sizes="48px" className="object-cover" unoptimized />
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-bold">{product.name}</div>
                            <div className="text-[10px] uppercase text-slate-400">SKU: {product.sku || product.id}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                    {companionProductOptions.length === 0 && (
                      <div className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">
                        {normalizedCompanionSearch.length === 0
                          ? 'Scrivi nella ricerca per vedere i prodotti compatibili.'
                          : 'Nessun prodotto trovato per questo filtro.'}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div id="step-3-references" className="rounded-2xl border border-[#D7D9DD] bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="font-bold">Step 3. Seleziona reference di tutti i colori</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={manualSourceInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleManualSourceUpload}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => manualSourceInputRef.current?.click()}
                      className="flex items-center gap-2 rounded-xl border border-[#D7D9DD] bg-white px-3 py-2 text-xs font-black uppercase text-[#103D66]"
                    >
                      <Upload size={14} /> Carica foto
                    </button>
                    {selectedProduct.backendUrl && (
                      <button
                        type="button"
                        onClick={() => window.open(selectedProduct.backendUrl, '_blank', 'noopener,noreferrer')}
                        className="flex items-center gap-2 rounded-xl border border-[#D7D9DD] bg-white px-3 py-2 text-xs font-black uppercase text-[#103D66]"
                      >
                        <ExternalLink size={14} /> Backend
                      </button>
                    )}
                    {selectedProduct.frontendUrl && (
                      <button
                        type="button"
                        onClick={() => window.open(selectedProduct.frontendUrl, '_blank', 'noopener,noreferrer')}
                        className="flex items-center gap-2 rounded-xl border border-[#D7D9DD] bg-white px-3 py-2 text-xs font-black uppercase text-[#103D66]"
                      >
                        <ExternalLink size={14} /> Frontend
                      </button>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                  {availableSourceImages.map((img, index) => {
                    const selected = getSource(img);
                    const isManualImage = manualSourceImages.includes(img);
                    const colorPending = Boolean(selected && colorRequiresSelection && !selected.color);
                    const referenceCompletedSteps = selected
                      ? [selected.view ? 1 : 0, 1, colorRequiresSelection ? (selected.color ? 1 : 0) : 1].reduce(
                          (total, value) => total + value,
                          0
                        )
                      : 0;
                    const referenceTotalSteps = colorRequiresSelection ? 3 : 2;
                    return (
                      <div
                        key={`${img}-${index}`}
                        onClick={() => toggleSource(img)}
                        data-clickable="true"
                        className={`rounded-2xl border-2 p-2 ${
                          selected
                            ? colorPending
                              ? 'border-amber-300 bg-amber-50/60'
                              : 'border-[#6DA34D] bg-[#F1F7EC]'
                            : 'border-slate-100 bg-slate-50'
                        }`}
                      >
                        <div className="relative aspect-[3/4] overflow-hidden rounded-xl">
                          <Image src={img} alt={`Source ${index + 1}`} fill className="object-cover" unoptimized />
                          {selected && <div className="absolute right-2 top-2 rounded-full bg-[#103D66] p-1 text-white"><Check size={12} strokeWidth={4} /></div>}
                        </div>
                        <div className="mt-3 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-[10px] font-black uppercase text-slate-400">Reference {index + 1}</div>
                            <div className="flex items-center gap-1">
                              {selected && (
                                <span
                                  className={`rounded-full px-2 py-1 text-[9px] font-black uppercase ${
                                    colorPending
                                      ? 'bg-amber-100 text-amber-700'
                                      : 'bg-[#E6F0E0] text-[#6DA34D]'
                                  }`}
                                >
                                  {referenceCompletedSteps}/{referenceTotalSteps}
                                </span>
                              )}
                              {isManualImage && (
                                <span className="rounded-full bg-[#EEF1F4] px-2 py-1 text-[9px] font-black uppercase text-[#103D66]">
                                  Manuale
                                </span>
                              )}
                            </div>
                          </div>
                          {selected ? (
                            <>
                              <div
                                onClick={(e) => e.stopPropagation()}
                                className="rounded-xl border border-[#D7D9DD] bg-white p-2"
                              >
                                <div className="mb-2 flex items-center justify-between gap-2">
                                  <div className="text-[10px] font-black uppercase tracking-wide text-[#4C6583]">Vista</div>
                                  <span className="rounded-full bg-[#EEF1F4] px-2 py-1 text-[9px] font-black uppercase text-[#103D66]">
                                    {sourceViewLabels[selected.view]}
                                  </span>
                                </div>
                                <div className="grid grid-cols-3 gap-2">
                                  {sourceViewOptions.map((view) => (
                                    <button
                                      key={view}
                                      type="button"
                                      onClick={() => updateSource(img, { view })}
                                      className={`rounded-xl px-2 py-2 text-xs font-black uppercase transition-all ${
                                        selected.view === view
                                          ? 'bg-[#103D66] text-white'
                                          : 'border border-[#D7D9DD] bg-white text-[#103D66]'
                                      }`}
                                    >
                                      {sourceViewLabels[view]}
                                    </button>
                                  ))}
                                </div>
                              </div>
                              <div
                                onClick={(e) => e.stopPropagation()}
                                className="rounded-xl border border-[#D7D9DD] bg-white px-3 py-2"
                              >
                                <div className="mb-2 text-[10px] font-black uppercase tracking-wide text-[#4C6583]">Soggetto</div>
                                <label className="flex items-center gap-2 text-[10px] font-black uppercase text-[#103D66]">
                                  <input
                                    type="checkbox"
                                    checked={selected.mode === 'worn'}
                                    onChange={(event) =>
                                      updateSource(img, {
                                        mode: event.target.checked ? 'worn' : 'garment-only',
                                      })
                                    }
                                    className="h-4 w-4 rounded border-[#C9DABF] accent-[#103D66]"
                                  />
                                  Con modello/a
                                </label>
                              </div>
                              <div
                                onClick={(e) => e.stopPropagation()}
                                className={`rounded-xl border bg-white p-2 ${
                                  colorPending ? 'border-amber-300' : 'border-[#D7D9DD]'
                                }`}
                              >
                                <div className="mb-2 flex items-center justify-between gap-2">
                                  <div className="text-[10px] font-black uppercase tracking-wide text-[#4C6583]">Colore reference</div>
                                  <span
                                    className={`rounded-full px-2 py-1 text-[9px] font-black uppercase ${
                                      colorPending
                                        ? 'bg-amber-100 text-amber-700'
                                        : 'bg-[#E6F0E0] text-[#6DA34D]'
                                    }`}
                                  >
                                    {colorPending ? 'Da scegliere' : selected.color || 'OK'}
                                  </span>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  {selectedProduct.colors.map((color) => (
                                    <button
                                      key={color}
                                      type="button"
                                      onClick={() => updateSource(img, { color })}
                                      className={`rounded-full px-3 py-2 text-[10px] font-black uppercase transition-all ${
                                        selected.color === color
                                          ? 'bg-[#6DA34D] text-white'
                                          : 'border border-[#D7D9DD] bg-white text-[#103D66]'
                                      }`}
                                    >
                                      {color}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </>
                          ) : <div className="rounded-xl border border-dashed border-slate-200 px-3 py-2 text-sm text-slate-400">Tocca per selezionare e compilare vista, soggetto e colore.</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div id="generate-hero-cta" className="rounded-2xl border border-[#D7D9DD] bg-white p-6 shadow-sm">
                <div className="mb-4 font-bold">Genera la hero front del colore scelto</div>
                <button onClick={startGeneration} disabled={isBusy || !isSetupComplete} className={`flex w-full items-center justify-center gap-3 rounded-2xl py-5 text-lg font-black text-white ${isBusy || !isSetupComplete ? 'bg-slate-400' : 'bg-[#103D66]'}`}>
                  {stage === 'hero' ? <><RefreshCw className="animate-spin" size={24} /> Generazione hero...</> : <><Wand2 size={24} /> Genera Hero Front</>}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-6 pt-6">
              <div id="step-4-hero" className="rounded-2xl border border-[#D7D9DD] bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <button
                    onClick={() => setActiveTab('setup')}
                    disabled={isBusy}
                    className="flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-bold text-slate-600"
                  >
                    <ArrowLeft size={16} /> Torna alla configurazione
                  </button>
                  <div className="font-bold">Step 4. Approva la hero front</div>
                </div>
                {!previewResult ? (
                  stage === 'hero' ? (
                    <div className="rounded-2xl border border-[#D7D9DD] p-4 max-w-[352px]">
                      <div className="relative mb-3 aspect-[3/4] max-w-[320px] overflow-hidden rounded-xl bg-slate-100">
                        <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-slate-100 to-slate-200" />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="rounded-full bg-white/90 p-3 text-[#103D66] shadow">
                            <Loader2 size={18} className="animate-spin" />
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold">Front Hero</span>
                        <span className="rounded-full bg-[#E6F0E0] px-2 py-1 text-[10px] font-black uppercase text-[#6DA34D]">
                          {selectedColor || 'Loading'}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-slate-400">Nessuna hero disponibile.</div>
                  )
                ) : (
                  <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
                    <div className="rounded-2xl border border-[#D7D9DD] p-4">
                      <div className="relative mx-auto mb-3 aspect-[3/4] max-w-[320px] overflow-hidden rounded-xl bg-slate-100">
                        <button
                          type="button"
                          onClick={() => setLightboxResult(previewResult)}
                          className="absolute inset-0 z-[1]"
                          aria-label={`Apri ${previewResult.pose} in grande`}
                        />
                        <Image src={previewResult.url} alt={previewResult.pose} fill className="object-cover" unoptimized />
                        <div className="absolute bottom-2 left-2 z-10 flex gap-2">
                          <button
                            onClick={() => downloadResult(previewResult)}
                            className="rounded-full bg-white/90 p-2 text-[#103D66] shadow"
                            aria-label={`Scarica ${previewResult.pose}`}
                          >
                            <Download size={16} />
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center justify-between"><span className="text-xs font-bold">{previewResult.pose}</span><span className="rounded-full bg-[#E6F0E0] px-2 py-1 text-[10px] font-black uppercase text-[#6DA34D]">{previewResult.color}</span></div>
                    </div>
                    <div className="space-y-3">
                      <div className="rounded-2xl border border-[#D7D9DD] bg-[#F8FAFB] p-4">
                        <div className="mb-2 font-bold">Ambientazioni extra opzionali</div>
                        <p className="mb-3 text-sm text-slate-500">
                          Seleziona una o piu ambientazioni aggiuntive. Dopo l&apos;approvazione, l&apos;AI generera immagini extra separate da quelle del set principale.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {realLifeSettings.map((scenario) => (
                            <button
                              key={scenario.id}
                              type="button"
                              onClick={() => toggleAdditionalScenario(scenario.id)}
                              disabled={isBusy}
                              className={`rounded-full px-3 py-2 text-xs font-black transition-all ${
                                selectedAdditionalScenarios.includes(scenario.id)
                                  ? 'bg-[#103D66] text-white'
                                  : 'border border-[#D7D9DD] bg-white text-[#103D66]'
                              } ${isBusy ? 'opacity-60' : ''}`}
                            >
                              {scenario.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <button onClick={approveAndGenerateAll} disabled={isBusy || isPreviewApproved} className={`flex w-full items-center justify-center gap-3 rounded-2xl px-4 py-4 text-sm font-black text-white ${isBusy || isPreviewApproved ? 'bg-slate-400' : 'bg-[#6DA34D]'}`}>
                        {stage === 'production' ? <><RefreshCw className="animate-spin" size={18} /> Produzione...</> : isPreviewApproved ? <><CheckCircle2 size={18} /> Approvata</> : <><CheckCircle2 size={18} /> Approva e genera tutto</>}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div id="step-5-output" className="rounded-2xl border border-[#D7D9DD] bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="font-bold">Step 5. Output finale</div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={downloadAllResults}
                      disabled={generatedResults.length === 0}
                      className="flex items-center gap-2 rounded-xl bg-[#103D66] px-4 py-2 text-sm font-bold text-white disabled:bg-slate-300"
                    >
                      <Download size={16} /> Scarica tutto
                    </button>
                  </div>
                </div>
                {wooSyncMessage && (
                  <div className="mb-4 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">
                    {wooSyncMessage}
                  </div>
                )}
                <div className="space-y-8">
                  <div>
                    <div className="mb-3 flex items-center justify-between"><h4 className="font-bold">Frontali per tutti i colori</h4><span className="text-xs text-slate-400">{frontResults.length}/{selectedProduct.colors.length}</span></div>
                    {frontResults.length === 0 && stage !== 'production' ? <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-slate-400">In attesa di approvazione.</div> : <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">{frontResults.map((r) => renderGeneratedResultCard(r))}{stage === 'production' && selectedProduct && Array.from({ length: Math.max(selectedProduct.colors.length - frontResults.length, 0) }, (_, index) => <LoadingCard key={`front-loading-${index}`} label="Front Loading" />)}</div>}
                  </div>
                  <div>
                    <div className="mb-3 flex items-center justify-between"><h4 className="font-bold">Back / Side / Action</h4><span className="rounded-full bg-[#EEF1F4] px-3 py-1 text-[10px] font-black uppercase">{selectedColor}</span></div>
                    {galleryResults.length === 0 && stage !== 'production' ? <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-slate-400">In attesa di approvazione.</div> : <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">{galleryResults.map((r) => renderGeneratedResultCard(r))}{stage === 'production' && Array.from({ length: Math.max(galleryPoses.length - galleryResults.length, 0) }, (_, index) => <LoadingCard key={`gallery-loading-${index}`} label="Gallery Loading" />)}</div>}
                  </div>
                  {isUnisexProduct && (
                    <div>
                      <div className="mb-3 flex items-center justify-between"><h4 className="font-bold">Varianti altro genere</h4><span className="rounded-full bg-[#EEF1F4] px-3 py-1 text-[10px] font-black uppercase">{alternateGender || 'Altro genere'}</span></div>
                      {alternateGenderResults.length === 0 && stage !== 'production' ? <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-slate-400">Verranno generate automaticamente per i prodotti unisex.</div> : <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">{alternateGenderResults.map((r) => renderGeneratedResultCard(r))}{stage === 'production' && Array.from({ length: Math.max(2 - alternateGenderResults.length, 0) }, (_, index) => <LoadingCard key={`alternate-loading-${index}`} label="Altro Genere" />)}</div>}
                    </div>
                  )}
                  <div>
                    <div className="mb-3 flex items-center justify-between"><h4 className="font-bold">Ambientazioni extra</h4><span className="text-xs text-slate-400">{extraScenarioResults.length}/{selectedAdditionalScenarioSettings.length}</span></div>
                    {extraScenarioResults.length === 0 && selectedAdditionalScenarioSettings.length === 0 && stage !== 'production' ? <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-slate-400">Nessuna ambientazione extra selezionata.</div> : extraScenarioResults.length === 0 && stage !== 'production' ? <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-slate-400">In attesa di approvazione.</div> : <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">{extraScenarioResults.map((r) => renderGeneratedResultCard(r))}{stage === 'production' && Array.from({ length: Math.max(selectedAdditionalScenarioSettings.length - extraScenarioResults.length, 0) }, (_, index) => <LoadingCard key={`extra-loading-${index}`} label="Extra Scenario" />)}</div>}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-[#D7D9DD] bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="font-bold">Step 6. Descrizione prodotto</div>
                  <button
                    type="button"
                    onClick={() => {
                      void generateProductDescription();
                    }}
                    disabled={generatedResults.length === 0 || isGeneratingDescription}
                    className="inline-flex items-center gap-2 rounded-xl border border-[#D7D9DD] bg-white px-4 py-2 text-sm font-black text-[#103D66] disabled:bg-slate-100 disabled:text-slate-400"
                  >
                    {isGeneratingDescription ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                    {generatedDescriptionHtml ? 'Rigenera descrizioni AI' : 'Genera descrizioni AI'}
                  </button>
                </div>
                <p className="mb-4 text-sm text-slate-500">
                  La descrizione lunga e la short description vengono preparate a partire dalla descrizione attuale del catalogo, dalle immagini generate, dalle occasioni d&apos;uso selezionate e dalle categorie del prodotto. Qui sotto le modifichi direttamente in modalita WYSIWYG e verranno esportate su WooCommerce durante la sincronizzazione.
                </p>
                {selectedProduct?.description ? (
                  <div className="mb-4 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
                    Descrizione attuale importata dal catalogo come base di partenza.
                  </div>
                ) : null}
                {descriptionError ? (
                  <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {descriptionError}
                  </div>
                ) : null}
                {generatedResults.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-slate-400">
                    Genera prima le immagini per creare la nuova descrizione.
                  </div>
                ) : (
                  <div className="space-y-6">
                    <div className="rounded-2xl border border-[#D7D9DD] bg-white p-4">
                      <div className="mb-3 text-xs font-black uppercase tracking-wide text-[#4C6583]">
                        Descrizione prodotto (WYSIWYG)
                      </div>
                      <div
                        contentEditable
                        suppressContentEditableWarning
                        onBlur={(event) =>
                          setGeneratedDescriptionHtml(event.currentTarget.innerHTML)
                        }
                        className="min-h-[260px] rounded-2xl border border-[#D7D9DD] bg-[#F8FAFB] px-4 py-3 text-sm leading-7 text-[#103D66] outline-none [&_p]:mb-4 [&_p:last-child]:mb-0 [&_strong]:font-black"
                        dangerouslySetInnerHTML={{
                          __html:
                            generatedDescriptionHtml ||
                            (isGeneratingDescription
                              ? '<p>Sto preparando la descrizione...</p>'
                              : '<p>Genera la descrizione per iniziare.</p>'),
                        }}
                      />
                    </div>
                    <div className="rounded-2xl border border-[#D7D9DD] bg-white p-4">
                      <div className="mb-3 text-xs font-black uppercase tracking-wide text-[#4C6583]">
                        Short description WooCommerce (WYSIWYG)
                      </div>
                      <div
                        contentEditable
                        suppressContentEditableWarning
                        onBlur={(event) =>
                          setGeneratedShortDescriptionHtml(event.currentTarget.innerHTML)
                        }
                        className="min-h-[140px] rounded-2xl border border-[#D7D9DD] bg-[#F8FAFB] px-4 py-3 text-sm leading-7 text-[#103D66] outline-none [&_p]:mb-4 [&_p:last-child]:mb-0 [&_strong]:font-black"
                        dangerouslySetInnerHTML={{
                          __html:
                            generatedShortDescriptionHtml ||
                            (isGeneratingDescription
                              ? '<p>Sto preparando la short description...</p>'
                              : '<p>La short description verra generata insieme alla descrizione principale.</p>'),
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-[#D7D9DD] bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="font-bold">Step 7. Campi ACF prodotto</div>
                  <span className="rounded-full bg-[#EEF1F4] px-3 py-1 text-[10px] font-black uppercase text-[#4C6583]">
                    Tutti facoltativi
                  </span>
                </div>
                <p className="mb-4 text-sm text-slate-500">
                  Qui trovi solo i campi ACF applicabili a questo prodotto. Sono gia valorizzati con i dati attuali presenti in WooCommerce e puoi modificarli liberamente prima della sincronizzazione.
                </p>
                {selectedProduct && selectedProduct.acfFields.length > 0 ? (
                  <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                    {selectedProduct.acfFields.map((field) => (
                      <div
                        key={field.key}
                        className={`rounded-2xl border border-[#D7D9DD] bg-white p-4 ${
                          field.type === 'wysiwyg' ? 'xl:col-span-2' : ''
                        }`}
                      >
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <div className="text-sm font-black text-[#103D66]">{field.label}</div>
                          <span className="text-[10px] font-black uppercase tracking-wide text-slate-400">
                            {field.type}
                          </span>
                        </div>
                        {field.instructions ? (
                          <p className="mb-3 text-xs text-slate-500">{field.instructions}</p>
                        ) : null}
                        {renderAcfFieldControl(field)}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-slate-400">
                    Nessun campo ACF configurato per questo prodotto.
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-[#D7D9DD] bg-white p-4 shadow-sm">
                <div className="mb-2 text-sm font-bold">Cosa vuoi fare con le immagini preesistenti?</div>
                <div className="mb-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setWooSyncMode('replace')}
                    disabled={isSyncingWoo}
                    className={`rounded-full px-4 py-2 text-xs font-black uppercase transition-all ${
                      wooSyncMode === 'replace'
                        ? 'bg-[#103D66] text-white'
                        : 'border border-[#D7D9DD] bg-white text-[#103D66]'
                    } ${isSyncingWoo ? 'opacity-60' : ''}`}
                  >
                    Sostituiscile con queste nuove
                  </button>
                  <button
                    type="button"
                    onClick={() => setWooSyncMode('keep-existing')}
                    disabled={isSyncingWoo}
                    className={`rounded-full px-4 py-2 text-xs font-black uppercase transition-all ${
                      wooSyncMode === 'keep-existing'
                        ? 'bg-[#103D66] text-white'
                        : 'border border-[#D7D9DD] bg-white text-[#103D66]'
                    } ${isSyncingWoo ? 'opacity-60' : ''}`}
                  >
                    Lasciale nella galleria immagini
                  </button>
                </div>
                <p className="mb-4 text-sm text-slate-500">
                  Se scegli la prima opzione, la galleria prodotto viene rimpiazzata dal nuovo set. Se scegli la seconda, il nuovo set viene aggiunto lasciando anche le immagini gia presenti.
                </p>
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  {selectedProduct?.backendUrl && (
                    <a
                      href={selectedProduct.backendUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 rounded-xl border border-[#D7D9DD] bg-white px-3 py-2 text-xs font-black uppercase text-[#103D66]"
                    >
                      <ExternalLink size={14} /> Backend
                    </a>
                  )}
                  {selectedProduct?.frontendUrl && (
                    <a
                      href={selectedProduct.frontendUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 rounded-xl border border-[#D7D9DD] bg-white px-3 py-2 text-xs font-black uppercase text-[#103D66]"
                    >
                      <ExternalLink size={14} /> Frontend
                    </a>
                  )}
                </div>
                <button onClick={syncToWooCommerce} disabled={generatedResults.length === 0 || isSyncingWoo} className="flex w-full items-center justify-center gap-3 rounded-2xl bg-[#6DA34D] py-5 text-lg font-black text-white disabled:bg-slate-300"><Upload size={24} /> {isSyncingWoo ? 'Sincronizzazione in corso...' : 'Sincronizza su WooCommerce'}</button>
              </div>
            </div>
          )}
        </section>
        )}
      </main>

      {isSyncingWoo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#103D66]/60 p-4">
          <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
            <div className="mb-4 flex items-center gap-3">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[#EEF1F4] text-[#103D66]">
                <Loader2 size={20} className="animate-spin" />
              </span>
              <div>
                <div className="text-base font-black text-[#103D66]">Sincronizzazione WooCommerce</div>
                <div className="text-sm text-slate-500">
                  {wooSyncPhase || 'Elaborazione in corso'}
                </div>
              </div>
            </div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-xs font-black uppercase text-[#103D66]">Avanzamento</span>
              <span className="text-xs font-bold text-slate-500">{wooSyncProgress}%</span>
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-[#EEF1F4]">
              <div
                className="h-full rounded-full bg-[#6DA34D] transition-all duration-500"
                style={{ width: `${wooSyncProgress}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {showWooSyncCompleteModal && selectedProduct && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#103D66]/60 p-4"
          onClick={() => setShowWooSyncCompleteModal(false)}
        >
          <div
            className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center gap-3">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[#E6F0E0] text-[#6DA34D]">
                <CheckCircle2 size={22} />
              </span>
              <div>
                <div className="text-base font-black text-[#103D66]">Sincronizzazione completata</div>
                <div className="text-sm text-slate-500">Il prodotto e stato aggiornato su WooCommerce.</div>
              </div>
            </div>
            <div className="flex flex-col gap-3">
              <button
                type="button"
                onClick={() => {
                  if (selectedProduct.frontendUrl) {
                    window.open(selectedProduct.frontendUrl, '_blank', 'noopener,noreferrer');
                  }
                }}
                disabled={!selectedProduct.frontendUrl}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#103D66] px-4 py-3 text-sm font-black text-white disabled:bg-slate-300"
              >
                <ExternalLink size={16} /> Guarda il prodotto
              </button>
              <button
                type="button"
                onClick={() => {
                  if (nextUnsyncedProduct) {
                    selectProduct(nextUnsyncedProduct);
                  } else {
                    setShowWooSyncCompleteModal(false);
                  }
                }}
                disabled={!nextUnsyncedProduct}
                className="flex w-full items-center justify-center rounded-2xl bg-[#6DA34D] px-4 py-3 text-sm font-black text-white disabled:bg-slate-300"
              >
                Vai al prodotto successivo
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowWooSyncCompleteModal(false);
                  setActiveTab('products');
                  scrollToSection('products-top', 40);
                }}
                className="flex w-full items-center justify-center rounded-2xl border border-[#D7D9DD] bg-white px-4 py-3 text-sm font-black text-[#103D66]"
              >
                Vai a tutti i prodotti
              </button>
            </div>
          </div>
        </div>
      )}

      {lightboxResult && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#103D66]/80 p-4"
          onClick={() => setLightboxResult(null)}
        >
          <div
            className="relative w-full max-w-4xl rounded-3xl bg-white p-4 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setLightboxResult(null)}
              className="absolute right-4 top-4 z-10 rounded-full bg-white/90 p-2 text-[#103D66] shadow"
              aria-label="Chiudi anteprima"
            >
              <X size={18} />
            </button>
            <div className="relative mx-auto aspect-[3/4] max-h-[85vh] w-full overflow-hidden rounded-2xl bg-slate-100">
              <Image
                src={lightboxResult.url}
                alt={`${lightboxResult.pose} ${lightboxResult.color}`}
                fill
                sizes="(max-width: 1024px) 100vw, 900px"
                className="object-contain"
                unoptimized
              />
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold">{lightboxResult.pose}</div>
                <div className="text-xs text-slate-500">{lightboxResult.color}</div>
              </div>
              <button
                type="button"
                onClick={() => downloadResult(lightboxResult)}
                className="flex items-center gap-2 rounded-xl bg-[#103D66] px-4 py-2 text-sm font-bold text-white"
              >
                <Download size={16} /> Scarica
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
