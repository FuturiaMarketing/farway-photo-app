"use client";

import Link from 'next/link';
import NextImage from 'next/image';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Download, ExternalLink, ImagePlus, Loader2, Upload, Wand2 } from 'lucide-react';

type ProductCategory = {
  id: number;
  name: string;
  slug: string;
  parent: number;
};

const TARGET_WIDTH = 1920;
const TARGET_HEIGHT = 400;
const CLIENT_SEAM_SIGMA_THRESHOLD = 2.6;
const CLIENT_SEAM_ROW_DIFF_THRESHOLD = 40;
const CLIENT_SEAM_ROW_COVERAGE_THRESHOLD = 0.56;
const CENTER_LOCK_WIDTH_RATIO = 0.36;
const CENTER_LOCK_HEIGHT_RATIO = 0.94;
const CENTER_LOCK_EDGE_FEATHER_RATIO = 0.08;

type SubjectPlacement = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function slugify(value: string) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stripExtension(fileName: string) {
  return String(fileName || '').replace(/\.[^/.]+$/, '');
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Impossibile leggere il file selezionato.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Impossibile caricare l'immagine sorgente."));
    image.src = dataUrl;
  });
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error("Impossibile convertire l'immagine generata."));
    reader.readAsDataURL(blob);
  });
}

function getCenterLockPlacement(sourceWidth: number, sourceHeight: number): SubjectPlacement {
  const subjectScale = Math.min(
    (TARGET_HEIGHT * CENTER_LOCK_HEIGHT_RATIO) / sourceHeight,
    (TARGET_WIDTH * CENTER_LOCK_WIDTH_RATIO) / sourceWidth
  );
  const width = sourceWidth * subjectScale;
  const height = sourceHeight * subjectScale;

  return {
    x: (TARGET_WIDTH - width) / 2,
    y: (TARGET_HEIGHT - height) / 2,
    width,
    height,
  };
}

function clampFeather(placement: SubjectPlacement) {
  const minSide = Math.min(placement.width, placement.height);
  const requested = Math.round(minSide * CENTER_LOCK_EDGE_FEATHER_RATIO);
  const maxAllowed = Math.max(1, Math.floor(minSide / 4));
  return Math.max(6, Math.min(requested, maxAllowed));
}

