import { NextResponse } from 'next/server';
import { hasDatabaseConnection, readJsonValue, writeJsonValue } from '@/lib/server/db';

type StoredProductSession = {
  session: Record<string, unknown>;
  generatedResults: Array<{
    key: string;
    kind: string;
    pose: string;
    color: string;
    url: string;
  }>;
};

const namespace = 'product_sessions';

function buildKey(projectId: string, productId: string) {
  return `${projectId}:${productId}`;
}

function normalizeGeneratedResults(input: unknown) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const candidate = item as Record<string, unknown>;
      const key = String(candidate.key || '').trim();
      const kind = String(candidate.kind || '').trim();
      const pose = String(candidate.pose || '').trim();
      const color = String(candidate.color || '').trim();
      const url = String(candidate.url || '').trim();

      if (!key || !kind || !pose || !url) {
        return null;
      }

      return { key, kind, pose, color, url };
    })
    .filter(
      (
        item
      ): item is {
        key: string;
        kind: string;
        pose: string;
        color: string;
        url: string;
      } => Boolean(item)
    );
}

function normalizeStoredSession(input: unknown): StoredProductSession {
  if (!input || typeof input !== 'object') {
    return {
      session: {},
      generatedResults: [],
    };
  }

  const candidate = input as Partial<StoredProductSession>;

  return {
    session:
      candidate.session && typeof candidate.session === 'object'
        ? (candidate.session as Record<string, unknown>)
        : {},
    generatedResults: normalizeGeneratedResults(candidate.generatedResults),
  };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const projectId = String(searchParams.get('projectId') || '').trim();
    const productId = String(searchParams.get('productId') || '').trim();

    if (!projectId || !productId) {
      return NextResponse.json({ error: 'projectId e productId sono obbligatori.' }, { status: 400 });
    }

    if (!hasDatabaseConnection()) {
      return NextResponse.json(normalizeStoredSession(null));
    }

    const value = await readJsonValue<StoredProductSession>(namespace, buildKey(projectId, productId));
    return NextResponse.json(normalizeStoredSession(value));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Errore sconosciuto';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      projectId?: string;
      productId?: string | number;
      session?: unknown;
      generatedResults?: unknown;
    };

    const projectId = String(body.projectId || '').trim();
    const productId = String(body.productId || '').trim();

    if (!projectId || !productId) {
      return NextResponse.json({ error: 'projectId e productId sono obbligatori.' }, { status: 400 });
    }

    if (!hasDatabaseConnection()) {
      return NextResponse.json({ error: 'DATABASE_URL non configurata.' }, { status: 500 });
    }

    const payload = normalizeStoredSession({
      session:
        body.session && typeof body.session === 'object'
          ? (body.session as Record<string, unknown>)
          : {},
      generatedResults: body.generatedResults,
    });

    await writeJsonValue(namespace, buildKey(projectId, productId), payload);

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Errore sconosciuto';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
