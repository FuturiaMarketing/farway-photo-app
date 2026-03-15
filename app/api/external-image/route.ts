import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const remoteImageFetchTimeoutMs = 25_000;
const maxRetries = 2;

async function fetchWithTimeout(url: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), remoteImageFetchTimeoutMs);

  try {
    return await fetch(url, {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (compatible; FarwayPhotoApp/1.0; +https://farwaymilano.com)',
      },
      signal: controller.signal,
      next: { revalidate: 86_400 },
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const target = String(searchParams.get('url') || '').trim();

  if (!target) {
    return NextResponse.json({ error: 'Parametro url mancante.' }, { status: 400 });
  }

  let targetUrl: URL;

  try {
    targetUrl = new URL(target);
  } catch {
    return NextResponse.json({ error: 'URL immagine non valido.' }, { status: 400 });
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return NextResponse.json({ error: 'Protocollo immagine non supportato.' }, { status: 400 });
  }

  let lastError = 'Errore sconosciuto nel proxy immagine.';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(targetUrl.toString());

      if (!response.ok) {
        // For client errors (4xx) don't retry — the URL itself is bad.
        if (response.status >= 400 && response.status < 500) {
          return NextResponse.json(
            { error: `Immagine remota non disponibile (${response.status}).` },
            { status: response.status }
          );
        }

        // For server errors, retry.
        lastError = `Immagine remota non disponibile (${response.status}).`;
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
          continue;
        }

        return NextResponse.json({ error: lastError }, { status: response.status });
      }

      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const buffer = await response.arrayBuffer();

      return new NextResponse(buffer, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (error: unknown) {
      const isAbortError = error instanceof DOMException && error.name === 'AbortError';
      lastError = isAbortError
        ? 'Timeout nel download immagine remota.'
        : error instanceof Error
          ? error.message
          : 'Errore sconosciuto nel proxy immagine.';

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        continue;
      }
    }
  }

  return NextResponse.json({ error: lastError }, { status: 502 });
}
