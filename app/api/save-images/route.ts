import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { NextResponse } from 'next/server';

type SaveImageRequest = {
  projectName: string;
  productName: string;
  files: Array<{
    filename: string;
    dataUrl: string;
  }>;
};

function sanitizeSegment(value: string) {
  return (
    value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}

function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!match) return null;

  return {
    mimeType: match[1],
    base64: match[2],
  };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as SaveImageRequest;

    if (!body.projectName || !body.productName || !Array.isArray(body.files) || body.files.length === 0) {
      return NextResponse.json({ error: 'Richiesta di salvataggio non valida.' }, { status: 400 });
    }

    const projectDir = path.join(
      process.cwd(),
      'saved-projects',
      sanitizeSegment(body.projectName),
      sanitizeSegment(body.productName)
    );

    await mkdir(projectDir, { recursive: true });

    const savedFiles: string[] = [];

    for (const file of body.files) {
      const parsed = parseDataUrl(file.dataUrl);

      if (!parsed) {
        return NextResponse.json({ error: `Data URL non valido per ${file.filename}` }, { status: 400 });
      }

      const filePath = path.join(projectDir, path.basename(file.filename));
      await writeFile(filePath, Buffer.from(parsed.base64, 'base64'));
      savedFiles.push(filePath);
    }

    return NextResponse.json({ savedFiles });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Errore sconosciuto';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
