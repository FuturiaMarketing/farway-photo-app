import { NextResponse } from 'next/server';
import { ensureDatabaseSchema, hasDatabaseConnection, readBinaryAssetByKey, writeBinaryAsset } from '@/lib/server/db';

export const runtime = 'nodejs';

const remoteImageFetchTimeoutMs = 10_000;
const maxRetries = 2;
const cacheNamespace = 'ext-img-cache';

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

  const cacheKey = targetUrl.toString();

  // Check DB cache first — fast path, consistent across all devices/serverless instances.
  if (hasDatabaseConnection()) {
    try {
      await ensureDatabaseSchema();
      const cached = await readBinaryAssetByKey(cacheNamespace, cacheKey);

      if (cached) {
        return new NextResponse(new Uint8Array(cached.bytes), {
          headers: {
            'Content-Type': cached.mimeType,
            'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
            'Access-Control-Allow-Origin': '*',
            'X-Cache': 'HIT',
          },
        });
      }
    } catch {
      // DB unavailable — fall through to fetch from origin.
    }
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

      // Store in DB cache asynchronously — don't block the response.
      if (hasDatabaseConnection()) {
        writeBinaryAsset({
          namespace: cacheNamespace,
          key: cacheKey,
          mimeType: contentType,
          bytes: Buffer.from(buffer),
          metadata: { cachedAt: new Date().toISOString() },
        }).catch(() => {
          // Cache write failure is non-fatal.
        });
      }

      return new NextResponse(buffer, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
          'Access-Control-Allow-Origin': '*',
          'X-Cache': 'MISS',
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
