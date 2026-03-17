import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { NextResponse } from 'next/server';
import { hasDatabaseConnection, writeBinaryAsset } from '@/lib/server/db';
import { getResolvedWooCommerceSettings } from '@/lib/server/woocommerce-settings';

function parseDataUrl(dataUrl: string) {
  const match = String(dataUrl || '').match(/^data:(.+?);base64,(.+)$/);
  if (!match) return null;

  return {
    mimeType: match[1],
    base64: match[2],
  };
}

function sanitizeSegment(value: string) {
  return (
    String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}

function sanitizeFileName(value: string) {
  return (
    String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}

function getFileExtension(mimeType: string) {
  if (mimeType.includes('jpeg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  return 'png';
}

function buildPublicBaseUrl(req: Request) {
  return (
    process.env.APP_PUBLIC_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    new URL(req.url).origin
  ).replace(/\/$/, '');
}

function isLocalOnlyUrl(value: string) {
  try {
    const url = new URL(value);
    return ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname);
  } catch {
    return true;
  }
}

function buildPublicImageUrl(baseUrl: string, assetId: string, fileName: string) {
  return `${baseUrl}/api/public-image/${encodeURIComponent(assetId)}/${encodeURIComponent(fileName)}`;
}

type SyncCategoryCoverRequest = {
  categoryId?: number;
  categoryName?: string;
  imageDataUrl?: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as SyncCategoryCoverRequest;
    const categoryId = Number(body.categoryId || 0);
    const categoryName = String(body.categoryName || '').trim() || `category-${categoryId}`;
    const parsedImage = parseDataUrl(String(body.imageDataUrl || ''));
    const settings = await getResolvedWooCommerceSettings();
    const publicBaseUrl = buildPublicBaseUrl(req);

    if (!categoryId || categoryId <= 0) {
      return NextResponse.json({ error: 'categoryId non valido.' }, { status: 400 });
    }

    if (!parsedImage) {
      return NextResponse.json({ error: 'imageDataUrl non valido.' }, { status: 400 });
    }

    if (!settings) {
      return NextResponse.json(
        { error: 'Configurazione WooCommerce mancante. Salvala da Impostazioni WooCommerce.' },
        { status: 500 }
      );
    }

    if (isLocalOnlyUrl(publicBaseUrl)) {
      return NextResponse.json(
        {
          error:
            "L'app sta fornendo immagini da un URL locale non raggiungibile da WooCommerce. Imposta APP_PUBLIC_URL (o NEXT_PUBLIC_APP_URL) con un URL pubblico HTTPS.",
        },
        { status: 500 }
      );
    }

    const extension = getFileExtension(parsedImage.mimeType);
    const baseLabel = `cover-archivio-${sanitizeFileName(categoryName)}-${categoryId}`;
    const fileName = `${baseLabel}.${extension}`;
    const bytes = Buffer.from(parsedImage.base64, 'base64');
    let publicImageUrl = '';

    if (hasDatabaseConnection()) {
      const assetId = await writeBinaryAsset({
        namespace: 'category-cover-sync',
        key: `${sanitizeSegment(categoryName)}__${categoryId}__${Date.now()}`,
        mimeType: parsedImage.mimeType,
        bytes,
        metadata: {
          categoryId,
          categoryName,
          fileName,
        },
      });

      publicImageUrl = buildPublicImageUrl(publicBaseUrl, assetId, fileName);
    } else {
      const outputDir = path.join(process.cwd(), 'public', 'category-cover-sync');
      await mkdir(outputDir, { recursive: true });
      const absoluteFile = path.join(outputDir, fileName);
      await writeFile(absoluteFile, bytes);
      publicImageUrl = `${publicBaseUrl}/category-cover-sync/${encodeURIComponent(fileName)}`;
    }

    const cleanUrl = settings.storeUrl.replace(/\/$/, '');
    const authQuery = `consumer_key=${settings.consumerKey}&consumer_secret=${settings.consumerSecret}`;
    const endpoint = `${cleanUrl}/wp-json/wc/v3/products/categories/${categoryId}?${authQuery}`;
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: {
          src: publicImageUrl,
          alt: `Cover archivio ${categoryName}`,
          name: `Cover archivio ${categoryName}`,
        },
      }),
    });

    if (!response.ok) {
      const rawError = await response.text();
      return NextResponse.json(
        { error: `Aggiornamento categoria fallito: ${response.status} ${rawError}` },
        { status: response.status }
      );
    }

    return NextResponse.json({
      ok: true,
      categoryId,
      categoryName,
      imageUrl: publicImageUrl,
      backendUrl: `${cleanUrl}/wp-admin/term.php?taxonomy=product_cat&tag_ID=${categoryId}`,
      message: `Cover categoria aggiornata su WooCommerce (${categoryName}).`,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Errore sconosciuto';
    return NextResponse.json({ error: `Errore Interno: ${message}` }, { status: 500 });
  }
}
