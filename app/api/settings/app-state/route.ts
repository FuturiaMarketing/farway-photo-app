import { NextResponse } from 'next/server';
import { hasDatabaseConnection, readJsonValue, writeJsonValue } from '@/lib/server/db';

type AmbientazioneSetting = {
  id: string;
  label: string;
  hasReferenceImage: boolean;
};

type AmbientazioneCollection = {
  studio: AmbientazioneSetting[];
  realLife: AmbientazioneSetting[];
};

type ProjectEntry = {
  id: string;
  name: string;
};

type PersistedAppState = {
  projects: ProjectEntry[];
  currentProjectId: string;
  shootingSettingsMap: Record<string, AmbientazioneCollection>;
  shootingReferenceImagesByProject: Record<string, Record<string, string>>;
  selectedProductByProject: Record<string, string>;
  startedProductIdsByProject: Record<string, number[]>;
  syncedProductIdsByProject: Record<string, number[]>;
  generatedProductIdsByProject: Record<string, number[]>;
  manualProductStatusesByProject: Record<string, Record<string, string>>;
};

const namespace = 'settings';
const key = 'app_state';

function normalizeSetting(input: unknown): AmbientazioneSetting | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Partial<AmbientazioneSetting>;
  const id = String(candidate.id || '').trim();
  const label = String(candidate.label || '').trim();

  if (!id || !label) {
    return null;
  }

  return {
    id,
    label,
    hasReferenceImage: Boolean(candidate.hasReferenceImage),
  };
}

function normalizeCollection(input: unknown): AmbientazioneCollection | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Partial<AmbientazioneCollection>;
  const studio = Array.isArray(candidate.studio)
    ? candidate.studio.map(normalizeSetting).filter((value): value is AmbientazioneSetting => Boolean(value))
    : [];
  const realLife = Array.isArray(candidate.realLife)
    ? candidate.realLife.map(normalizeSetting).filter((value): value is AmbientazioneSetting => Boolean(value))
    : [];

  return {
    studio,
    realLife,
  };
}

function normalizeState(input: unknown): PersistedAppState {
  if (!input || typeof input !== 'object') {
    return {
      projects: [],
      currentProjectId: 'default',
      shootingSettingsMap: {},
      shootingReferenceImagesByProject: {},
      selectedProductByProject: {},
      startedProductIdsByProject: {},
      syncedProductIdsByProject: {},
      generatedProductIdsByProject: {},
      manualProductStatusesByProject: {},
    };
  }

  const candidate = input as Partial<PersistedAppState>;

  const projects = Array.isArray(candidate.projects)
    ? candidate.projects
        .map((project) => {
          if (!project || typeof project !== 'object') {
            return null;
          }

          const id = String((project as Partial<ProjectEntry>).id || '').trim();
          const name = String((project as Partial<ProjectEntry>).name || '').trim();

          if (!id || !name) {
            return null;
          }

          return { id, name };
        })
        .filter((value): value is ProjectEntry => Boolean(value))
    : [];

  const shootingSettingsMap = Object.fromEntries(
    Object.entries(candidate.shootingSettingsMap || {})
      .map(([projectId, collection]) => [projectId, normalizeCollection(collection)])
      .filter((entry): entry is [string, AmbientazioneCollection] => Boolean(entry[1]))
  );

  const shootingReferenceImagesByProject = Object.fromEntries(
    Object.entries(candidate.shootingReferenceImagesByProject || {}).map(([projectId, references]) => [
      projectId,
      Object.fromEntries(
        Object.entries(references || {})
          .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[1].startsWith('data:'))
      ),
    ])
  );

  const normalizeNumberMap = (rawMap: unknown) =>
    Object.fromEntries(
      Object.entries((rawMap || {}) as Record<string, unknown>).map(([projectId, values]) => [
        projectId,
        Array.isArray(values)
          ? values
              .map((value) => Number(value))
              .filter((value) => Number.isInteger(value) && value > 0)
          : [],
      ])
    );

  const selectedProductByProject = Object.fromEntries(
    Object.entries(candidate.selectedProductByProject || {}).filter(
      (entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string'
    )
  );

  const manualProductStatusesByProject = Object.fromEntries(
    Object.entries(candidate.manualProductStatusesByProject || {}).map(([projectId, statuses]) => [
      projectId,
      Object.fromEntries(
        Object.entries((statuses || {}) as Record<string, unknown>).filter(
          (entry): entry is [string, string] =>
            typeof entry[0] === 'string' &&
            typeof entry[1] === 'string' &&
            ['auto', 'all', 'todo', 'in-progress', 'completed'].includes(entry[1])
        )
      ),
    ])
  );

  return {
    projects,
    currentProjectId: String(candidate.currentProjectId || 'default'),
    shootingSettingsMap,
    shootingReferenceImagesByProject,
    selectedProductByProject,
    startedProductIdsByProject: normalizeNumberMap(candidate.startedProductIdsByProject),
    syncedProductIdsByProject: normalizeNumberMap(candidate.syncedProductIdsByProject),
    generatedProductIdsByProject: normalizeNumberMap(candidate.generatedProductIdsByProject),
    manualProductStatusesByProject,
  };
}

export async function GET() {
  try {
    if (!hasDatabaseConnection()) {
      return NextResponse.json(normalizeState(null));
    }

    const value = await readJsonValue<PersistedAppState>(namespace, key);
    return NextResponse.json(normalizeState(value));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Errore sconosciuto';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    if (!hasDatabaseConnection()) {
      return NextResponse.json(
        { error: 'DATABASE_URL non configurata.' },
        { status: 500 }
      );
    }

    const body = await req.json();
    const normalized = normalizeState(body);

    await writeJsonValue(namespace, key, normalized);

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Errore sconosciuto';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
