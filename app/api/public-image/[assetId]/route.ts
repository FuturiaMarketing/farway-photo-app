import { NextResponse } from 'next/server';
import { readBinaryAssetById } from '@/lib/server/db';

type RouteContext = {
  params: Promise<{
    assetId: string;
  }>;
};

export async function GET(_: Request, context: RouteContext) {
  const { assetId } = await context.params;
  const asset = await readBinaryAssetById(assetId);

  if (!asset) {
    return NextResponse.json({ error: 'Immagine non trovata.' }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(asset.bytes), {
    headers: {
      'Content-Type': asset.mimeType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
