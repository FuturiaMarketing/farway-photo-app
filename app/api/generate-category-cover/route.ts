import { NextResponse } from 'next/server';
import sharp from 'sharp';

export const runtime = 'nodejs';
export const maxDuration = 300;

const geminiFetchTimeoutMs = 70_000;
const validationFetchTimeoutMs = 12_000;
const allowedImageSizes = new Set(['1K', '2K', '4K']);
const defaultImageGenerationModels = [
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-image-preview',
] as const;
const maxImageGenerationAttempts = 4;
const minBannerAspectRatio = 4.6;
const seamSigmaThreshold = 2.8;
const seamBandMinRatio = 0.2;
const seamBandMaxRatio = 0.8;
const seamExpectedTolerance = 0.09;
const seamRowDiffThreshold = 42;
const seamRowCoverageThreshold = 0.58;
const modelIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,127}$/;

function resolveGeminiImageSize(value: string | undefined, fallback: '1K' | '2K' | '4K') {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();

  if (allowedImageSizes.has(normalized)) {
    return normalized as '1K' | '2K' | '4K';
  }

  return fallback;
}

const categoryCoverImageSize = resolveGeminiImageSize(process.env.CATEGORY_COVER_IMAGE_SIZE, '2K');

type GeminiPart = {
  text?: string;
  inlineData?: {
    data?: string;
  };
  inline_data?: {
    data?: string;
  };
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
  }>;
  error?: {
    message?: string;
  };
};

type GeminiRequestPart = {
  text?: string;
  inline_data?: {
    mime_type: string;
    data: string;
  };
};

function parseDataUrl(imageUrl: string) {
  const match = String(imageUrl || '').match(/^data:(.+?);base64,(.+)$/);

  if (!match) return null;

  return {
    mimeType: match[1],
    data: match[2],
  };
}

function getGeminiParts(result: GeminiResponse) {
  return (result.candidates || []).flatMap((candidate) => candidate.content?.parts || []);
}

function getGeminiImageData(result: GeminiResponse) {
  const parts = getGeminiParts(result);
  const imagePart = parts.find((part) => part.inlineData?.data || part.inline_data?.data);

  return imagePart?.inlineData?.data || imagePart?.inline_data?.data || '';
}

function getGeminiText(result: GeminiResponse) {
  const parts = getGeminiParts(result);

  return parts
    .map((part) => part.text?.trim() || '')
    .filter(Boolean)
    .join(' ')
    .trim();
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  timeoutMessage: string
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(timeoutMessage);
    }

    throw error instanceof Error ? error : new Error('Errore di rete imprevisto.');
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callGeminiGenerateContent(
  apiKey: string,
  model: string,
  parts: GeminiRequestPart[],
  responseModalities: Array<'TEXT' | 'IMAGE'>,
  imageConfig?: {
    imageSize?: string;
  },
  timeoutMs = geminiFetchTimeoutMs
) {
  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            parts,
          },
        ],
        generationConfig: {
          responseModalities,
          ...(imageConfig ? { imageConfig } : {}),
        },
      }),
    },
    timeoutMs,
    `Timeout durante la chiamata a Gemini (${model}).`
  );

  let result: GeminiResponse = {};

  try {
    result = (await response.json()) as GeminiResponse;
  } catch {
    result = {
      error: {
        message: 'Gemini ha restituito una risposta non valida.',
      },
    };
  }

  return { response, result };
}

type GenerateCategoryCoverRequest = {
  imageDataUrl?: string;
  seedImageDataUrl?: string;
  categoryName?: string;
  modelOverride?: string;
};

function sanitizeModelId(model: string) {
  return String(model || '').trim();
}

function parseModelList(rawValue: string) {
  return String(rawValue || '')
    .split(',')
    .map((value) => sanitizeModelId(value))
    .filter((value) => modelIdPattern.test(value));
}

function resolveImageGenerationModels(modelOverride: string) {
  const resolvedModels: string[] = [];
  const seenModels = new Set<string>();

  const pushUniqueModel = (model: string) => {
    const normalizedModel = sanitizeModelId(model);
    if (!modelIdPattern.test(normalizedModel) || seenModels.has(normalizedModel)) {
      return;
    }

    seenModels.add(normalizedModel);
    resolvedModels.push(normalizedModel);
  };

  pushUniqueModel(modelOverride);
  for (const modelFromEnv of parseModelList(process.env.CATEGORY_COVER_IMAGE_MODELS || '')) {
    pushUniqueModel(modelFromEnv);
  }
  for (const defaultModel of defaultImageGenerationModels) {
    pushUniqueModel(defaultModel);
  }

  return resolvedModels;
}

