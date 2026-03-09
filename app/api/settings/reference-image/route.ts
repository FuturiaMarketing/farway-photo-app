import { NextResponse } from 'next/server';
import { hasDatabaseConnection, writeBinaryAsset } from '@/lib/server/db';

function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);

  if (!match) {
    return null;
  }

  return {
    mimeType: match[1],
    data: match[2],
  };
}

function getFileExtension(mimeType: string) {
  if (mimeType.includes('jpeg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';
  return 'png';
}

function sanitizeFileName(value: string) {
  return (
    String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'image'
  );
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      projectId?: string;
      settingId?: string;
      dataUrl?: string;
      namespace?: string;
      fileName?: string;
    };

    const projectId = String(body.projectId || '').trim();
    const settingId = String(body.settingId || '').trim();
    const dataUrl = String(body.dataUrl || '').trim();
    const namespace = String(body.namespace || 'ambientazioni-references').trim();
    const requestedFileName = String(body.fileName || '').trim();

    if (!projectId || !settingId || !dataUrl || !namespace) {
      return NextResponse.json(
        { error: 'projectId, settingId, namespace e dataUrl sono obbligatori.' },
        { status: 400 }
      );
    }

    const parsed = parseDataUrl(dataUrl);

    if (!parsed) {
      return NextResponse.json(
        { error: 'Formato immagine non valido.' },
        { status: 400 }
      );
    }

    if (!hasDatabaseConnection()) {
      return NextResponse.json({ url: dataUrl });
    }

    const extension = getFileExtension(parsed.mimeType);
    const baseFileName = sanitizeFileName(
      requestedFileName || `${projectId}-${settingId}.${extension}`
    ).replace(/\.[a-z0-9]+$/i, '');
    const finalFileName = `${baseFileName}.${extension}`;

    const assetId = await writeBinaryAsset({
      namespace,
      key: `${projectId}_${settingId}`,
      mimeType: parsed.mimeType,
      bytes: Buffer.from(parsed.data, 'base64'),
      metadata: {
        projectId,
        settingId,
        namespace,
        filename: finalFileName,
      },
    });

    return NextResponse.json({ url: `/api/public-image/${assetId}/${encodeURIComponent(finalFileName)}` });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Errore sconosciuto';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
