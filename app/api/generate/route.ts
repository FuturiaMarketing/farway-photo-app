import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

const sourceImageFetchTimeoutMs = 20_000;
const geminiFetchTimeoutMs = 50_000;

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

function parseDataUrl(imageUrl: string) {
  const match = imageUrl.match(/^data:(.+?);base64,(.+)$/);

  if (!match) return null;

  return {
    mimeType: match[1],
    data: match[2],
  };
}

function resolveExternalImageUrl(imageUrl: string, requestOrigin?: string) {
  if (/^https?:\/\//i.test(imageUrl)) {
    return imageUrl;
  }

  const fallbackOrigin =
    requestOrigin ||
    process.env.APP_PUBLIC_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

  return new URL(imageUrl, fallbackOrigin).toString();
}

function inferMimeType(url: string, requestOrigin?: string) {
  const pathname = new URL(resolveExternalImageUrl(url, requestOrigin)).pathname.toLowerCase();

  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  if (pathname.endsWith('.webp')) return 'image/webp';
  if (pathname.endsWith('.gif')) return 'image/gif';

  return 'image/png';
}

async function loadInlineImagePart(imageUrl: string, requestOrigin?: string) {
  const inlineImage = parseDataUrl(imageUrl);

  if (inlineImage) {
    return {
      inline_data: {
        mime_type: inlineImage.mimeType,
        data: inlineImage.data,
      },
    } satisfies GeminiRequestPart;
  }

  const imgRes = await fetchWithTimeout(
    resolveExternalImageUrl(imageUrl, requestOrigin),
    {},
    sourceImageFetchTimeoutMs,
    "Timeout nel download dell'immagine sorgente."
  );

  if (!imgRes.ok) {
    throw new Error(`Impossibile scaricare l'immagine sorgente (${imgRes.status}).`);
  }

  const buffer = await imgRes.arrayBuffer();
  const mimeType = imgRes.headers.get('content-type') || inferMimeType(imageUrl, requestOrigin);

  return {
    inline_data: {
      mime_type: mimeType,
      data: Buffer.from(buffer).toString('base64'),
    },
  } satisfies GeminiRequestPart;
}