function detectMimeTypeFromBase64(base64: string) {
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (base64.startsWith('UklGR')) return 'image/webp';
  return 'image/png';
}

function getImageDimensions(base64: string, mimeType: string) {
  const bytes = Buffer.from(base64, 'base64');

  if (mimeType.includes('png')) {
    if (bytes.length < 24) return null;
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }

  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let offset = 2;

    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = bytes[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      if (offset + 3 >= bytes.length) break;

      const blockLength = bytes.readUInt16BE(offset + 2);
      if (blockLength < 2 || offset + 2 + blockLength > bytes.length) break;

      const isSofMarker =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);

      if (isSofMarker && offset + 8 < bytes.length) {
        const height = bytes.readUInt16BE(offset + 5);
        const width = bytes.readUInt16BE(offset + 7);
        return width > 0 && height > 0 ? { width, height } : null;
      }

      offset += 2 + blockLength;
    }
  }

  return null;
}

async function validateBannerOutpaint(apiKey: string, imageBase64: string, mimeType: string) {
  try {
    const { response, result } = await callGeminiGenerateContent(
      apiKey,
      'gemini-2.5-flash',
      [
        {
          inline_data: {
            mime_type: mimeType,
            data: imageBase64,
          },
        },
        {
          text: [
            'Evaluate this image as a category archive banner.',
            'Reply with one word only: VALID or INVALID.',
            'VALID only if all conditions are true:',
            '1) very wide horizontal banner composition;',
            '2) one single coherent scene;',
            '3) subject is full-body, centered, and not cropped;',
            '4) left and right sides contain realistic coherent context;',
            '5) no obvious blurred placeholder bands, no mirrored smears, no flat filler zones.',
            '6) no hard vertical panel seams and no side-by-side multi-panel layout.',
          ].join(' '),
        },
      ],
      ['TEXT'],
      undefined,
      validationFetchTimeoutMs
    );

    if (!response.ok) return false;

    const verdict = getGeminiText(result).toUpperCase();
    return verdict.includes('VALID') && !verdict.includes('INVALID');
  } catch {
    return false;
  }
}

async function validateNoPanelCollage(apiKey: string, imageBase64: string, mimeType: string) {
  try {
    const { response, result } = await callGeminiGenerateContent(
      apiKey,
      'gemini-2.5-flash',
      [
        {
          inline_data: {
            mime_type: mimeType,
            data: imageBase64,
          },
        },
        {
          text: [
            'Inspect the image for panel seams and duplicated side-by-side composition.',
            'Reply with one word only: PASS or FAIL.',
            'FAIL if there is ANY sign of: split-screen layout, collage, triptych, multiple adjacent frames,',
            'hard vertical seams, or duplicated source scene/subject in separate panels.',
          ].join(' '),
        },
      ],
      ['TEXT'],
      undefined,
      validationFetchTimeoutMs
    );

    if (!response.ok) return false;

    const verdict = getGeminiText(result).toUpperCase();
    return verdict.includes('PASS') && !verdict.includes('FAIL');
  } catch {
    return false;
  }
}

