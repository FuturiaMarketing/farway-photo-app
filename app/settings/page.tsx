"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft, GripVertical, ImagePlus, Pencil, Plus, Save, Trash2, X } from 'lucide-react';

type ProjectEntry = {
  id: string;
  name: string;
};

type WooCommerceSettings = {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
};

type AmbientazioneSetting = {
  id: string;
  label: string;
  hasReferenceImage: boolean;
};

type AmbientazioneCollection = {
  studio: AmbientazioneSetting[];
  realLife: AmbientazioneSetting[];
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

function createDefaultPersistedAppState(): PersistedAppState {
  return {
    projects: [{ id: 'default', name: 'Futuria' }],
    currentProjectId: 'default',
    shootingSettingsMap: {
      default: defaultAmbientazioniCollection,
    },
    shootingReferenceImagesByProject: {},
    selectedProductByProject: {},
    startedProductIdsByProject: {},
    syncedProductIdsByProject: {},
    generatedProductIdsByProject: {},
    manualProductStatusesByProject: {},
  };
}

type SettingsTab = 'settings' | 'shooting';
type ShootingSubTab = 'studio' | 'realLife';

const settingsDbName = 'futuria-settings-db';
const ambientazioniStoreName = 'ambientazioni-references';
const defaultStudioSettings: AmbientazioneSetting[] = [
  { id: 'default-studio-bianco', label: 'Studio sfondo bianco', hasReferenceImage: false },
  { id: 'default-studio-caldo', label: 'Studio sfondo neutro caldo', hasReferenceImage: false },
  { id: 'default-cameretta', label: 'Cameretta luminosa', hasReferenceImage: false },
  { id: 'default-parco', label: 'Parco soleggiato', hasReferenceImage: false },
  { id: 'default-spiaggia', label: 'Spiaggia sabbia chiara', hasReferenceImage: false },
];
const defaultRealLifeSettings: AmbientazioneSetting[] = [
  { id: 'default-nonni', label: 'A casa dei nonni', hasReferenceImage: false },
  { id: 'default-passeggiata', label: 'Passeggiata con mamma e papa', hasReferenceImage: false },
  { id: 'default-compleanno', label: 'Compleanno', hasReferenceImage: false },
  { id: 'default-domenica', label: 'Il vestito della domenica', hasReferenceImage: false },
  { id: 'default-gelato', label: "Una sera d'estate: gelato con gli amici", hasReferenceImage: false },
  { id: 'default-pranzi', label: 'Pranzi semplici ed eleganti', hasReferenceImage: false },
  { id: 'default-cerimonia', label: 'Cerimonia in famiglia', hasReferenceImage: false },
  { id: 'default-picnic', label: 'Picnic al parco', hasReferenceImage: false },
  { id: 'default-museo', label: 'Pomeriggio al museo', hasReferenceImage: false },
  { id: 'default-lago', label: 'Weekend al lago', hasReferenceImage: false },
];
const defaultAmbientazioniCollection: AmbientazioneCollection = {
  studio: defaultStudioSettings,
  realLife: defaultRealLifeSettings,
};

function createAmbientazioneSetting(label: string): AmbientazioneSetting {
  return {
    id: Math.random().toString(36).slice(2, 10),
    label,
    hasReferenceImage: false,
  };
}

function normalizeAmbientazioniMap(raw: string | null) {
  if (!raw) {
    return { default: defaultAmbientazioniCollection } as Record<string, AmbientazioneCollection>;
  }

  const normalizeList = (projectKey: string, settings: AmbientazioneSetting[] | string[] | undefined, fallback: AmbientazioneSetting[]) => {
    const normalizedExisting = Array.isArray(settings)
      ? settings.map((setting, index) =>
          typeof setting === 'string'
            ? {
                id: `${projectKey}-${index}-${setting.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
                label: setting,
                hasReferenceImage: false,
              }
            : {
                id: setting.id,
                label: setting.label,
                hasReferenceImage: Boolean(setting.hasReferenceImage),
              }
        )
      : [];
    const seenLabels = new Set(
      normalizedExisting.map((setting) => setting.label.trim().toLowerCase())
    );

    for (const fallbackSetting of fallback) {
      const normalizedLabel = fallbackSetting.label.trim().toLowerCase();

      if (!seenLabels.has(normalizedLabel)) {
        normalizedExisting.push({ ...fallbackSetting });
        seenLabels.add(normalizedLabel);
      }
    }

    return normalizedExisting;
  };

  const parsed = JSON.parse(raw) as Record<
    string,
    AmbientazioneCollection | AmbientazioneSetting[] | string[]
  >;

  return Object.fromEntries(
    Object.entries(parsed).map(([projectKey, settings]) => {
      if (Array.isArray(settings)) {
        return [
          projectKey,
          {
            studio: normalizeList(projectKey, settings, defaultStudioSettings),
            realLife: [...defaultRealLifeSettings],
          },
        ];
      }

      return [
        projectKey,
        {
          studio: normalizeList(projectKey, settings?.studio, defaultStudioSettings),
          realLife: normalizeList(projectKey, settings?.realLife, defaultRealLifeSettings),
        },
      ];
    })
  );
}

function openSettingsDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(settingsDbName, 1);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(ambientazioniStoreName)) {
        db.createObjectStore(ambientazioniStoreName, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function writeAmbientazioneReference(projectId: string, settingId: string, dataUrl: string) {
  const db = await openSettingsDb();
  const key = `${projectId}:${settingId}`;

  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(ambientazioniStoreName, 'readwrite');
    const store = transaction.objectStore(ambientazioniStoreName);
    const request = store.put({ key, dataUrl });

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function uploadAmbientazioneReference(projectId: string, settingId: string, dataUrl: string) {
  const res = await fetch('/api/settings/reference-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId,
      settingId,
      dataUrl,
    }),
  });

  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error || 'Upload immagine reference fallito');
  }

  const data = (await res.json()) as { url?: string };
  return String(data.url || dataUrl);
}

async function deleteAmbientazioneReference(projectId: string, settingId: string) {
  const db = await openSettingsDb();
  const key = `${projectId}:${settingId}`;

  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(ambientazioniStoreName, 'readwrite');
    const store = transaction.objectStore(ambientazioniStoreName);
    const request = store.delete(key);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function readAllAmbientazioneReferences() {
  const db = await openSettingsDb();

  return new Promise<Record<string, Record<string, string>>>((resolve, reject) => {
    const transaction = db.transaction(ambientazioniStoreName, 'readonly');
    const store = transaction.objectStore(ambientazioniStoreName);
    const request = store.getAll();

    request.onsuccess = () => {
      const records = (request.result || []) as Array<{ key: string; dataUrl: string }>;
      const nestedMap: Record<string, Record<string, string>> = {};

      for (const record of records) {
        if (!record?.key || !record?.dataUrl) continue;

        const separatorIndex = record.key.indexOf(':');
        if (separatorIndex === -1) continue;

        const projectId = record.key.slice(0, separatorIndex);
        const settingId = record.key.slice(separatorIndex + 1);

        if (!projectId || !settingId) continue;

        if (!nestedMap[projectId]) {
          nestedMap[projectId] = {};
        }

        nestedMap[projectId][settingId] = record.dataUrl;
      }

      resolve(nestedMap);
    };
    request.onerror = () => reject(request.error);
  });
}

function mergeAppState(localState: Partial<PersistedAppState>, remoteState: PersistedAppState) {
  const projects =
    localState.projects && localState.projects.length > 0
      ? localState.projects
      : remoteState.projects.length > 0
        ? remoteState.projects
        : createDefaultPersistedAppState().projects;

  return {
    ...remoteState,
    projects,
    currentProjectId:
      localState.currentProjectId || remoteState.currentProjectId || createDefaultPersistedAppState().currentProjectId,
    shootingSettingsMap: {
      ...remoteState.shootingSettingsMap,
      ...(localState.shootingSettingsMap || {}),
    },
    shootingReferenceImagesByProject: {
      ...remoteState.shootingReferenceImagesByProject,
      ...(localState.shootingReferenceImagesByProject || {}),
    },
    selectedProductByProject: {
      ...remoteState.selectedProductByProject,
      ...(localState.selectedProductByProject || {}),
    },
    startedProductIdsByProject: {
      ...remoteState.startedProductIdsByProject,
      ...(localState.startedProductIdsByProject || {}),
    },
    syncedProductIdsByProject: {
      ...remoteState.syncedProductIdsByProject,
      ...(localState.syncedProductIdsByProject || {}),
    },
    generatedProductIdsByProject: {
      ...remoteState.generatedProductIdsByProject,
      ...(localState.generatedProductIdsByProject || {}),
    },
    manualProductStatusesByProject: {
      ...remoteState.manualProductStatusesByProject,
      ...(localState.manualProductStatusesByProject || {}),
    },
  } satisfies PersistedAppState;
}

async function readRemoteAppState() {
  try {
    const res = await fetch('/api/settings/app-state', { cache: 'no-store' });
    if (!res.ok) {
      return createDefaultPersistedAppState();
    }

    const data = (await res.json()) as PersistedAppState;
    return {
      ...createDefaultPersistedAppState(),
      ...data,
    };
  } catch {
    return createDefaultPersistedAppState();
  }
}

async function saveRemoteAppState(state: PersistedAppState) {
  try {
    await fetch('/api/settings/app-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
  } catch {
    // Keep local state even if remote sync fails.
  }
}

export default function SettingsPage() {
  const [projects, setProjects] = useState<ProjectEntry[]>([{ id: 'default', name: 'Futuria' }]);
  const [projectId, setProjectId] = useState('default');
  const [projectName, setProjectName] = useState('Futuria');
  const [activeTab, setActiveTab] = useState<SettingsTab>('shooting');
  const [activeShootingSubTab, setActiveShootingSubTab] = useState<ShootingSubTab>('studio');
  const [hasLoadedLocalSettings, setHasLoadedLocalSettings] = useState(false);
  const [shootingSettingsMap, setShootingSettingsMap] = useState<Record<string, AmbientazioneCollection>>({
    default: defaultAmbientazioniCollection,
  });
  const [shootingReferenceImagesByProject, setShootingReferenceImagesByProject] = useState<
    Record<string, Record<string, string>>
  >({});
  const [shootingDraft, setShootingDraft] = useState('');
  const [draggedShootingIndex, setDraggedShootingIndex] = useState<number | null>(null);
  const [editingShootingIndex, setEditingShootingIndex] = useState<number | null>(null);
  const [editingShootingValue, setEditingShootingValue] = useState('');
  const [wooSettings, setWooSettings] = useState<WooCommerceSettings>({
    storeUrl: '',
    consumerKey: '',
    consumerSecret: '',
  });
  const [persistedMetaState, setPersistedMetaState] = useState<
    Pick<
      PersistedAppState,
      | 'selectedProductByProject'
      | 'startedProductIdsByProject'
      | 'syncedProductIdsByProject'
      | 'generatedProductIdsByProject'
      | 'manualProductStatusesByProject'
    >
  >({
    selectedProductByProject: {},
    startedProductIdsByProject: {},
    syncedProductIdsByProject: {},
    generatedProductIdsByProject: {},
    manualProductStatusesByProject: {},
  });
  const [isSavingWooSettings, setIsSavingWooSettings] = useState(false);
  const [wooSettingsMessage, setWooSettingsMessage] = useState<string | null>(null);

  useEffect(() => {
    const loadInitialState = async () => {
      const rawProjects = window.localStorage.getItem('futuria-projects');
      const rawCurrent = window.localStorage.getItem('futuria-current-project-id');
      const rawShootingSettings = window.localStorage.getItem('futuria-shooting-settings');
      const localReferences = await readAllAmbientazioneReferences().catch(() => ({}));
      const remoteState = await readRemoteAppState();
      let localProjects: ProjectEntry[] = [];
      let localShootingSettings: Record<string, AmbientazioneCollection> = {};

      if (rawProjects) {
        try {
          localProjects = JSON.parse(rawProjects) as ProjectEntry[];
        } catch {
          localProjects = [];
        }
      }

      if (rawShootingSettings) {
        try {
          localShootingSettings = normalizeAmbientazioniMap(rawShootingSettings);
        } catch {
          localShootingSettings = {};
        }
      }

      const localState: Partial<PersistedAppState> = {
        projects: localProjects,
        currentProjectId: rawCurrent || '',
        shootingSettingsMap: localShootingSettings,
        shootingReferenceImagesByProject: localReferences,
      };

      const mergedState = mergeAppState(localState, remoteState);
      const safeProjects =
        mergedState.projects.length > 0 ? mergedState.projects : createDefaultPersistedAppState().projects;
      const current =
        safeProjects.find((project) => project.id === mergedState.currentProjectId) || safeProjects[0];

      setProjects(safeProjects);
      setProjectId(current.id);
      setProjectName(current.name);
      setShootingSettingsMap(mergedState.shootingSettingsMap);
      setShootingReferenceImagesByProject(mergedState.shootingReferenceImagesByProject);
      setPersistedMetaState({
        selectedProductByProject: mergedState.selectedProductByProject,
        startedProductIdsByProject: mergedState.startedProductIdsByProject,
        syncedProductIdsByProject: mergedState.syncedProductIdsByProject,
        generatedProductIdsByProject: mergedState.generatedProductIdsByProject,
        manualProductStatusesByProject: mergedState.manualProductStatusesByProject,
      });

      try {
        const res = await fetch('/api/settings/woocommerce');
        if (res.ok) {
          const data = (await res.json()) as WooCommerceSettings;
          setWooSettings(data);
        }
      } catch {
        // Ignore initial load failure.
      }

      setHasLoadedLocalSettings(true);
      void saveRemoteAppState(mergedState);
    };

    void loadInitialState();
  }, []);

  useEffect(() => {
    if (!hasLoadedLocalSettings) return;
    window.localStorage.setItem('futuria-projects', JSON.stringify(projects));
    window.localStorage.setItem('futuria-current-project-id', projectId);
    window.localStorage.setItem('futuria-shooting-settings', JSON.stringify(shootingSettingsMap));
    void saveRemoteAppState({
      ...createDefaultPersistedAppState(),
      projects,
      currentProjectId: projectId,
      shootingSettingsMap,
      shootingReferenceImagesByProject,
      ...persistedMetaState,
    });
  }, [hasLoadedLocalSettings, persistedMetaState, projectId, projects, shootingReferenceImagesByProject, shootingSettingsMap]);

  const switchProject = (nextProjectId: string) => {
    const nextProject = projects.find((project) => project.id === nextProjectId);
    if (!nextProject) return;

    setProjectId(nextProject.id);
    setProjectName(nextProject.name);
  };

  const saveProject = () => {
    const trimmedName = projectName.trim();
    if (!trimmedName) return;

    setProjects((prev) => {
      const existing = prev.find((project) => project.id === projectId);

      if (existing) {
        return prev.map((project) => (project.id === projectId ? { ...project, name: trimmedName } : project));
      }

      return [...prev, { id: projectId, name: trimmedName }];
    });
  };

  const createProject = () => {
    const nextId = Math.random().toString(36).slice(2, 10);
    const nextName = `Nuovo Brand ${projects.length + 1}`;

    setProjects((prev) => [...prev, { id: nextId, name: nextName }]);
    setShootingSettingsMap((prev) => ({
      ...prev,
      [nextId]: {
        studio: [...defaultStudioSettings],
        realLife: [...defaultRealLifeSettings],
      },
    }));
    setProjectId(nextId);
    setProjectName(nextName);
  };

  const projectAmbientazioni = shootingSettingsMap[projectId] || defaultAmbientazioniCollection;
  const currentShootingSettings = projectAmbientazioni[activeShootingSubTab];
  const shootingReferenceImages = shootingReferenceImagesByProject[projectId] || {};

  const addShootingSetting = () => {
    const trimmed = shootingDraft.trim();
    if (!trimmed) return;

    setShootingSettingsMap((prev) => ({
      ...prev,
      [projectId]: {
        ...projectAmbientazioni,
        [activeShootingSubTab]: [...currentShootingSettings, createAmbientazioneSetting(trimmed)],
      },
    }));
    setShootingDraft('');
  };

  const startEditingShootingSetting = (index: number) => {
    setEditingShootingIndex(index);
    setEditingShootingValue(currentShootingSettings[index]?.label || '');
  };

  const saveEditingShootingSetting = () => {
    if (editingShootingIndex === null) return;

    const trimmed = editingShootingValue.trim();
    if (!trimmed) return;

    setShootingSettingsMap((prev) => ({
      ...prev,
      [projectId]: {
        ...projectAmbientazioni,
        [activeShootingSubTab]: currentShootingSettings.map((setting, settingIndex) =>
          settingIndex === editingShootingIndex ? { ...setting, label: trimmed } : setting
        ),
      },
    }));

    setEditingShootingIndex(null);
    setEditingShootingValue('');
  };

  const removeShootingSetting = (index: number) => {
    const settingToRemove = currentShootingSettings[index];
    const nextSettings = currentShootingSettings.filter((_, settingIndex) => settingIndex !== index);

    setShootingSettingsMap((prev) => ({
      ...prev,
      [projectId]: {
        ...projectAmbientazioni,
        [activeShootingSubTab]:
          nextSettings.length > 0
            ? nextSettings
            : [...(activeShootingSubTab === 'studio' ? defaultStudioSettings : defaultRealLifeSettings)],
      },
    }));

    if (settingToRemove) {
      void deleteAmbientazioneReference(projectId, settingToRemove.id);
      setShootingReferenceImagesByProject((prev) => {
        const projectReferences = { ...(prev[projectId] || {}) };
        delete projectReferences[settingToRemove.id];
        return {
          ...prev,
          [projectId]: projectReferences,
        };
      });
    }
  };

  const moveShootingSetting = (fromIndex: number, toIndex: number) => {
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= currentShootingSettings.length ||
      toIndex >= currentShootingSettings.length
    ) {
      return;
    }

    const nextSettings = [...currentShootingSettings];
    const [movedSetting] = nextSettings.splice(fromIndex, 1);
    nextSettings.splice(toIndex, 0, movedSetting);

    setShootingSettingsMap((prev) => ({
      ...prev,
      [projectId]: {
        ...projectAmbientazioni,
        [activeShootingSubTab]: nextSettings,
      },
    }));
  };

  const uploadShootingReference = async (setting: AmbientazioneSetting, file: File | null) => {
    if (!file) return;

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

    await writeAmbientazioneReference(projectId, setting.id, dataUrl);
    const remoteUrl = await uploadAmbientazioneReference(projectId, setting.id, dataUrl);

    setShootingReferenceImagesByProject((prev) => ({
      ...prev,
      [projectId]: {
        ...(prev[projectId] || {}),
        [setting.id]: remoteUrl,
      },
    }));

    setShootingSettingsMap((prev) => ({
      ...prev,
      [projectId]: {
        ...projectAmbientazioni,
        [activeShootingSubTab]: currentShootingSettings.map((item) =>
          item.id === setting.id ? { ...item, hasReferenceImage: true } : item
        ),
      },
    }));
  };

  const clearShootingReference = async (setting: AmbientazioneSetting) => {
    await deleteAmbientazioneReference(projectId, setting.id);

    setShootingReferenceImagesByProject((prev) => {
      const projectReferences = { ...(prev[projectId] || {}) };
      delete projectReferences[setting.id];
      return {
        ...prev,
        [projectId]: projectReferences,
      };
    });

    setShootingSettingsMap((prev) => ({
      ...prev,
      [projectId]: {
        ...projectAmbientazioni,
        [activeShootingSubTab]: currentShootingSettings.map((item) =>
          item.id === setting.id ? { ...item, hasReferenceImage: false } : item
        ),
      },
    }));
  };

  const updateWooSettings = <K extends keyof WooCommerceSettings>(
    field: K,
    value: WooCommerceSettings[K]
  ) => {
    setWooSettings((prev) => ({ ...prev, [field]: value }));
  };

  const saveWooSettings = async () => {
    setIsSavingWooSettings(true);
    setWooSettingsMessage(null);

    try {
      const res = await fetch('/api/settings/woocommerce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wooSettings),
      });

      const data = (await res.json()) as { error?: string };

      if (!res.ok) {
        throw new Error(data.error || 'Salvataggio impostazioni fallito');
      }

      setWooSettingsMessage('Impostazioni WooCommerce salvate.');
    } catch (err: unknown) {
      setWooSettingsMessage(err instanceof Error ? err.message : 'Errore sconosciuto');
    } finally {
      setIsSavingWooSettings(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F4F4F5] text-[#103D66]">
      <nav className="sticky top-0 z-10 flex items-center justify-between border-b border-[#D7D9DD] bg-white px-6 py-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="relative h-10 w-10 overflow-hidden rounded-lg ring-1 ring-[#D7D9DD]">
            <Image src="/futuria-mark.jpeg" alt="Futuria" fill sizes="40px" className="object-cover" unoptimized />
          </div>
          <div>
            <h1 className="text-lg font-bold">Impostazioni</h1>
            <p className="text-xs text-[#4C6583]">Progetti, ambientazioni e WooCommerce</p>
          </div>
        </div>
        <Link
          href="/"
          className="flex items-center gap-2 rounded-xl bg-[#103D66] px-4 py-2 text-sm font-bold text-white"
        >
          <ArrowLeft size={16} /> Torna all&apos;app
        </Link>
      </nav>

      <main className="mx-auto max-w-5xl space-y-6 p-6">
        <div className="flex gap-2 rounded-2xl border border-[#D7D9DD] bg-white p-2 shadow-sm">
          <button
            onClick={() => setActiveTab('shooting')}
            className={`rounded-xl px-4 py-2 text-sm font-bold ${activeTab === 'shooting' ? 'bg-[#103D66] text-white' : 'text-[#103D66]'}`}
          >
            Ambientazioni
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`rounded-xl px-4 py-2 text-sm font-bold ${activeTab === 'settings' ? 'bg-[#103D66] text-white' : 'text-[#103D66]'}`}
          >
            Impostazioni
          </button>
        </div>

        {activeTab === 'settings' && (
          <section className="rounded-2xl border border-[#D7D9DD] bg-white p-6 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-lg font-bold">Impostazioni</h2>
              <button
                onClick={createProject}
                className="flex items-center gap-2 rounded-xl border border-[#D7D9DD] bg-white px-3 py-2 text-sm font-bold"
              >
                <Plus size={16} /> Nuovo
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-[220px_minmax(0,1fr)_auto]">
              <select
                value={projectId}
                onChange={(e) => switchProject(e.target.value)}
                className="rounded-xl border border-[#D7D9DD] bg-white px-3 py-3 text-sm font-bold"
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <input
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="Nome brand / progetto"
                className="rounded-xl border border-[#D7D9DD] bg-white px-3 py-3 text-sm font-bold outline-none"
              />
              <button
                onClick={saveProject}
                className="flex items-center justify-center gap-2 rounded-xl bg-[#6DA34D] px-4 py-3 text-sm font-bold text-white"
              >
                <Save size={16} /> Salva
              </button>
            </div>
            <div className="mt-6">
              <h3 className="mb-4 text-base font-bold">WooCommerce</h3>
              <div className="space-y-3">
            <input
              value={wooSettings.storeUrl}
              onChange={(e) => updateWooSettings('storeUrl', e.target.value)}
              placeholder="Store URL"
              className="w-full rounded-xl border border-[#D7D9DD] bg-white px-3 py-3 text-sm font-bold outline-none"
            />
            <input
              value={wooSettings.consumerKey}
              onChange={(e) => updateWooSettings('consumerKey', e.target.value)}
              placeholder="Consumer Key"
              className="w-full rounded-xl border border-[#D7D9DD] bg-white px-3 py-3 text-sm font-bold outline-none"
            />
            <input
              value={wooSettings.consumerSecret}
              onChange={(e) => updateWooSettings('consumerSecret', e.target.value)}
              placeholder="Consumer Secret"
              className="w-full rounded-xl border border-[#D7D9DD] bg-white px-3 py-3 text-sm font-bold outline-none"
            />
            <button
              onClick={saveWooSettings}
              disabled={isSavingWooSettings}
              className="flex items-center gap-2 rounded-xl bg-[#103D66] px-4 py-3 text-sm font-bold text-white disabled:bg-slate-300"
            >
              <Save size={16} /> {isSavingWooSettings ? 'Salvataggio...' : 'Salva Impostazioni'}
            </button>
            {wooSettingsMessage && (
              <div className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">
                {wooSettingsMessage}
              </div>
              )}
              </div>
            </div>
          </section>
        )}

        {activeTab === 'shooting' && (
          <section className="rounded-2xl border border-[#D7D9DD] bg-white p-6 shadow-sm">
            <h2 className="mb-2 text-lg font-bold">Ambientazioni</h2>
            <p className="mb-4 text-sm text-slate-500">
              Scrivi il setting in modo naturale, ad esempio &quot;studio sfondo bianco&quot;. L&apos;app lo espande in un prompt piu dettagliato durante la generazione.
            </p>
            <div className="mb-4 flex gap-2 rounded-2xl border border-[#D7D9DD] bg-[#F8FAFB] p-2">
              <button
                onClick={() => setActiveShootingSubTab('studio')}
                className={`rounded-xl px-4 py-2 text-sm font-bold ${
                  activeShootingSubTab === 'studio' ? 'bg-[#103D66] text-white' : 'text-[#103D66]'
                }`}
              >
                Studio
              </button>
              <button
                onClick={() => setActiveShootingSubTab('realLife')}
                className={`rounded-xl px-4 py-2 text-sm font-bold ${
                  activeShootingSubTab === 'realLife' ? 'bg-[#103D66] text-white' : 'text-[#103D66]'
                }`}
              >
                Real Life
              </button>
            </div>
            <div className="mb-4 flex gap-3">
              <input
                value={shootingDraft}
                onChange={(e) => setShootingDraft(e.target.value)}
                placeholder={
                  activeShootingSubTab === 'studio'
                    ? 'Nuovo setting studio, es. studio sfondo bianco'
                    : 'Nuova ambientazione real life'
                }
                className="flex-1 rounded-xl border border-[#D7D9DD] bg-white px-3 py-3 text-sm font-bold outline-none"
              />
              <button
                onClick={addShootingSetting}
                className="flex items-center gap-2 rounded-xl bg-[#6DA34D] px-4 py-3 text-sm font-bold text-white"
              >
                <Plus size={16} /> Aggiungi
              </button>
            </div>
            <div className="space-y-3">
              {currentShootingSettings.map((setting, index) => (
                <div
                  key={`${projectId}-${index}`}
                  draggable
                  onDragStart={() => setDraggedShootingIndex(index)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (draggedShootingIndex !== null) {
                      moveShootingSetting(draggedShootingIndex, index);
                    }
                    setDraggedShootingIndex(null);
                  }}
                  onDragEnd={() => setDraggedShootingIndex(null)}
                  className={`rounded-2xl border border-transparent p-2 ${
                    draggedShootingIndex === index ? 'bg-slate-50' : ''
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <div
                      className="flex h-11 items-center rounded-xl border border-[#D7D9DD] bg-white px-3 text-[#103D66]"
                      title="Trascina per riordinare"
                    >
                      <GripVertical size={16} />
                    </div>
                    <div className="min-w-0 flex-1 rounded-xl border border-[#D7D9DD] bg-white px-3 py-3 text-sm font-bold">
                      <div className="flex items-center gap-2">
                        <span className="truncate">{setting.label}</span>
                        {setting.hasReferenceImage && (
                          <span className="rounded-full bg-[#EEF1F4] px-2 py-1 text-[10px] font-black uppercase text-[#103D66]">
                            Ref
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => startEditingShootingSetting(index)}
                      className="flex h-11 items-center gap-2 rounded-xl border border-[#D7D9DD] bg-white px-4 text-sm font-bold text-[#103D66]"
                    >
                      <Pencil size={16} /> Modifica
                    </button>
                    <button
                      onClick={() => removeShootingSetting(index)}
                      className="flex h-11 items-center gap-2 rounded-xl border border-red-200 bg-white px-4 text-sm font-bold text-red-600"
                    >
                      <Trash2 size={16} /> Rimuovi
                    </button>
                    {index === 0 && (
                      <div className="flex h-11 items-center rounded-xl bg-[#E6F0E0] px-3 text-[10px] font-black uppercase text-[#6DA34D]">
                        Default
                      </div>
                    )}
                  </div>
                  {editingShootingIndex === index && (
                    <div className="mt-3 rounded-2xl border border-[#D7D9DD] bg-white p-4">
                      <div className="mb-3 grid gap-3 lg:grid-cols-2">
                        <div className="rounded-xl bg-[#F8FAFB] px-3 py-2 text-xs text-[#4C6583]">
                          <span className="mb-1 block text-[10px] font-black uppercase tracking-wide text-[#103D66]">
                            Testo ambientazione
                          </span>
                          {activeShootingSubTab === 'studio'
                            ? 'Qui scrivi in modo semplice l’ambientazione studio che vuoi ottenere, ad esempio "studio sfondo bianco".'
                            : 'Qui scrivi in modo semplice l’ambientazione real life che vuoi ottenere, ad esempio "Compleanno".'}
                        </div>
                        <div className="rounded-xl bg-[#F8FAFB] px-3 py-2 text-xs text-[#4C6583]">
                          <span className="mb-1 block text-[10px] font-black uppercase tracking-wide text-[#103D66]">
                            Immagine reference
                          </span>
                          Qui carichi un&apos;immagine di riferimento dell&apos;ambiente. L&apos;AI la usera per
                          interpretare luce, sfondo e mood dell&apos;ambientazione.
                        </div>
                      </div>
                      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
                        <input
                          value={editingShootingValue}
                          onChange={(e) => setEditingShootingValue(e.target.value)}
                          placeholder="Scrivi l'ambientazione"
                          className="w-full rounded-xl border border-[#D7D9DD] bg-white px-3 py-3 text-sm font-bold outline-none"
                        />
                        <button
                          onClick={saveEditingShootingSetting}
                          className="flex h-11 items-center justify-center gap-2 rounded-xl bg-[#103D66] px-4 text-sm font-bold text-white"
                        >
                          <Save size={16} /> Salva
                        </button>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        {shootingReferenceImages[setting.id] ? (
                          <>
                            <div className="relative h-16 w-16 overflow-hidden rounded-xl border border-[#D7D9DD] bg-white">
                              <Image
                                src={shootingReferenceImages[setting.id]}
                                alt={`Reference ${setting.label}`}
                                fill
                                sizes="64px"
                                className="object-cover"
                                unoptimized
                              />
                            </div>
                            <button
                              onClick={() => void clearShootingReference(setting)}
                              className="flex h-10 items-center gap-2 rounded-xl border border-red-200 bg-white px-3 text-xs font-bold text-red-600"
                            >
                              <X size={14} /> Rimuovi immagine
                            </button>
                          </>
                        ) : (
                          <div className="rounded-xl border border-dashed border-[#D7D9DD] px-3 py-2 text-xs text-slate-500">
                            Nessuna immagine reference caricata.
                          </div>
                        )}
                        <label className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#103D66] px-3 text-xs font-bold text-white">
                          <ImagePlus size={14} /> Carica immagine
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(event) => {
                              const file = event.target.files?.[0] || null;
                              void uploadShootingReference(setting, file);
                              event.currentTarget.value = '';
                            }}
                          />
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

      </main>
    </div>
  );
}
