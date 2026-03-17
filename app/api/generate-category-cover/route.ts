import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 300;

const geminiFetchTimeoutMs = 70_000;
const imageGenerationModels = [
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-image-preview',
] as const;
const maxImageGenerationAttempts = 2;

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
  responseModalities: Array<'TEXT' | 'IMAGE'>
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
    geminiFetchTimeoutMs,
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
  categoryName?: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as GenerateCategoryCoverRequest;
    const parsedInput = parseDataUrl(String(body.imageDataUrl || ''));
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
      'This is an outpainting task: keep the main subject centered and visually coherent with the original source.',
      'Expand the scene naturally on the left and right sides with realistic context.',
      'Do not stretch, warp, duplicate, mirror, or deform the source subject.',
      'Preserve the original subject identity, garment details, colors, and proportions.',
      'Generate one single coherent high-quality image with editorial-grade realism.',
      'No text, no logo, no watermark, no collage, no split screen.',
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
      mimeType: 'image/png',
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Errore sconosciuto';
    const status = message.toLowerCase().includes('timeout') ? 504 : 500;
    return NextResponse.json({ error: `Errore Interno: ${message}` }, { status });
  }
}
