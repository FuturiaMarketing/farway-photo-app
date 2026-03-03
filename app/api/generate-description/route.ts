import { NextResponse } from 'next/server';

type GeminiRequestPart = {
  text?: string;
  inline_data?: {
    mime_type: string;
    data: string;
  };
};

type GeminiResponse = {
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

function parseDataUrl(imageUrl: string) {
  const match = imageUrl.match(/^data:(.+?);base64,(.+)$/);

  if (!match) return null;

  return {
    mimeType: match[1],
    data: match[2],
  };
}

function inferMimeType(url: string) {
  const pathname = new URL(url).pathname.toLowerCase();

  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  if (pathname.endsWith('.webp')) return 'image/webp';
  if (pathname.endsWith('.gif')) return 'image/gif';

  return 'image/png';
}

async function loadInlineImagePart(imageUrl: string) {
  const inlineImage = parseDataUrl(imageUrl);

  if (inlineImage) {
    return {
      inline_data: {
        mime_type: inlineImage.mimeType,
        data: inlineImage.data,
      },
    } satisfies GeminiRequestPart;
  }

  const imgRes = await fetch(imageUrl);

  if (!imgRes.ok) {
    throw new Error(`Impossibile scaricare l'immagine sorgente (${imgRes.status}).`);
  }

  const buffer = await imgRes.arrayBuffer();
  const mimeType = imgRes.headers.get('content-type') || inferMimeType(imageUrl);

  return {
    inline_data: {
      mime_type: mimeType,
      data: Buffer.from(buffer).toString('base64'),
    },
  } satisfies GeminiRequestPart;
}

function stripHtml(value: string) {
  return value
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

function sanitizeModelOutput(value: string) {
  return String(value || '')
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim();
}

export async function POST(req: Request) {
  try {
    const {
      productName,
      currentDescription,
      categories,
      selectedAdditionalScenarioLabels,
      generatedImageUrls,
    } = await req.json();

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || '';

    if (!apiKey) {
      return NextResponse.json(
        { error: 'Chiave API mancante nel file .env.local.' },
        { status: 500 }
      );
    }

    const safeProductName = String(productName || '').trim();
    const safeCurrentDescription = stripHtml(String(currentDescription || ''));
    const safeCategories = Array.isArray(categories)
      ? categories
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .slice(0, 12)
      : [];
    const safeOccasions = Array.isArray(selectedAdditionalScenarioLabels)
      ? selectedAdditionalScenarioLabels
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .slice(0, 8)
      : [];
    const safeImageUrls = Array.isArray(generatedImageUrls)
      ? generatedImageUrls
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
          .slice(0, 5)
      : [];

    const imageParts = await Promise.all(
      safeImageUrls.map(async (imageUrl: string) => loadInlineImagePart(imageUrl))
    );

    const prompt = [
      'Write a premium Italian e-commerce product description in HTML only.',
      'Return only clean HTML fragments, with no code fences and no explanations.',
      'Use semantic rich-text style formatting suitable for a WYSIWYG editor.',
      safeProductName ? `Product title: ${safeProductName}.` : '',
      safeCategories.length > 0
        ? `Product categories: ${safeCategories.join(', ')}.`
        : '',
      safeCurrentDescription
        ? `Current imported description to preserve factual information where useful: ${safeCurrentDescription}`
        : 'No current description is available. Use only visible facts, category context, and the rules below.',
      safeOccasions.length > 0
        ? `Selected occasions of use to weave into the narrative: ${safeOccasions.join(', ')}.`
        : 'No extra occasions of use were selected, so keep the tone versatile and refined.',
      'Analyze the provided generated product images to understand the visible garment only: silhouette, style, occasion feel, and premium appearance.',
      'Do not invent technical facts that are not visible or not supported by the imported description.',
      'Never state a specific fabric composition, material certification, or fiber claim unless it is explicitly present in the imported description.',
      'In particular, never write "cotone biologico" unless that exact claim is already present in the imported description.',
      'The buyer is not the child wearing the garment. Always address the buyer directly as a parent, relative, or family friend choosing the garment for a child.',
      'Make the buyer feel important, thoughtful, and discerning.',
      'Position the brand as high-end, ethical, handmade in Italy, and intelligently luxurious at honest prices.',
      'Communicate that buying from Farway means accessing the value and quality of a much more expensive boutique garment while paying far less than in-store.',
      'Keep the tone warm, elegant, credible, and emotionally evocative, never cheesy.',
      'Use the selected occasions to help the buyer visualize real scenes and imagine gifting or choosing the garment for the child.',
      'Organize the result in short readable paragraphs.',
      'Use a few <strong>...</strong> phrases to guide the eye and improve readability.',
      'Length: medium, not too long. Usually 3 short paragraphs plus an optional short closing paragraph.',
      'Write in Italian.',
      'Allowed tags for the long description: <p>, <strong>, <br>.',
    ]
      .filter(Boolean)
      .join(' ');

    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [...imageParts, { text: prompt }],
            },
          ],
          generationConfig: {
            responseModalities: ['TEXT'],
          },
        }),
      }
    );

    const result = (await response.json()) as GeminiResponse;

    if (!response.ok) {
      return NextResponse.json(
        {
          error: `Errore Google (${response.status}): ${result.error?.message || 'Errore sconosciuto'}`,
        },
        { status: response.status }
      );
    }

    const descriptionHtml = sanitizeModelOutput(
      result.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('\n')
        .trim() || ''
    );

    if (!descriptionHtml) {
      return NextResponse.json(
        { error: 'Gemini non ha restituito una descrizione valida.' },
        { status: 500 }
      );
    }

    const shortPrompt = [
      'Rewrite the following long product description into a WooCommerce short description in HTML only.',
      'Return only clean HTML fragments, with no code fences and no explanations.',
      'Keep it suitable for the small excerpt above the purchase button.',
      'Address the buyer, not the child wearing the garment.',
      'Keep it concise: one short paragraph, usually 2 to 4 sentences.',
      'Use at most one or two <strong>...</strong> highlights.',
      'Allowed tags: <p>, <strong>, <br>.',
      `Long description HTML: ${descriptionHtml}`,
    ].join(' ');

    const shortResponse = await fetch(
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
              parts: [{ text: shortPrompt }],
            },
          ],
          generationConfig: {
            responseModalities: ['TEXT'],
          },
        }),
      }
    );

    const shortResult = (await shortResponse.json()) as GeminiResponse;
    const shortDescriptionHtml = shortResponse.ok
      ? sanitizeModelOutput(
          shortResult.candidates?.[0]?.content?.parts
            ?.map((part) => part.text || '')
            .join('\n')
            .trim() || ''
        )
      : '';

    return NextResponse.json({
      descriptionHtml,
      shortDescriptionHtml,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Errore sconosciuto';
    return NextResponse.json({ error: `Errore Interno: ${message}` }, { status: 500 });
  }
}
