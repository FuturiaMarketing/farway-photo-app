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

type GeneratedAcfContent = {
  designHtml: string;
  designerNoteHtml: string;
  designHours: string;
  manufacturingHours: string;
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

/**
 * Extract the real remote URL from a local proxy path like
 * `/api/external-image?url=<encoded>` so we fetch it directly
 * instead of making a self-referential HTTP call.
 */
function unwrapProxyUrl(url: string): string | null {
  try {
    const asUrl = url.startsWith('/')
      ? new URL(url, 'http://localhost')
      : new URL(url);
    if (asUrl.pathname === '/api/external-image') {
      const target = asUrl.searchParams.get('url');
      if (target) return target;
    }
  } catch {
    // not a valid URL
  }
  return null;
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

  // Unwrap proxy URLs to avoid self-referential fetch loops on the server.
  const resolvedUrl = unwrapProxyUrl(imageUrl) || imageUrl;

  const imgRes = await fetch(resolvedUrl);

  if (!imgRes.ok) {
    throw new Error(`Impossibile scaricare l'immagine sorgente (${imgRes.status}).`);
  }

  const buffer = await imgRes.arrayBuffer();
  const mimeType = imgRes.headers.get('content-type') || inferMimeType(resolvedUrl);

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

function sanitizeDescriptionHtmlOutput(
  html: string,
  productName: string,
  categories: string[]
) {
  let next = sanitizeModelOutput(html);
  const normalizedTitle = stripHtml(productName).toLowerCase().trim();
  const normalizedCategories = categories
    .map((category) => stripHtml(category).toLowerCase().trim())
    .filter(Boolean);

  if (normalizedTitle) {
    next = next.replace(
      new RegExp(
        String.raw`^\s*<p>\s*(?:<strong>\s*)?${productName
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\s*<\/strong>)?\s*<\/p>\s*`,
        'i'
      ),
      ''
    );
  }

  next = next.replace(
    /^\s*<p>\s*(?:<strong>\s*)?(?:titolo prodotto|nome prodotto)(?:\s*<\/strong>)?\s*:?\s*<\/p>\s*/i,
    ''
  );

  const paragraphs = next.match(/<p>[\s\S]*?<\/p>/gi) || [];

  if (paragraphs.length > 0) {
    const lastParagraph = paragraphs[paragraphs.length - 1];
    const normalizedLastParagraph = stripHtml(lastParagraph).toLowerCase();
    const mentionsCategories =
      normalizedLastParagraph.includes('categorie') ||
      normalizedLastParagraph.includes('categoria') ||
      normalizedCategories.some((category) => normalizedLastParagraph.includes(category));

    if (mentionsCategories) {
      next = next.slice(0, next.lastIndexOf(lastParagraph)).trim();
    }
  }

  return next.trim();
}

function parseJsonObject<T>(value: string) {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function normalizeNumericHours(value: string | number | undefined, fallback: number, minimum = 1) {
  const numeric =
    typeof value === 'number'
      ? value
      : Number.parseInt(String(value || '').replace(/[^\d]/g, ''), 10);

  if (!Number.isFinite(numeric)) {
    return String(fallback);
  }

  return String(Math.max(minimum, Math.round(numeric)));
}

function estimateAcfHours(categories: string[]) {
  const joined = categories
    .map((value) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
    .join(' ');

  if (joined.includes('abiti') || joined.includes('vestiti') || joined.includes('salopette')) {
    return { designHours: 42, manufacturingHours: 2 };
  }

  if (joined.includes('camicia')) {
    return { designHours: 36, manufacturingHours: 1 };
  }

  if (joined.includes('pantalone') || joined.includes('pantaloni')) {
    return { designHours: 34, manufacturingHours: 1 };
  }

  if (joined.includes('gonne') || joined.includes('gonna')) {
    return { designHours: 34, manufacturingHours: 1 };
  }

  if (joined.includes('t-shirt') || joined.includes('tshirt')) {
    return { designHours: 30, manufacturingHours: 1 };
  }

  return { designHours: 36, manufacturingHours: 1 };
}

function buildFallbackAcfContent(categories: string[]) {
  const estimates = estimateAcfHours(categories);

  return {
    designHtml:
      '<p><strong>Design e stile</strong><br />Linee curate, proporzioni equilibrate e un gusto raffinato pensato per valorizzare il capo con eleganza contemporanea, senza eccessi.</p>',
    designerNoteHtml:
      '<p><strong>Note della designer</strong><br />Ho immaginato questo capo come una presenza speciale nel guardaroba dei piu piccoli: bello da vedere, piacevole da indossare e naturale da vivere nei momenti importanti di ogni giorno.</p>',
    designHours: String(Math.max(30, estimates.designHours)),
    manufacturingHours: String(Math.max(1, estimates.manufacturingHours)),
  } satisfies GeneratedAcfContent;
}

export async function POST(req: Request) {
  try {
    const {
      productName,
      currentDescription,
      categories,
      selectedAdditionalScenarioLabels,
      selectedUrbanExtraScenarioLocation,
      selectedExtraUrbanScenarioLocation,
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
    const safeUrbanLocation = String(selectedUrbanExtraScenarioLocation || '').trim();
    const safeExtraUrbanLocation = String(selectedExtraUrbanScenarioLocation || '').trim();
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
      'Do not repeat the product title as a heading, opening line, or standalone first paragraph.',
      'Do not append a category list, category recap, taxonomy label, or closing paragraph listing categories.',
      'Return only the body of the description itself.',
      'Allowed tags for the long description: <p>, <strong>, <br>.',
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

    const descriptionHtml = sanitizeDescriptionHtmlOutput(
      result.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('\n')
        .trim() || '',
      safeProductName,
      safeCategories
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
      'Write in Italian only.',
      'Never answer in English or any other language.',
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

    const acfPrompt = [
      'Generate supplemental product copy in Italian and return JSON only.',
      'All text values in the JSON must be written in Italian only.',
      'Return a valid JSON object with exactly these keys: designHtml, designerNoteHtml, designHours, manufacturingHours.',
      'designHtml: short HTML fragment for the ACF field "Design", describing the garment design and style in a few lines.',
      'designerNoteHtml: short HTML fragment for the ACF field "Note della designer", written in first person by the designer, explaining what inspired the garment and how she imagines it being worn.',
      'designHours: only a number, representing realistic design and development hours (study, research, pattern making). Never less than 30.',
      'manufacturingHours: only a number, representing realistic artisan production hours for one single garment.',
      'Use clean HTML fragments for the two text fields, allowed tags only: <p>, <strong>, <br>.',
      'Keep both text fields concise: just a few lines each.',
      safeProductName ? `Product title: ${safeProductName}.` : '',
      safeCategories.length > 0 ? `Product categories: ${safeCategories.join(', ')}.` : '',
      safeCurrentDescription ? `Imported description: ${safeCurrentDescription}` : '',
      safeOccasions.length > 0 ? `Selected occasions: ${safeOccasions.join(', ')}.` : '',
      safeUrbanLocation ? `Selected urban iconic location: ${safeUrbanLocation}.` : '',
      safeExtraUrbanLocation ? `Selected extra-urban iconic location: ${safeExtraUrbanLocation}.` : '',
      `Long description HTML already generated: ${descriptionHtml}`,
      'Base the output on the visible garment in the provided images, the imported description, the generated long description, the selected occasions, and the selected iconic locations where relevant.',
      'Do not invent technical composition claims or unsupported material claims.',
      'For designHours, think in tens of hours and keep it credible for a premium handmade garment.',
      'For manufacturingHours, estimate the hands-on tailoring time for one single piece and keep it realistic, often around 1 to 3 hours depending on complexity.',
      'Return only the JSON object.',
    ].join(' ');

    const acfResponse = await fetch(
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
              parts: [...imageParts, { text: acfPrompt }],
            },
          ],
          generationConfig: {
            responseModalities: ['TEXT'],
          },
        }),
      }
    );

    const acfResult = (await acfResponse.json()) as GeminiResponse;
    const rawAcfJson = sanitizeModelOutput(
      acfResult.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('\n')
        .trim() || ''
    );
    const parsedAcf = parseJsonObject<Partial<GeneratedAcfContent>>(rawAcfJson);
    const fallbackAcf = buildFallbackAcfContent(safeCategories);
    const generatedAcfContent: GeneratedAcfContent = {
      designHtml: sanitizeModelOutput(parsedAcf?.designHtml || fallbackAcf.designHtml),
      designerNoteHtml: sanitizeModelOutput(parsedAcf?.designerNoteHtml || fallbackAcf.designerNoteHtml),
      designHours: normalizeNumericHours(parsedAcf?.designHours, Number(fallbackAcf.designHours), 30),
      manufacturingHours: normalizeNumericHours(
        parsedAcf?.manufacturingHours,
        Number(fallbackAcf.manufacturingHours),
        1
      ),
    };

    return NextResponse.json({
      descriptionHtml,
      shortDescriptionHtml,
      generatedAcfContent,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Errore sconosciuto';
    return NextResponse.json({ error: `Errore Interno: ${message}` }, { status: 500 });
  }
}