function buildCenterLockMask(
  context: CanvasRenderingContext2D,
  placement: SubjectPlacement,
  feather: number
) {
  const innerWidth = Math.max(1, placement.width - feather * 2);
  const innerHeight = Math.max(1, placement.height - feather * 2);

  context.fillStyle = 'rgba(255,255,255,1)';
  context.fillRect(placement.x + feather, placement.y + feather, innerWidth, innerHeight);

  const leftGradient = context.createLinearGradient(placement.x, 0, placement.x + feather, 0);
  leftGradient.addColorStop(0, 'rgba(255,255,255,0)');
  leftGradient.addColorStop(1, 'rgba(255,255,255,1)');
  context.fillStyle = leftGradient;
  context.fillRect(placement.x, placement.y + feather, feather, innerHeight);

  const rightGradient = context.createLinearGradient(
    placement.x + placement.width - feather,
    0,
    placement.x + placement.width,
    0
  );
  rightGradient.addColorStop(0, 'rgba(255,255,255,1)');
  rightGradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = rightGradient;
  context.fillRect(placement.x + placement.width - feather, placement.y + feather, feather, innerHeight);

  const topGradient = context.createLinearGradient(0, placement.y, 0, placement.y + feather);
  topGradient.addColorStop(0, 'rgba(255,255,255,0)');
  topGradient.addColorStop(1, 'rgba(255,255,255,1)');
  context.fillStyle = topGradient;
  context.fillRect(placement.x + feather, placement.y, innerWidth, feather);

  const bottomGradient = context.createLinearGradient(
    0,
    placement.y + placement.height - feather,
    0,
    placement.y + placement.height
  );
  bottomGradient.addColorStop(0, 'rgba(255,255,255,1)');
  bottomGradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = bottomGradient;
  context.fillRect(
    placement.x + feather,
    placement.y + placement.height - feather,
    innerWidth,
    feather
  );

  const topLeftGradient = context.createRadialGradient(
    placement.x + feather,
    placement.y + feather,
    0,
    placement.x + feather,
    placement.y + feather,
    feather
  );
  topLeftGradient.addColorStop(0, 'rgba(255,255,255,1)');
  topLeftGradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = topLeftGradient;
  context.fillRect(placement.x, placement.y, feather, feather);

  const topRightGradient = context.createRadialGradient(
    placement.x + placement.width - feather,
    placement.y + feather,
    0,
    placement.x + placement.width - feather,
    placement.y + feather,
    feather
  );
  topRightGradient.addColorStop(0, 'rgba(255,255,255,1)');
  topRightGradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = topRightGradient;
  context.fillRect(placement.x + placement.width - feather, placement.y, feather, feather);

  const bottomLeftGradient = context.createRadialGradient(
    placement.x + feather,
    placement.y + placement.height - feather,
    0,
    placement.x + feather,
    placement.y + placement.height - feather,
    feather
  );
  bottomLeftGradient.addColorStop(0, 'rgba(255,255,255,1)');
  bottomLeftGradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = bottomLeftGradient;
  context.fillRect(placement.x, placement.y + placement.height - feather, feather, feather);

  const bottomRightGradient = context.createRadialGradient(
    placement.x + placement.width - feather,
    placement.y + placement.height - feather,
    0,
    placement.x + placement.width - feather,
    placement.y + placement.height - feather,
    feather
  );
  bottomRightGradient.addColorStop(0, 'rgba(255,255,255,1)');
  bottomRightGradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = bottomRightGradient;
  context.fillRect(
    placement.x + placement.width - feather,
    placement.y + placement.height - feather,
    feather,
    feather
  );
}

async function normalizeCoverToTarget(
  generatedDataUrl: string,
  centerLockSourceDataUrl?: string
) {
  const sourceImage = await loadImage(generatedDataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = TARGET_WIDTH;
  canvas.height = TARGET_HEIGHT;

  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('Canvas non disponibile nel browser.');
  }

  const sourceWidth = sourceImage.naturalWidth;
  const sourceHeight = sourceImage.naturalHeight;
  // The AI already produced an outpainted scene; here we only normalize to exact output size.
  const scale = Math.max(TARGET_WIDTH / sourceWidth, TARGET_HEIGHT / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const drawX = (TARGET_WIDTH - drawWidth) / 2;
  const drawY = (TARGET_HEIGHT - drawHeight) / 2;

  context.drawImage(sourceImage, drawX, drawY, drawWidth, drawHeight);

  if (centerLockSourceDataUrl) {
    const centerLockSource = await loadImage(centerLockSourceDataUrl);
    const placement = getCenterLockPlacement(
      centerLockSource.naturalWidth,
      centerLockSource.naturalHeight
    );
    const feather = clampFeather(placement);
    const lockLayer = document.createElement('canvas');
    lockLayer.width = TARGET_WIDTH;
    lockLayer.height = TARGET_HEIGHT;
    const lockLayerContext = lockLayer.getContext('2d');

    const maskLayer = document.createElement('canvas');
    maskLayer.width = TARGET_WIDTH;
    maskLayer.height = TARGET_HEIGHT;
    const maskLayerContext = maskLayer.getContext('2d');

    if (lockLayerContext && maskLayerContext) {
      lockLayerContext.drawImage(
        centerLockSource,
        placement.x,
        placement.y,
        placement.width,
        placement.height
      );
      buildCenterLockMask(maskLayerContext, placement, feather);
      lockLayerContext.globalCompositeOperation = 'destination-in';
      lockLayerContext.drawImage(maskLayer, 0, 0);
      lockLayerContext.globalCompositeOperation = 'source-over';
      context.drawImage(lockLayer, 0, 0);
    }
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (outputBlob) => {
        if (!outputBlob) {
          reject(new Error('Errore nella generazione della cover.'));
          return;
        }

        resolve(outputBlob);
      },
      'image/jpeg',
      0.92
    );
  });

  return {
    blob,
    sourceWidth,
    sourceHeight,
    generatedDataUrl,
  };
}