function stripHtmlToPlainText(value: string) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function callGeminiGenerateContent(
  apiKey: string,
  model: string,
  parts: GeminiRequestPart[],
  responseModalities: Array<'TEXT' | 'IMAGE'>,
  imageConfig?: {
    aspectRatio?: string;
    imageSize?: string;
  }
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

function getGeminiText(result: GeminiResponse) {
  const parts = result.candidates?.[0]?.content?.parts || [];

  return parts
    .map((part) => part.text?.trim() || '')
    .filter(Boolean)
    .join(' ')
    .trim();
}

function getGeminiImageData(result: GeminiResponse) {
  const parts = result.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((part) => part.inlineData?.data || part.inline_data?.data);

  return imagePart?.inlineData?.data || imagePart?.inline_data?.data || '';
}

async function validateSingleImageComposition(
  apiKey: string,
  imageBase64: string
) {
  const { response, result } = await callGeminiGenerateContent(
    apiKey,
    'gemini-2.5-flash',
    [
      {
        inline_data: {
          mime_type: 'image/png',
          data: imageBase64,
        },
      },
      {
        text: [
          'Inspect this generated fashion image.',
          'Answer with one word only: VALID or INVALID.',
          'Return VALID only if the image is a single coherent portrait photograph in 4:5 style composition, with one continuous scene and no split-screen or multi-panel layout.',
          'Return INVALID if the image looks like a collage, diptych, split-screen, side-by-side composition, mirrored layout, before/after comparison, multiple panels, or multiple framings stitched into one canvas.',
        ].join(' '),
      },
    ],
    ['TEXT']
  );

  if (!response.ok) {
    return true;
  }

  const verdict = getGeminiText(result).toUpperCase();
  return verdict.includes('VALID') && !verdict.includes('INVALID');
}

export async function POST(req: Request) {
  try {
    const {
      imageUrls,
      finalGenerationImageUrls,
      generationKind,
      garmentReferenceImageUrls,
      colorReferenceImageUrls,
      environmentReferenceImageUrls,
      targetColorLabel,
      prompt: userPrompt,
      productName,
      productDescription,
      requestOrigin,
    } = await req.json();
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || '';

    if (!apiKey) {
      return NextResponse.json({ error: 'Chiave API mancante nel file .env.local.' }, { status: 500 });
    }

    if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
      return NextResponse.json({ error: 'Nessuna immagine sorgente fornita.' }, { status: 400 });
    }

    const safeGarmentReferenceImageUrls =
      Array.isArray(garmentReferenceImageUrls) && garmentReferenceImageUrls.length > 0
        ? garmentReferenceImageUrls
        : imageUrls;
    const safeColorReferenceImageUrls =
      Array.isArray(colorReferenceImageUrls) && colorReferenceImageUrls.length > 0
        ? colorReferenceImageUrls
        : safeGarmentReferenceImageUrls;
    const safeEnvironmentReferenceImageUrls =
      Array.isArray(environmentReferenceImageUrls) && environmentReferenceImageUrls.length > 0
        ? environmentReferenceImageUrls
        : [];
    const uniqueImageUrls = Array.from(
      new Set<string>([
        ...imageUrls,
        ...safeGarmentReferenceImageUrls,
        ...safeColorReferenceImageUrls,
        ...safeEnvironmentReferenceImageUrls,
      ])
    );
    const imagePartEntries = await Promise.all(
      uniqueImageUrls.map(async (imageUrl: string) => [
        imageUrl,
        await loadInlineImagePart(imageUrl, requestOrigin),
      ] as const)
    );
    const imagePartMap = new Map<string, GeminiRequestPart>(imagePartEntries);
    const imageParts = imageUrls
      .map((imageUrl: string) => imagePartMap.get(imageUrl))
      .filter((part): part is GeminiRequestPart => Boolean(part));
    const finalGenerationParts =
      Array.isArray(finalGenerationImageUrls) && finalGenerationImageUrls.length > 0
        ? finalGenerationImageUrls
            .map((imageUrl: string) => imagePartMap.get(imageUrl))
            .filter((part): part is GeminiRequestPart => Boolean(part))
        : imageParts;
    const garmentReferenceParts = safeGarmentReferenceImageUrls
      .map((imageUrl: string) => imagePartMap.get(imageUrl))
      .filter((part): part is GeminiRequestPart => Boolean(part));
    const colorReferenceParts = safeColorReferenceImageUrls
      .map((imageUrl: string) => imagePartMap.get(imageUrl))
      .filter((part): part is GeminiRequestPart => Boolean(part));
    const environmentReferenceParts = safeEnvironmentReferenceImageUrls
      .map((imageUrl: string) => imagePartMap.get(imageUrl))
      .filter((part): part is GeminiRequestPart => Boolean(part));

    const safeUserPrompt = String(userPrompt || '')
      .replace(/mesi/gi, 'months size')
      .replace(/anni/gi, 'years size')
      .replace(/maschio/gi, 'masculine styling')
      .replace(/femmina/gi, 'feminine styling')
      .replace(/bambino/gi, 'small child model')
      .replace(/bambina/gi, 'small child model');
    const safeProductName = String(productName || '').trim();
    const safeProductDescription = stripHtmlToPlainText(String(productDescription || '')).slice(0, 1200);
    const safeTargetColorLabel = String(targetColorLabel || '').trim();
    const safeGenerationKind = String(generationKind || '').trim().toLowerCase();
    const finalImageModel = 'gemini-2.0-flash-preview-image-generation';

    let garmentFidelityLockProfile = '';
    let extractedColorLockProfile = '';
    let environmentLockProfile = '';

    try {
      const garmentAnalysisPrompt = [
        'Analyze only the target garment from the provided original product reference image(s).',
        safeProductName
          ? `The target garment is the product titled "${safeProductName}". Ignore any other garment, prop, or accessory.`
          : '',
        'Ignore any semantic cues in the product title such as color names, cities, animals, flowers, moods, characters, or seasons unless they are clearly visible in the garment itself.',
        'Ignore any person, face, body, mannequin, background, and styling context.',
        'Return only a concise garment fidelity lock profile in English with these exact sections: Core silhouette; Visible construction details; Visible decorative details; Explicitly absent details.',
        'Only mention details that are clearly visible in the product references.',
        'If a decorative detail is not clearly visible, do not promote it to present.',
        'In "Explicitly absent details", list only clearly absent details among common invention risks such as bow, sash, waistband ribbon, decorative belt, contrast trim, ruffles, lace, embroidery, print, pockets, buttons, and extra decorative pieces.',
        safeProductDescription
          ? `Supporting product description context: ${safeProductDescription}. Use this text only to confirm garment intent when it matches the visible references. Never let the text add a detail that is not visible in the images.`
          : '',
        'This profile will be used as a hard lock for image generation, so be strict and literal.',
      ]
        .filter(Boolean)
        .join(' ');

      const { response: garmentAnalysisResponse, result: garmentAnalysisResult } =
        await callGeminiGenerateContent(
          apiKey,
          'gemini-2.5-flash',
          [...garmentReferenceParts, { text: garmentAnalysisPrompt }],
          ['TEXT']
        );

      if (garmentAnalysisResponse.ok) {
        garmentFidelityLockProfile = getGeminiText(garmentAnalysisResult);
      } else {
        console.error('Errore Gemini garment analysis:', garmentAnalysisResult);
      }
    } catch (error) {
      console.error('Errore estrazione profilo garment fidelity:', error);
    }

    try {
      const colorAnalysisPrompt = [
        'Analyze only the garment color from the provided dedicated target-color reference image(s).',
        'Ignore any text label, category name, or product naming as a source of color truth.',
        safeTargetColorLabel
          ? `The label "${safeTargetColorLabel}" is provided only to identify which references belong to the requested colorway. Do not trust the wording of that label for the actual shade.`
          : '',
        safeProductName
          ? `If other garments or visual elements appear, isolate only the garment matching the product title "${safeProductName}".`
          : '',
        'Ignore any visible person, skin, hair, background, set design, and lighting cast as much as possible.',
        'Look only at the garment fabric pixels.',
        'Return only a concise exact color lock profile in English: primary hue, undertone, saturation, brightness/value, depth, and any clearly visible secondary tone or trim.',
        'Be literal and precise. Do not describe mood, styling, the model, or the scene.',
      ]
        .filter(Boolean)
        .join(' ');

      const { response: colorAnalysisResponse, result: colorAnalysisResult } =
        await callGeminiGenerateContent(
          apiKey,
          'gemini-2.5-flash',
          [...colorReferenceParts, { text: colorAnalysisPrompt }],
          ['TEXT']
        );

      if (colorAnalysisResponse.ok) {
        extractedColorLockProfile = getGeminiText(colorAnalysisResult);
      } else {
        console.error('Errore Gemini color analysis:', colorAnalysisResult);
      }
    } catch (error) {
      console.error('Errore estrazione profilo colore:', error);
    }

    try {
      if (environmentReferenceParts.length > 0) {
        const environmentAnalysisPrompt = [
          'Analyze only the environment and scene design from the provided ambientazione reference image(s).',
          'Ignore every garment, accessory, child, adult, face, and body completely.',
          'Return only a concise environment lock profile in English: background; lighting; mood; props; spatial cues; natural action suggestions.',
          'This profile must describe only the scene and never any clothing detail.',
        ].join(' ');

        const { response: environmentAnalysisResponse, result: environmentAnalysisResult } =
          await callGeminiGenerateContent(
            apiKey,
            'gemini-2.5-flash',
            [...environmentReferenceParts, { text: environmentAnalysisPrompt }],
            ['TEXT']
          );

        if (environmentAnalysisResponse.ok) {
          environmentLockProfile = getGeminiText(environmentAnalysisResult);
        } else {
          console.error('Errore Gemini environment analysis:', environmentAnalysisResult);
        }
      }
    } catch (error) {
      console.error('Errore estrazione profilo ambientazione:', error);
    }

    const finalPrompt = [
      'Follow this process exactly.',
      'Step 1: identify and isolate only the target garment.',
      'Step 2: lock garment construction and garment details using only the dedicated original product references and the garment fidelity profile below.',
      'Step 3: lock the garment color using only the dedicated target-color reference images and the extracted color profile below.',
      'Step 4: if an ambientazione reference exists, use it only to lock scene/background guidance and never garment details.',
      'Step 5: generate the new image while preserving every lock faithfully.',
      'Create a professional e-commerce fashion photo.',
      'The final output must be a single portrait image in a strict 4:5 aspect ratio.',
      'Use the provided product image(s) as the exact garment reference.',
      'Any mention of "capo" or garment means the clothing item only, never the head, face, or any body part.',
      safeProductName ? `The only garment to interpret is the product titled "${safeProductName}".` : '',
      'If any source image contains multiple garments, multiple products, or multiple outfits, isolate only the garment that matches the target product title and ignore every other garment completely.',
      'If any source image contains a person, face, child, mannequin, or body part, ignore that subject completely and use only the garment as reference.',
      'The person shown in any reference image must never be reused as the output model.',
      'Do not copy or preserve the reference face, skin tone, hair, body shape, age appearance, or ethnicity from any source image.',
      'Treat any human subject visible in the references as a forbidden source for identity. Their face, hairstyle, skin tone, age appearance, body shape, and ethnicity must not be reproduced.',
      'The output person must look clearly different from any person visible in the references.',
      'If a reference image shows the garment worn by a real child or model, mentally crop out only the clothing item and discard the wearer completely.',
      'Do not preserve the same child, do not create a lookalike, and do not keep the same face or ethnicity as the wearer in the reference image.',
      'The output model must be a completely new person generated only from the written styling requirements.',
      'If the reference model appearance conflicts with the written styling requirements, always follow the written styling requirements and ignore the reference model.',
      'Never merge details from different garments seen in the references.',
      'Do not copy or preserve any human identity from the source images.',
      'Preserve the garment faithfully: color, fabric, cut, patterns, trims, and proportions must match the source images.',
      'Scenario words, city names, product-title wording, activity names, and styling language must never rewrite the garment.',
      'Never infer bows, trim colors, print subjects, pattern content, decorative motifs, or garment construction from the scene, the city, the product title, or any contextual wording.',
      garmentFidelityLockProfile
        ? `Mandatory garment fidelity lock profile from the original product references: ${garmentFidelityLockProfile}.`
        : 'No separate garment fidelity profile could be extracted, so use only the original product references as the hard source of truth for garment construction and details.',
      'Treat the garment fidelity lock profile above as mandatory and higher priority than the anchor image, scene references, styling language, or any plausible fashion assumption.',
      'Any detail listed as absent, missing, or not present in the garment fidelity lock profile is forbidden in the output.',
      'Do not invent or hallucinate decorative details, especially bows, waist ribbons, belts, contrast trims, extra seams, embroidery, prints, or ornamental pieces.',
      'If there is any uncertainty, simplify and omit. Never add.',
      safeProductDescription
        ? `Supporting imported WooCommerce product description: ${safeProductDescription}. Use this text only as secondary context when it matches the visible references. It can confirm intent, but it must never override the garment fidelity lock, the visible references, or introduce hidden details.`
        : '',
      safeTargetColorLabel
        ? `Requested color label for routing only: "${safeTargetColorLabel}".`
        : '',
      'The color label, category wording, and product naming are never valid visual evidence for the final hue.',
      extractedColorLockProfile
        ? `Mandatory extracted color lock profile from the dedicated target-color reference images: ${extractedColorLockProfile}.`
        : 'No separate color profile could be extracted, so use only the exact visible garment color in the dedicated target-color reference images as the source of truth.',
      'Treat the extracted color lock profile above as mandatory and higher priority than any color wording in the styling instructions.',
      'Do not reinterpret, stylize, approximate, warm up, cool down, brighten, mute, or shift the garment color based on the wording of the color name.',
      'Do not infer color from the label text. Extract it from the garment pixels in the matching target-color references only.',
      'If the text suggests one shade but the matching color reference images show another exact shade, always obey the visible shade from the matching color reference images.',
      'Keep the garment base hue, undertone, saturation, brightness, and depth as close as possible to the locked reference color, even if the scene lighting changes.',
      environmentLockProfile
        ? `Supporting environment lock profile from the ambientazione reference images: ${environmentLockProfile}. Use it only for background, lighting, props, and natural action. It must never change garment construction, garment details, or garment color.`
        : '',
      'If the styling requirements mention a specific city or location, obey that exact location and do not replace it with Milan or any other city.',
      'If the requested location is not Milan, defaulting to Milan is forbidden.',
      'Environment, props, and city identity must never recolor the garment, change bow or trim colors, or introduce a pattern or decorative detail that is not present in the locked references.',
      'Be absolutely faithful to the garment in the references. Never invent, add, redesign, embellish, or stylize garment details.',
      'Do not add any garment feature that is not clearly visible in the references, including bows, ruffles, pleats, buttons, belts, pockets, trims, embroidery, stitching, prints, logos, extra seams, collars, sleeves, ties, or accessories.',
      'If a detail is unclear or missing in the references, omit it instead of guessing.',
      'Keep the full model and garments comfortably inside the frame, with clear safety margin on all four sides.',
      'Leave roughly 8 to 12 percent breathing room around the subject for potential frontend cropping, and avoid tight edge-to-edge framing.',
      'Return exactly one single final image only.',
      'Never return a collage, diptych, split-screen, side-by-side comparison, before/after composition, contact sheet, mirrored composition, or any multi-panel output.',
      'Do not place two crops, two framings, or two versions of the model in the same image.',
      'Do not split the canvas into left and right sections, and do not combine a full-body shot with a close-up in one frame.',
      'The output must be a single coherent camera shot with one subject and one continuous background.',
      'Respect any front, back, and side reference labels strictly.',
      'Use the labeled references only to understand the correct visible side of the garment for the requested pose.',
      'For a back shot, the model must turn away from the camera and show the back of the garment as the dominant visible side. A front-facing back shot is invalid.',
      'If an anchor image is present among the provided images, use it only for identity, expression, framing, and continuity. It must never override the garment fidelity lock profile or the color lock profile.',
      'Generate a new realistic full-body fashion model based only on the written styling instructions.',
      'The model should appear moderately happy, with a visible soft natural smile and a pleasant positive expression, including in clean catalog poses.',
      'Avoid exaggerated laughter, theatrical expressions, or an emotionless blank face.',
      'Return a clean catalog-ready commercial image with realistic lighting and natural body proportions.',
      'Any color wording inside the styling requirements below is only routing metadata. It must never override the extracted color lock profile or the visible garment color in the target-color references.',
      `Styling requirements: ${safeUserPrompt}`,
    ]
      .filter(Boolean)
      .join(' ');

    let generatedImageBase64 = '';
    let lastImageResult: GeminiResponse | null = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const attemptPrompt = [
        finalPrompt,
        attempt > 0
          ? 'The previous attempt was rejected because it looked like a split-screen or multi-panel composition. Regenerate as one single standalone portrait photo only, with one subject, one scene, and one continuous background.'
          : '',
      ]
        .filter(Boolean)
        .join(' ');

      const { response: imageResponse, result: imageResult } =
        await callGeminiGenerateContent(
          apiKey,
          finalImageModel,
          [...finalGenerationParts, { text: attemptPrompt }],
          ['TEXT', 'IMAGE'],
          {
            aspectRatio: '3:4',
          }
        );

      lastImageResult = imageResult;

      if (!imageResponse.ok) {
        console.error('Errore Gemini image generation:', imageResult);
        return NextResponse.json(
          {
            error: `Errore Google (${imageResponse.status}): ${imageResult.error?.message || 'Errore sconosciuto'}`,
          },
          { status: imageResponse.status }
        );
      }

      const candidateImageBase64 = getGeminiImageData(imageResult);
      const textExplanation = getGeminiText(imageResult);

      if (!candidateImageBase64) {
        console.error('Risposta Gemini senza immagine:', JSON.stringify(imageResult));
        return NextResponse.json(
          {
            error:
              textExplanation ||
              'Gemini ha risposto senza un output immagine. Verifica che la chiave API abbia accesso ai modelli image e che il prompt non venga filtrato.',
          },
          { status: 500 }
        );
      }

      const isSingleImage = await validateSingleImageComposition(apiKey, candidateImageBase64);

      if (isSingleImage || attempt === 2) {
        generatedImageBase64 = candidateImageBase64;
        break;
      }
    }

    if (!generatedImageBase64) {
      console.error('Impossibile ottenere un output immagine valido:', JSON.stringify(lastImageResult));
      return NextResponse.json(
        {
          error:
            'Gemini continua a restituire un layout non valido (split-screen o multi-panel). Riprova la generazione.',
        },
        { status: 500 }
      );
    }

    return NextResponse.json({ image: generatedImageBase64 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Errore sconosciuto';
    console.error('Errore Interno:', error);
    return NextResponse.json({ error: `Errore Interno: ${message}` }, { status: 500 });
  }
}