function getVerticalDiffScore(
  pixels: Uint8Array,
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

function getSeamRowCoverage(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
  x: number
) {
  const channelCount = Math.min(3, channels);
  let rowsWithHardEdge = 0;

  for (let y = 0; y < height; y += 1) {
    const leftIndex = (y * width + x) * channels;
    const rightIndex = leftIndex + channels;
    let rowDiff = 0;

    for (let c = 0; c < channelCount; c += 1) {
      rowDiff += Math.abs(pixels[leftIndex + c] - pixels[rightIndex + c]);
    }

    if (rowDiff / channelCount >= seamRowDiffThreshold) {
      rowsWithHardEdge += 1;
    }
  }

  return rowsWithHardEdge / height;
}

function findClosestPeak(peaks: Array<{ index: number; value: number }>, target: number, width: number) {
  const targetIndex = Math.round(width * target);
  let bestPeak: { index: number; value: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const peak of peaks) {
    const distance = Math.abs(peak.index - targetIndex);
    if (distance < bestDistance) {
      bestPeak = peak;
      bestDistance = distance;
    }
  }

  if (!bestPeak) return null;

  return {
    ...bestPeak,
    distanceRatio: bestDistance / width,
  };
}

async function hasTriptychLikeVerticalSeams(imageBase64: string) {
  try {
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    const { data, info } = await sharp(imageBuffer)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (!info.width || !info.height || info.width < 900 || info.height < 220 || info.channels < 3) {
      return false;
    }

    const width = info.width;
    const height = info.height;
    const channels = info.channels;
    const diffs: number[] = new Array(width - 1).fill(0);

    for (let x = 0; x < width - 1; x += 1) {
      diffs[x] = getVerticalDiffScore(data, width, height, channels, x);
    }

    const mean = diffs.reduce((acc, value) => acc + value, 0) / diffs.length;
    const variance =
      diffs.reduce((acc, value) => acc + Math.pow(value - mean, 2), 0) / Math.max(1, diffs.length - 1);
    const sigma = Math.sqrt(variance);
    const threshold = mean + sigma * seamSigmaThreshold;

    const peaks: Array<{ index: number; value: number }> = [];
    for (let x = 1; x < diffs.length - 1; x += 1) {
      const ratio = x / width;
      if (ratio < seamBandMinRatio || ratio > seamBandMaxRatio) {
        continue;
      }

      const value = diffs[x];
      if (value >= threshold && value >= diffs[x - 1] && value >= diffs[x + 1]) {
        peaks.push({ index: x, value });
      }
    }

    if (peaks.length < 2) {
      return false;
    }

    const leftCandidate = findClosestPeak(peaks, 1 / 3, width);
    const rightCandidate = findClosestPeak(peaks, 2 / 3, width);

    if (!leftCandidate || !rightCandidate) {
      return false;
    }

    if (
      leftCandidate.distanceRatio > seamExpectedTolerance ||
      rightCandidate.distanceRatio > seamExpectedTolerance
    ) {
      return false;
    }

    const leftCoverage = getSeamRowCoverage(data, width, height, channels, leftCandidate.index);
    const rightCoverage = getSeamRowCoverage(data, width, height, channels, rightCandidate.index);

    return leftCoverage >= seamRowCoverageThreshold && rightCoverage >= seamRowCoverageThreshold;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as GenerateCategoryCoverRequest;
    const parsedInput = parseDataUrl(String(body.imageDataUrl || ''));
    const parsedSeedInput = parseDataUrl(String(body.seedImageDataUrl || ''));
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || '';
    const categoryName = String(body.categoryName || '').trim();
    const modelOverride = sanitizeModelId(String(body.modelOverride || ''));
    const imageGenerationModels = resolveImageGenerationModels(modelOverride);

    if (!apiKey) {
      return NextResponse.json({ error: 'Chiave API mancante nel file .env.local.' }, { status: 500 });
    }

    if (!parsedInput && !parsedSeedInput) {
      return NextResponse.json({ error: 'Immagine sorgente non valida.' }, { status: 400 });
    }

    if (imageGenerationModels.length === 0) {
      return NextResponse.json({ error: 'Nessun modello image valido configurato.' }, { status: 500 });
    }

    const categoryPrompt = categoryName
      ? `The image is for the product category "${categoryName}". Keep the visual language coherent with this category.`
      : 'Keep the visual language premium and coherent with a fashion e-commerce archive header.';

    const prompt = [
      'Create a premium horizontal archive header image by outpainting a centered subject.',
      'This is a CONSERVATIVE outpainting task.',
      parsedSeedInput
        ? 'Image 1 is a 1920x400 outpainting template with transparent side areas.'
        : '',
      parsedSeedInput
        ? 'Treat Image 1 center area as protected: keep the subject full body, centered, and visually intact.'
        : '',
      parsedSeedInput
        ? 'The transparent side areas in Image 1 must be fully completed with detailed realistic context.'
        : '',
      'Expand the scene naturally on the left and right sides with realistic context.',
      'Do not stretch, warp, duplicate, mirror, or deform the source subject.',
      'Preserve the original subject identity, garment details, colors, and proportions.',
      'The subject must remain whole, centered, and not cropped.',
      'Do not zoom in or cut body parts.',
      'Generate one single coherent high-quality image with editorial-grade realism.',
      'The result must look like one single camera frame, never multiple frames.',
      'No text, no logo, no watermark, no collage, no split screen.',
      'Do not duplicate the original image as left/center/right panels.',
      'Do not create hard vertical seams or panel boundaries.',
      'Do not leave blurred side bands, plain side bars, empty areas, or unresolved placeholder zones.',
      'Keep the composition ready for a very wide category banner, with safe breathing room around the subject.',
      categoryPrompt,
    ].join(' ');

    let generatedImageBase64 = '';
    let lastGenerationError = 'Generazione cover categoria fallita.';
    let lastGenerationStatus = 500;

    generationLoop: for (let attempt = 0; attempt < maxImageGenerationAttempts; attempt += 1) {
      const attemptPrompt = [
        prompt,
        attempt > 0
          ? 'The previous result was not valid enough. Regenerate with stronger left/right outpainting coherence and keep one single high-quality scene.'
          : '',
      ]
        .filter(Boolean)
        .join(' ');

      for (const model of imageGenerationModels) {
        try {
          const generationImageParts: GeminiRequestPart[] = parsedSeedInput
            ? [
                {
                  inline_data: {
                    mime_type: parsedSeedInput.mimeType,
                    data: parsedSeedInput.data,
                  },
                },
              ]
            : parsedInput
              ? [
                  {
                    inline_data: {
                      mime_type: parsedInput.mimeType,
                      data: parsedInput.data,
                    },
                  },
                ]
              : [];

          const { response, result } = await callGeminiGenerateContent(
            apiKey,
            model,
            [
              ...generationImageParts,
              { text: attemptPrompt },
            ],
            ['TEXT', 'IMAGE'],
            {
              imageSize: categoryCoverImageSize,
            }
          );

          if (!response.ok) {
            console.error(`Errore Gemini cover (${model}):`, result);
            lastGenerationStatus = response.status;
            lastGenerationError = `Errore Google (${response.status}): ${result.error?.message || 'Errore sconosciuto'}`;
            continue;
          }

          const imageBase64 = getGeminiImageData(result);
          const explanation = getGeminiText(result);

          if (!imageBase64) {
            lastGenerationStatus = 500;
            lastGenerationError =
              explanation || 'Gemini ha risposto senza un output immagine valido.';
            continue;
          }

          const detectedMimeType = detectMimeTypeFromBase64(imageBase64);
          const dimensions = getImageDimensions(imageBase64, detectedMimeType);

          if (!dimensions) {
            lastGenerationStatus = 500;
            lastGenerationError = 'Output immagine non valido (dimensioni non leggibili).';
            continue;
          }

          const aspectRatio = dimensions.width / dimensions.height;
          if (aspectRatio < minBannerAspectRatio) {
            lastGenerationStatus = 500;
            lastGenerationError =
              `Output non abbastanza orizzontale (${dimensions.width}x${dimensions.height}).`;
            continue;
          }

          const [isValidBanner, isNoPanelCollage, hasTriptychSeams] = await Promise.all([
            validateBannerOutpaint(apiKey, imageBase64, detectedMimeType),
            validateNoPanelCollage(apiKey, imageBase64, detectedMimeType),
            hasTriptychLikeVerticalSeams(imageBase64),
          ]);

          if (!isValidBanner || !isNoPanelCollage || hasTriptychSeams) {
            lastGenerationStatus = 500;
            lastGenerationError =
              'Output AI scartato: rilevata composizione non coerente (collage/seams) o outpainting non valido.';
            continue;
          }

          generatedImageBase64 = imageBase64;
          break generationLoop;
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : 'Errore imprevisto durante la generazione cover.';
          console.error(`Errore transitorio Gemini cover (${model}):`, message);
          lastGenerationStatus = message.toLowerCase().includes('timeout') ? 504 : 500;
          lastGenerationError = message;
          continue;
        }
      }
    }

    if (!generatedImageBase64) {
      return NextResponse.json({ error: lastGenerationError }, { status: lastGenerationStatus });
    }

    return NextResponse.json({
      image: generatedImageBase64,
      mimeType: detectMimeTypeFromBase64(generatedImageBase64),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Errore sconosciuto';
    const status = message.toLowerCase().includes('timeout') ? 504 : 500;
    return NextResponse.json({ error: `Errore Interno: ${message}` }, { status });
  }
}