async function buildOutpaintSeed(sourceDataUrl: string) {
  const sourceImage = await loadImage(sourceDataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = TARGET_WIDTH;
  canvas.height = TARGET_HEIGHT;

  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('Canvas non disponibile nel browser.');
  }

  const sourceWidth = sourceImage.naturalWidth;
  const sourceHeight = sourceImage.naturalHeight;

  context.clearRect(0, 0, TARGET_WIDTH, TARGET_HEIGHT);

  const placement = getCenterLockPlacement(sourceWidth, sourceHeight);

  context.drawImage(sourceImage, placement.x, placement.y, placement.width, placement.height);

  return canvas.toDataURL('image/png');
}

function getColumnDiff(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  channels: number,
  x: number
) {
  const channelCount = Math.min(3, channels);
  let sum = 0;

  for (let y = 0; y < height; y += 1) {
    const leftIndex = (y * width + x) * channels;
    const rightIndex = leftIndex + channels;

    for (let c = 0; c < channelCount; c += 1) {
      sum += Math.abs(pixels[leftIndex + c] - pixels[rightIndex + c]);
    }
  }

  return sum / (height * channelCount);
}

function getColumnRowCoverage(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  channels: number,
  x: number
) {
  const channelCount = Math.min(3, channels);
  let hardRows = 0;

  for (let y = 0; y < height; y += 1) {
    const leftIndex = (y * width + x) * channels;
    const rightIndex = leftIndex + channels;
    let rowDiff = 0;

    for (let c = 0; c < channelCount; c += 1) {
      rowDiff += Math.abs(pixels[leftIndex + c] - pixels[rightIndex + c]);
    }

    if (rowDiff / channelCount >= CLIENT_SEAM_ROW_DIFF_THRESHOLD) {
      hardRows += 1;
    }
  }

  return hardRows / height;
}

function findClosestIndex(indices: number[], target: number) {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const value of indices) {
    const distance = Math.abs(value - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = value;
    }
  }

  return { bestIndex, bestDistance };
}

async function hasTriptychLikeSeamsInBrowser(generatedDataUrl: string) {
  const image = await loadImage(generatedDataUrl);
  const sampledWidth = 960;
  const sampledHeight = Math.max(180, Math.round((image.naturalHeight / image.naturalWidth) * sampledWidth));
  const canvas = document.createElement('canvas');
  canvas.width = sampledWidth;
  canvas.height = sampledHeight;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return false;

  context.drawImage(image, 0, 0, sampledWidth, sampledHeight);
  const imageData = context.getImageData(0, 0, sampledWidth, sampledHeight);
  const pixels = imageData.data;
  const channels = 4;
  const diffs: number[] = new Array(sampledWidth - 1).fill(0);

  for (let x = 0; x < sampledWidth - 1; x += 1) {
    diffs[x] = getColumnDiff(pixels, sampledWidth, sampledHeight, channels, x);
  }

  const mean = diffs.reduce((acc, value) => acc + value, 0) / diffs.length;
  const variance =
    diffs.reduce((acc, value) => acc + Math.pow(value - mean, 2), 0) / Math.max(1, diffs.length - 1);
  const sigma = Math.sqrt(variance);
  const threshold = mean + sigma * CLIENT_SEAM_SIGMA_THRESHOLD;

  const candidateIndices: number[] = [];
  for (let x = 1; x < diffs.length - 1; x += 1) {
    const ratio = x / sampledWidth;
    if (ratio < 0.2 || ratio > 0.8) continue;
    if (diffs[x] >= threshold && diffs[x] >= diffs[x - 1] && diffs[x] >= diffs[x + 1]) {
      candidateIndices.push(x);
    }
  }

  if (candidateIndices.length < 2) {
    return false;
  }

  const leftTarget = sampledWidth / 3;
  const rightTarget = (sampledWidth * 2) / 3;
  const left = findClosestIndex(candidateIndices, leftTarget);
  const right = findClosestIndex(candidateIndices, rightTarget);
  const tolerance = sampledWidth * 0.09;

  if (left.bestIndex < 0 || right.bestIndex < 0 || left.bestDistance > tolerance || right.bestDistance > tolerance) {
    return false;
  }

  const leftCoverage = getColumnRowCoverage(
    pixels,
    sampledWidth,
    sampledHeight,
    channels,
    left.bestIndex
  );
  const rightCoverage = getColumnRowCoverage(
    pixels,
    sampledWidth,
    sampledHeight,
    channels,
    right.bestIndex
  );

  return (
    leftCoverage >= CLIENT_SEAM_ROW_COVERAGE_THRESHOLD &&
    rightCoverage >= CLIENT_SEAM_ROW_COVERAGE_THRESHOLD
  );
}

