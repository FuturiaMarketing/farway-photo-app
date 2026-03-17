import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 300;

const geminiFetchTimeoutMs = 70_000;
const validationFetchTimeoutMs = 12_000;
const imageGenerationModels = [
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-image-preview',
] as const;
const maxImageGenerationAttempts = 4;
const minBannerAspectRatio = 4.6;

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
};

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
          ].join(' '),
        },
      ],
      ['TEXT'],
      validationFetchTimeoutMs
    );

    if (!response.ok) return false;

    const verdict = getGeminiText(result).toUpperCase();
    return verdict.includes('VALID') && !verdict.includes('INVALID');
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

    if (!apiKey) {
      return NextResponse.json({ error: 'Chiave API mancante nel file .env.local.' }, { status: 500 });
    }

    if (!parsedInput) {
      return NextResponse.json({ error: 'Immagine sorgente non valida.' }, { status: 400 });
    }

    const categoryPrompt = categoryName
      ? `The image is for the product category "${categoryName}". Keep the visual language coherent with this category.`
      : 'Keep the visual language premium and coherent with a fashion e-commerce archive header.';

    const prompt = [
      'Create a premium horizontal archive header image from the provided source image.',
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
      'No text, no logo, no watermark, no collage, no split screen.',
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
          const { response, result } = await callGeminiGenerateContent(
            apiKey,
            model,
            [
              ...(parsedSeedInput
                ? [{
                    inline_data: {
                      mime_type: parsedSeedInput.mimeType,
                      data: parsedSeedInput.data,
                    },
                  } satisfies GeminiRequestPart]
                : []),
              {
                inline_data: {
                  mime_type: parsedInput.mimeType,
                  data: parsedInput.data,
                },
              },
              { text: attemptPrompt },
            ],
            ['TEXT', 'IMAGE']
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

          const isValidBanner = await validateBannerOutpaint(
            apiKey,
            imageBase64,
            detectedMimeType
          );

          if (!isValidBanner) {
            lastGenerationStatus = 500;
            lastGenerationError =
              'Output AI scartato: estensione laterale non coerente o soggetto non pienamente valido.';
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
