"use client";

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Download, ImagePlus, Loader2, Wand2 } from 'lucide-react';

type ProductCategory = {
  id: number;
  name: string;
  slug: string;
  parent: number;
};

const TARGET_WIDTH = 1920;
const TARGET_HEIGHT = 400;

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

async function buildArchiveCover(file: File) {
  const sourceDataUrl = await readFileAsDataUrl(file);
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
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = TARGET_WIDTH / TARGET_HEIGHT;

  if (sourceAspect >= targetAspect) {
    const cropWidth = Math.floor(sourceHeight * targetAspect);
    const cropX = Math.max(0, Math.floor((sourceWidth - cropWidth) / 2));
    context.drawImage(
      sourceImage,
      cropX,
      0,
      cropWidth,
      sourceHeight,
      0,
      0,
      TARGET_WIDTH,
      TARGET_HEIGHT
    );
  } else {
    const backgroundScale = Math.max(TARGET_WIDTH / sourceWidth, TARGET_HEIGHT / sourceHeight);
    const backgroundWidth = sourceWidth * backgroundScale;
    const backgroundHeight = sourceHeight * backgroundScale;
    const backgroundX = (TARGET_WIDTH - backgroundWidth) / 2;
    const backgroundY = (TARGET_HEIGHT - backgroundHeight) / 2;

    context.save();
    context.filter = 'blur(26px)';
    context.drawImage(sourceImage, backgroundX, backgroundY, backgroundWidth, backgroundHeight);
    context.restore();
    context.fillStyle = 'rgba(255,255,255,0.08)';
    context.fillRect(0, 0, TARGET_WIDTH, TARGET_HEIGHT);

    const centerScale = TARGET_HEIGHT / sourceHeight;
    const centerWidth = sourceWidth * centerScale;
    const centerX = (TARGET_WIDTH - centerWidth) / 2;
    const leftGap = Math.max(0, Math.floor(centerX));
    const rightGap = Math.max(0, TARGET_WIDTH - Math.ceil(centerX + centerWidth));

    const stretchedCanvas = document.createElement('canvas');
    stretchedCanvas.width = Math.max(1, Math.round(centerWidth));
    stretchedCanvas.height = TARGET_HEIGHT;

    const stretchedContext = stretchedCanvas.getContext('2d');

    if (stretchedContext) {
      stretchedContext.drawImage(sourceImage, 0, 0, stretchedCanvas.width, TARGET_HEIGHT);
      const edgeSampleWidth = Math.max(24, Math.min(120, Math.round(stretchedCanvas.width * 0.08)));

      if (leftGap > 0) {
        context.save();
        context.filter = 'blur(6px)';
        context.drawImage(
          stretchedCanvas,
          0,
          0,
          edgeSampleWidth,
          TARGET_HEIGHT,
          0,
          0,
          leftGap,
          TARGET_HEIGHT
        );
        context.restore();
      }

      if (rightGap > 0) {
        context.save();
        context.filter = 'blur(6px)';
        context.drawImage(
          stretchedCanvas,
          stretchedCanvas.width - edgeSampleWidth,
          0,
          edgeSampleWidth,
          TARGET_HEIGHT,
          TARGET_WIDTH - rightGap,
          0,
          rightGap,
          TARGET_HEIGHT
        );
        context.restore();
      }
    }

    context.drawImage(sourceImage, centerX, 0, centerWidth, TARGET_HEIGHT);
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
    sourceDataUrl,
  };
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
  const [error, setError] = useState<string | null>(null);
  const [sourceInfo, setSourceInfo] = useState<{ width: number; height: number } | null>(null);

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

    try {
      const output = await buildArchiveCover(sourceFile);

      setSourceInfo({
        width: output.sourceWidth,
        height: output.sourceHeight,
      });
      setSourcePreviewUrl(output.sourceDataUrl);
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
              Serve solo per il nome file automatico in download.
            </p>
          </div>

          <div className="mt-4 rounded-xl border border-[#D7D9DD] bg-[#F8FAFB] p-3 text-xs text-[#4C6583]">
            <div>Output fisso: 1920x400</div>
            <div>Soggetto centrato</div>
            <div>Estensione orizzontale automatica</div>
            <div>Formato output: JPG</div>
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

          <div className="mt-3 rounded-xl border border-[#D7D9DD] bg-white p-3 text-xs text-[#4C6583]">
            Nome file: <span className="font-bold text-[#103D66]">{outputFileName}</span>
          </div>

          {error && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">
              {error}
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
                    <img
                      src={sourcePreviewUrl}
                      alt="Sorgente caricata"
                      className="h-full w-full object-contain"
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
                    <img
                      src={generatedPreviewUrl}
                      alt="Cover archivio generata"
                      className="h-full w-full object-cover"
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