export default function ArchiveCoverPage() {
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState('');
  const [generatedPreviewUrl, setGeneratedPreviewUrl] = useState('');
  const [generatedBlob, setGeneratedBlob] = useState<Blob | null>(null);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [isLoadingCategories, setIsLoadingCategories] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSyncingWoo, setIsSyncingWoo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wooSyncError, setWooSyncError] = useState<string | null>(null);
  const [wooSyncMessage, setWooSyncMessage] = useState<string | null>(null);
  const [wooCategoryBackendUrl, setWooCategoryBackendUrl] = useState('');
  const [sourceInfo, setSourceInfo] = useState<{ width: number; height: number } | null>(null);
  const [modelOverride, setModelOverride] = useState('');

  useEffect(() => {
    const loadCategories = async () => {
      setIsLoadingCategories(true);

      try {
        const response = await fetch('/api/product-categories', { cache: 'no-store' });
        const data = (await response.json()) as ProductCategory[] | { error?: string };

        if (!response.ok || !Array.isArray(data)) {
          const message = Array.isArray(data)
            ? 'Impossibile caricare le categorie prodotto.'
            : data.error || 'Impossibile caricare le categorie prodotto.';
          throw new Error(message);
        }

        setCategories(data);
      } catch (requestError: unknown) {
        const message =
          requestError instanceof Error
            ? requestError.message
            : 'Errore sconosciuto durante il caricamento categorie.';
        setError(message);
      } finally {
        setIsLoadingCategories(false);
      }
    };

    void loadCategories();
  }, []);

  useEffect(() => {
    return () => {
      if (generatedPreviewUrl) {
        URL.revokeObjectURL(generatedPreviewUrl);
      }
    };
  }, [generatedPreviewUrl]);

  const selectedCategory = useMemo(
    () => categories.find((category) => String(category.id) === selectedCategoryId) || null,
    [categories, selectedCategoryId]
  );

  const outputFileName = useMemo(() => {
    const categoryPart = selectedCategory
      ? slugify(selectedCategory.slug || selectedCategory.name)
      : '';
    const fallbackSourceName = slugify(stripExtension(sourceFile?.name || 'copertina'));
    const safeCategoryPart = categoryPart || fallbackSourceName || 'categoria';

    return `cover-archivio-${safeCategoryPart}-1920x400.jpg`;
  }, [selectedCategory, sourceFile]);

  const handleSourceFile = (file: File | null) => {
    setError(null);
    setWooSyncError(null);
    setWooSyncMessage(null);
    setWooCategoryBackendUrl('');
    setGeneratedBlob(null);

    if (generatedPreviewUrl) {
      URL.revokeObjectURL(generatedPreviewUrl);
      setGeneratedPreviewUrl('');
    }

    if (!file) {
      setSourceFile(null);
      setSourcePreviewUrl('');
      setSourceInfo(null);
      return;
    }

    if (!file.type.startsWith('image/')) {
      setError('Carica un file immagine valido.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setSourceFile(file);
      setSourcePreviewUrl(String(reader.result || ''));
    };
    reader.onerror = () => {
      setError('Impossibile leggere il file selezionato.');
    };
    reader.readAsDataURL(file);
  };

  const generateCover = async () => {
    if (!sourceFile) {
      setError("Seleziona prima un'immagine sorgente.");
      return;
    }

    setIsGenerating(true);
    setError(null);
    setWooSyncError(null);
    setWooSyncMessage(null);
    setWooCategoryBackendUrl('');

    try {
      const sourceDataUrl = await readFileAsDataUrl(sourceFile);
      const sourceImage = await loadImage(sourceDataUrl);
      const seedDataUrl = await buildOutpaintSeed(sourceDataUrl);

      const response = await fetch('/api/generate-category-cover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageDataUrl: sourceDataUrl,
          seedImageDataUrl: seedDataUrl,
          modelOverride: modelOverride.trim() || undefined,
        }),
      });
      const rawBody = await response.text();
      let payload: {
        image?: string;
        mimeType?: string;
        error?: string;
      } = {};

      if (rawBody) {
        try {
          payload = JSON.parse(rawBody) as typeof payload;
        } catch {
          throw new Error(rawBody.slice(0, 240));
        }
      }

      if (!response.ok || !payload.image) {
        throw new Error(payload.error || 'Generazione AI cover categoria fallita.');
      }

      const generatedDataUrl = `data:${payload.mimeType || 'image/png'};base64,${payload.image}`;
      const generatedImage = await loadImage(generatedDataUrl);
      const generatedAspectRatio = generatedImage.naturalWidth / generatedImage.naturalHeight;

      if (generatedAspectRatio < 4.6) {
        throw new Error(
          `Output AI non valido: banner troppo stretto (${generatedImage.naturalWidth}x${generatedImage.naturalHeight}).`
        );
      }

      const hasTriptychSeams = await hasTriptychLikeSeamsInBrowser(generatedDataUrl);
      if (hasTriptychSeams) {
        throw new Error('Output AI scartato: rilevati pannelli affiancati invece di outpainting continuo.');
      }

      const output = await normalizeCoverToTarget(generatedDataUrl, sourceDataUrl);

      setSourceInfo({
        width: sourceImage.naturalWidth,
        height: sourceImage.naturalHeight,
      });
      setSourcePreviewUrl(sourceDataUrl);
      setGeneratedBlob(output.blob);

      if (generatedPreviewUrl) {
        URL.revokeObjectURL(generatedPreviewUrl);
      }

      setGeneratedPreviewUrl(URL.createObjectURL(output.blob));
    } catch (generationError: unknown) {
      const message =
        generationError instanceof Error
          ? generationError.message
          : 'Errore sconosciuto durante la creazione della cover.';
      setError(message);
    } finally {
      setIsGenerating(false);
    }
  };

  const downloadCover = () => {
    if (!generatedBlob) {
      setError('Genera prima la cover.');
      return;
    }

    const downloadUrl = URL.createObjectURL(generatedBlob);
    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = outputFileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(downloadUrl);
  };

  const syncCoverToWoo = async () => {
    if (!generatedBlob) {
      setWooSyncError('Genera prima la cover da sincronizzare.');
      return;
    }

    if (!selectedCategory) {
      setWooSyncError('Seleziona una categoria prima della sincronizzazione WooCommerce.');
      return;
    }

    setIsSyncingWoo(true);
    setWooSyncError(null);
    setWooSyncMessage(null);
    setWooCategoryBackendUrl('');

    try {
      const imageDataUrl = await blobToDataUrl(generatedBlob);
      const response = await fetch('/api/sync-category-cover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          categoryId: selectedCategory.id,
          categoryName: selectedCategory.name,
          imageDataUrl,
        }),
      });

      const rawBody = await response.text();
      let payload: {
        error?: string;
        message?: string;
        backendUrl?: string;
      } = {};

      if (rawBody) {
        try {
          payload = JSON.parse(rawBody) as typeof payload;
        } catch {
          throw new Error(rawBody.slice(0, 240));
        }
      }

      if (!response.ok) {
        throw new Error(payload.error || `Sincronizzazione Woo fallita (${response.status}).`);
      }

      setWooSyncMessage(
        payload.message || `Cover categoria sincronizzata con successo (${selectedCategory.name}).`
      );
      setWooCategoryBackendUrl(String(payload.backendUrl || ''));
    } catch (syncError: unknown) {
      const message =
        syncError instanceof Error ? syncError.message : 'Errore sconosciuto durante la sync Woo.';
      setWooSyncError(message);
    } finally {
      setIsSyncingWoo(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F4F4F5] text-[#103D66]">
      <nav className="sticky top-0 z-40 flex items-center justify-between border-b border-[#D7D9DD] bg-white px-6 py-4 shadow-sm">
        <div>
          <h1 className="text-lg font-bold">Cover Archivio Categorie</h1>
          <p className="text-xs text-[#4C6583]">Genera banner 1920x400 con soggetto centrato</p>
        </div>
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-xl border border-[#D7D9DD] bg-white px-3 py-2 text-sm font-black text-[#103D66] transition-colors hover:bg-[#EEF1F4]"
        >
          <ArrowLeft size={16} /> Torna allo studio
        </Link>
      </nav>

      <main className="mx-auto grid w-full max-w-7xl gap-6 px-6 py-6 xl:grid-cols-[380px_1fr]">
        <section className="rounded-2xl border border-[#D7D9DD] bg-white p-5 shadow-sm">
          <h2 className="text-sm font-black uppercase tracking-wide text-[#4C6583]">Input</h2>

          <label className="mt-4 flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-[#D7D9DD] bg-[#FAFAFA] p-6 text-center">
            <ImagePlus size={26} className="text-[#4C6583]" />
            <div className="text-sm font-bold">Carica immagine sorgente</div>
            <div className="text-xs text-[#4C6583]">Consigliato: soggetto ben centrato</div>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => handleSourceFile(event.target.files?.[0] || null)}
            />
          </label>

          <div className="mt-4">
            <label className="mb-2 block text-xs font-black uppercase tracking-wide text-[#4C6583]">
              Categoria prodotto (opzionale)
            </label>
            <select
              value={selectedCategoryId}
              onChange={(event) => setSelectedCategoryId(event.target.value)}
              disabled={isLoadingCategories}
              className="w-full rounded-xl border border-[#D7D9DD] bg-white px-3 py-2 text-sm font-bold outline-none disabled:bg-slate-100"
            >
              <option value="">Nessuna categoria</option>
              {categories.map((category) => (
                <option key={category.id} value={String(category.id)}>
                  {category.name}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-[#4C6583]">
              Serve per il nome file automatico e per abilitare la sync WooCommerce.
            </p>
          </div>

          <div className="mt-4 rounded-xl border border-[#D7D9DD] bg-[#F8FAFB] p-3 text-xs text-[#4C6583]">
            <div>Output fisso: 1920x400</div>
            <div>Soggetto centrato</div>
            <div>Estensione orizzontale automatica</div>
            <div>Centro soggetto bloccato (anti-deformazione)</div>
            <div>Formato output: JPG</div>
          </div>

          <div className="mt-4">
            <label
              htmlFor="archive-cover-model-override"
              className="mb-2 block text-xs font-black uppercase tracking-wide text-[#4C6583]"
            >
              Modello AI (opzionale)
            </label>
            <input
              id="archive-cover-model-override"
              type="text"
              list="archive-cover-model-suggestions"
              value={modelOverride}
              onChange={(event) => setModelOverride(event.target.value)}
              placeholder="auto (es. gemini-3.1-flash-image-preview, nanobanana2)"
              className="w-full rounded-xl border border-[#D7D9DD] bg-white px-3 py-2 text-sm font-bold outline-none"
            />
            <datalist id="archive-cover-model-suggestions">
              <option value="gemini-2.5-flash-image" />
              <option value="gemini-3.1-flash-image-preview" />
              <option value="nanobanana2" />
            </datalist>
            <p className="mt-2 text-xs text-[#4C6583]">
              Vuoto = fallback automatico. Se un modello custom fallisce, l&apos;app passa ai fallback.
            </p>
          </div>

          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={generateCover}
              disabled={!sourceFile || isGenerating}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#103D66] px-4 py-3 text-sm font-black text-white disabled:bg-slate-300"
            >
              {isGenerating ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
              {isGenerating ? 'Generazione...' : 'Genera Cover'}
            </button>
            <button
              type="button"
              onClick={downloadCover}
              disabled={!generatedBlob}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#6DA34D] px-4 py-3 text-sm font-black text-white disabled:bg-slate-300"
            >
              <Download size={16} /> Scarica
            </button>
          </div>

          <button
            type="button"
            onClick={syncCoverToWoo}
            disabled={!generatedBlob || !selectedCategory || isSyncingWoo}
            className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#0F766E] px-4 py-3 text-sm font-black text-white disabled:bg-slate-300"
          >
            {isSyncingWoo ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            {isSyncingWoo ? 'Sync Woo in corso...' : 'Sincronizza cover su WooCommerce'}
          </button>

          <p className="mt-2 text-xs text-[#4C6583]">
            La sync Woo e disponibile solo dopo la generazione e con una categoria selezionata.
          </p>

          <div className="mt-3 rounded-xl border border-[#D7D9DD] bg-white p-3 text-xs text-[#4C6583]">
            Nome file: <span className="font-bold text-[#103D66]">{outputFileName}</span>
          </div>

          {error && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">
              {error}
            </div>
          )}

          {wooSyncError && (
            <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">
              {wooSyncError}
            </div>
          )}

          {wooSyncMessage && (
            <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-bold text-emerald-700">
              <div>{wooSyncMessage}</div>
              {wooCategoryBackendUrl && (
                <a
                  href={wooCategoryBackendUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-2 text-xs font-black uppercase text-[#0F766E]"
                >
                  <ExternalLink size={14} /> Apri categoria nel backend
                </a>
              )}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-[#D7D9DD] bg-white p-5 shadow-sm">
          <h2 className="text-sm font-black uppercase tracking-wide text-[#4C6583]">Anteprima</h2>

          <div className="mt-4 grid gap-5 xl:grid-cols-2">
            <div>
              <div className="mb-2 text-xs font-black uppercase tracking-wide text-[#4C6583]">
                Sorgente
              </div>
              <div className="overflow-hidden rounded-2xl border border-[#D7D9DD] bg-[#F8FAFB] p-3">
                <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-slate-100">
                  {sourcePreviewUrl ? (
                    <NextImage
                      src={sourcePreviewUrl}
                      alt="Sorgente caricata"
                      fill
                      unoptimized
                      className="object-contain"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs font-bold text-slate-400">
                      Carica un&apos;immagine per iniziare
                    </div>
                  )}
                </div>
                <div className="mt-3 text-xs text-[#4C6583]">
                  {sourceInfo ? `Dimensioni sorgente: ${sourceInfo.width}x${sourceInfo.height}` : 'Dimensioni sorgente: -'}
                </div>
              </div>
            </div>

            <div>
              <div className="mb-2 text-xs font-black uppercase tracking-wide text-[#4C6583]">
                Cover 1920x400
              </div>
              <div className="overflow-hidden rounded-2xl border border-[#D7D9DD] bg-[#F8FAFB] p-3">
                <div className="relative aspect-[24/5] w-full overflow-hidden rounded-xl bg-slate-100">
                  {generatedPreviewUrl ? (
                    <NextImage
                      src={generatedPreviewUrl}
                      alt="Cover archivio generata"
                      fill
                      unoptimized
                      className="object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs font-bold text-slate-400">
                      Nessun output disponibile
                    </div>
                  )}
                </div>
                <div className="mt-3 text-xs text-[#4C6583]">Dimensioni output: 1920x400</div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
