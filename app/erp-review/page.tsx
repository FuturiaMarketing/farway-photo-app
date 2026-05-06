"use client";

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Download,
  Loader2,
  PackagePlus,
  Search,
  ShieldQuestion,
  X,
} from 'lucide-react';

type DecisionStatus = 'pending' | 'approved_match' | 'create_hidden' | 'skip' | 'unclear';

type ReviewDecision = {
  groupId: string;
  status: DecisionStatus;
  selectedProductId?: number;
  note?: string;
  updatedAt?: string;
};

type ReviewCandidate = {
  productId: number;
  productName: string;
  hitCount: number;
  variationCount: number;
  sampleSku: string;
  skus: string[];
  colors: string[];
  sizes: string[];
  variationIds: number[];
};

type WooProductSearchItem = {
  id: number;
  name: string;
  sku?: string;
  image?: string;
  images?: string[];
};

type ReviewSourceRow = {
  sheet: string;
  row: number;
  sourceOrder?: number;
  code: string;
  model: string;
  isCampionatura: boolean;
  color: string;
  canonicalColor: string;
  size: string;
  canonicalSize: string;
  season: string;
  year: string;
  location: string;
  stockQuantity: number;
  matchStatus: string;
};

type ReviewGroup = {
  groupId: string;
  styleCode: string;
  title: string;
  rowCount: number;
  totalQuantity: number;
  priority: 'alta' | 'media' | 'bassa';
  needsCodeMapping: boolean;
  hasSkuConflict: boolean;
  hasMultipleCandidates: boolean;
  isDoha: boolean;
  isCampionatura: boolean;
  isHiddenInventory: boolean;
  primarySheet?: string;
  firstSourceRow?: number;
  sourceOrder?: number;
  sheets: string[];
  seasons: string[];
  years: string[];
  models: string[];
  colors: string[];
  sizes: string[];
  locations: string[];
  matchStatuses: Array<{ status: string; count: number }>;
  candidates: ReviewCandidate[];
  sourceRows: ReviewSourceRow[];
  decision: ReviewDecision;
};

type ReviewPack = {
  generatedAt: string;
  sourceOutputDir: string;
  decisionsPath: string;
  summary: {
    reviewRows: number;
    groups: number;
    highImpactGroups: number;
    pendingGroups: number;
    approvedGroups: number;
    createHiddenGroups: number;
    skippedGroups: number;
    unclearGroups: number;
    rowsCoveredByTop20: number;
  };
  groups: ReviewGroup[];
};

type FilterKey = 'pending' | 'high' | 'unmapped' | 'approved' | 'unclear' | 'all';

type SidebarGroupSection = {
  sheet: string;
  rowCount: number;
  totalQuantity: number;
  groups: ReviewGroup[];
};

const statusLabels: Record<DecisionStatus, string> = {
  pending: 'Da decidere',
  approved_match: 'Match confermato',
  create_hidden: 'Nuovo nascosto',
  skip: 'Non importare',
  unclear: 'Da vedere',
};

const statusClasses: Record<DecisionStatus, string> = {
  pending: 'bg-amber-50 text-amber-800 border-amber-200',
  approved_match: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  create_hidden: 'bg-sky-50 text-sky-800 border-sky-200',
  skip: 'bg-slate-100 text-slate-700 border-slate-200',
  unclear: 'bg-rose-50 text-rose-800 border-rose-200',
};

function CompactList({ values }: { values: string[] }) {
  if (values.length === 0) return <span className="text-slate-400">-</span>;
  return <span>{values.slice(0, 5).join(', ')}{values.length > 5 ? ` +${values.length - 5}` : ''}</span>;
}

function SourceCanonicalValue({ source, canonical }: { source: string; canonical: string }) {
  const sourceValue = source.trim();
  const canonicalValue = canonical.trim();
  const hasBoth = sourceValue && canonicalValue && sourceValue.toLowerCase() !== canonicalValue.toLowerCase();

  if (!sourceValue && !canonicalValue) return <span className="text-slate-400">-</span>;

  return (
    <span className="inline-flex max-w-[180px] flex-col gap-0.5">
      <span className="truncate font-semibold text-slate-800">{sourceValue || canonicalValue}</span>
      {hasBoth ? <span className="truncate text-[11px] font-semibold text-slate-500">proposto: {canonicalValue}</span> : null}
    </span>
  );
}

function StatusBadge({ status }: { status: DecisionStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-bold ${statusClasses[status]}`}>
      {statusLabels[status]}
    </span>
  );
}

function metricLabel(value: number, label: string) {
  return `${value.toLocaleString('it-IT')} ${label}`;
}

function groupCountLabel(value: number) {
  return value === 1 ? '1 gruppo' : `${value.toLocaleString('it-IT')} gruppi`;
}

function hasMatchStatus(group: ReviewGroup, status: string) {
  return group.matchStatuses.some((entry) => entry.status === status && entry.count > 0);
}

function getGroupPrimarySheet(group: ReviewGroup) {
  return group.primarySheet || group.sourceRows[0]?.sheet || group.sheets[0] || 'Senza foglio';
}

function getGroupFirstSourceRow(group: ReviewGroup) {
  return group.firstSourceRow || group.sourceRows[0]?.row || 0;
}

function getGroupSourceOrder(group: ReviewGroup) {
  return group.sourceOrder ?? group.sourceRows[0]?.sourceOrder ?? Number.MAX_SAFE_INTEGER;
}

function compareGroupsByExcelOrder(a: ReviewGroup, b: ReviewGroup) {
  return (
    getGroupSourceOrder(a) - getGroupSourceOrder(b) ||
    getGroupPrimarySheet(a).localeCompare(getGroupPrimarySheet(b)) ||
    getGroupFirstSourceRow(a) - getGroupFirstSourceRow(b) ||
    a.title.localeCompare(b.title)
  );
}

export default function FarwayErpReviewPage() {
  const [pack, setPack] = useState<ReviewPack | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [filter, setFilter] = useState<FilterKey>('pending');
  const [query, setQuery] = useState('');
  const [note, setNote] = useState('');
  const [wooProducts, setWooProducts] = useState<WooProductSearchItem[]>([]);
  const [wooProductSearch, setWooProductSearch] = useState('');
  const [productsLoading, setProductsLoading] = useState(false);
  const [productsError, setProductsError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function loadPack(preferredGroupId?: string) {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/farway-erp-review', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Caricamento review fallito');
      setPack(data as ReviewPack);
      setSelectedGroupId((current) => {
        const groups = (data.groups || []) as ReviewGroup[];
        const preferredExists = preferredGroupId && groups.some((group) => group.groupId === preferredGroupId);
        const currentExists = current && groups.some((group) => group.groupId === current);

        if (preferredExists) return preferredGroupId;
        if (currentExists) return current;
        return groups[0]?.groupId ?? '';
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Errore sconosciuto');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPack();
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadWooProducts() {
      setProductsLoading(true);
      setProductsError('');
      try {
        const response = await fetch('/api/products', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Caricamento prodotti WooCommerce fallito');
        if (isMounted) setWooProducts(Array.isArray(data) ? data : []);
      } catch (loadError) {
        if (isMounted) {
          setProductsError(loadError instanceof Error ? loadError.message : 'Errore caricamento prodotti');
        }
      } finally {
        if (isMounted) setProductsLoading(false);
      }
    }

    void loadWooProducts();

    return () => {
      isMounted = false;
    };
  }, []);

  const filteredGroups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (pack?.groups || []).filter((group) => {
      const status = group.decision.status;
      const matchesFilter =
        filter === 'all' ||
        (filter === 'pending' && status === 'pending') ||
        (filter === 'high' && group.priority === 'alta' && status === 'pending') ||
        (filter === 'unmapped' && hasMatchStatus(group, 'review_unmapped_size') && status === 'pending') ||
        (filter === 'approved' && status === 'approved_match') ||
        (filter === 'unclear' && status === 'unclear');

      if (!matchesFilter) return false;
      if (!normalizedQuery) return true;

      return [
        group.styleCode,
        group.title,
        ...group.models,
        ...group.colors,
        ...group.sizes,
        ...group.candidates.map((candidate) => candidate.productName),
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery);
    }).sort(compareGroupsByExcelOrder);
  }, [filter, pack?.groups, query]);

  const sidebarSections = useMemo<SidebarGroupSection[]>(() => {
    const sections = new Map<string, SidebarGroupSection>();

    for (const group of filteredGroups) {
      const sheet = getGroupPrimarySheet(group);
      const existing = sections.get(sheet) || {
        sheet,
        rowCount: 0,
        totalQuantity: 0,
        groups: [],
      };

      existing.rowCount += group.rowCount;
      existing.totalQuantity += group.totalQuantity;
      existing.groups.push(group);
      sections.set(sheet, existing);
    }

    return Array.from(sections.values()).map((section) => ({
      ...section,
      groups: section.groups.sort(compareGroupsByExcelOrder),
    }));
  }, [filteredGroups]);

  const selectedGroup = useMemo(() => {
    if (!pack) return null;
    return (
      filteredGroups.find((group) => group.groupId === selectedGroupId) ||
      filteredGroups[0] ||
      pack.groups.find((group) => group.groupId === selectedGroupId) ||
      null
    );
  }, [filteredGroups, pack, selectedGroupId]);

  useEffect(() => {
    setNote(selectedGroup?.decision.note || '');
  }, [
    selectedGroup?.decision.note,
    selectedGroup?.groupId,
  ]);

  useEffect(() => {
    setWooProductSearch('');
  }, [selectedGroup?.groupId]);

  const normalizedWooProductSearch = wooProductSearch.trim().toLowerCase();
  const wooProductOptions = useMemo(() => {
    if (normalizedWooProductSearch.length === 0) return [];

    return wooProducts
      .filter((product) =>
        product.name.toLowerCase().includes(normalizedWooProductSearch) ||
        String(product.sku || '').toLowerCase().includes(normalizedWooProductSearch) ||
        String(product.id).includes(normalizedWooProductSearch)
      )
      .slice(0, 8);
  }, [normalizedWooProductSearch, wooProducts]);

  async function saveDecision(status: DecisionStatus, selectedProductId?: number) {
    if (!selectedGroup) return;

    const shouldAdvance = status === 'approved_match' && typeof selectedProductId === 'number';
    const selectedIndex = filteredGroups.findIndex((group) => group.groupId === selectedGroup.groupId);
    const nextGroupId = shouldAdvance && selectedIndex >= 0
      ? filteredGroups[selectedIndex + 1]?.groupId || filteredGroups[selectedIndex - 1]?.groupId
      : undefined;

    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/farway-erp-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groupId: selectedGroup.groupId,
          status,
          selectedProductId,
          note,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Salvataggio decisione fallito');
      if (shouldAdvance) setWooProductSearch('');
      await loadPack(nextGroupId);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Errore sconosciuto');
    } finally {
      setSaving(false);
    }
  }

  if (loading && !pack) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#F4F4F5] text-[#103D66]">
        <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-5 py-4 shadow-sm">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm font-bold">Caricamento review ERP</span>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#F4F4F5] text-[#103D66]">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-4 py-5 lg:px-6">
        <header className="flex flex-col gap-4 border-b border-slate-200 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <Link href="/" className="mb-3 inline-flex items-center gap-2 text-sm font-bold text-slate-600 hover:text-[#103D66]">
              <ArrowLeft size={16} />
              Photo Studio
            </Link>
            <h1 className="text-3xl font-black tracking-normal text-[#103D66]">Farway ERP Review</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Decisioni aggregate per codice, foglio, stagione e colore Excel. Confermare un prodotto WooCommerce significa collegare quel blocco Excel al prodotto, poi il match finale delle varianti usa colore e taglia normalizzati.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href="/api/farway-erp-review?format=decisions-csv"
              className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 shadow-sm hover:border-[#103D66]"
            >
              <Download size={16} />
              Export decisioni
            </a>
            <button
              type="button"
              onClick={() => void loadPack()}
              className="rounded-md bg-[#103D66] px-3 py-2 text-sm font-bold text-white shadow-sm hover:bg-[#0B2E4E]"
            >
              Aggiorna
            </button>
          </div>
        </header>

        {error ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-800">
            {error}
          </div>
        ) : null}

        {pack ? (
          <>
            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              {[
                ['Righe review', pack.summary.reviewRows],
                ['Gruppi', pack.summary.groups],
                ['Alta priorità', pack.summary.highImpactGroups],
                ['Da decidere', pack.summary.pendingGroups],
                ['Confermati', pack.summary.approvedGroups],
                ['Top 20 righe', pack.summary.rowsCoveredByTop20],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="text-xs font-black uppercase text-slate-500">{label}</div>
                  <div className="mt-2 text-2xl font-black text-[#103D66]">{Number(value).toLocaleString('it-IT')}</div>
                </div>
              ))}
            </section>

            <section className="grid h-[calc(100vh-300px)] min-h-[680px] gap-4 lg:grid-cols-[420px_minmax(0,1fr)]">
              <aside className="flex min-h-0 flex-col gap-3">
                <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Cerca codice, modello, colore"
                      className="w-full rounded-md border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm font-semibold outline-none focus:border-[#103D66] focus:bg-white"
                    />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {[
                      ['pending', 'Da decidere'],
                      ['high', 'Alta priorità'],
                      ['unmapped', 'Taglia fuori sito'],
                      ['approved', 'Confermati'],
                      ['unclear', 'Da vedere'],
                      ['all', 'Tutti'],
                    ].map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setFilter(key as FilterKey)}
                        className={`rounded-md border px-3 py-2 text-xs font-black ${
                          filter === key
                            ? 'border-[#103D66] bg-[#103D66] text-white'
                            : 'border-slate-200 bg-white text-slate-600 hover:border-slate-400'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="min-h-0 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-sm">
                  {sidebarSections.length > 0 ? (
                    sidebarSections.map((section) => (
                      <div key={section.sheet} className="border-b border-slate-100 last:border-b-0">
                        <div className="sticky top-0 z-10 border-b border-slate-100 bg-slate-50/95 px-4 py-2 backdrop-blur">
                          <div className="truncate text-[11px] font-black uppercase text-slate-500">{section.sheet}</div>
                          <div className="mt-0.5 text-[11px] font-semibold text-slate-400">
                            {metricLabel(section.rowCount, 'righe')} · {groupCountLabel(section.groups.length)} · qta {section.totalQuantity.toLocaleString('it-IT')}
                          </div>
                        </div>
                        {section.groups.map((group) => (
                          <button
                            key={group.groupId}
                            type="button"
                            onClick={() => setSelectedGroupId(group.groupId)}
                            className={`block w-full border-b border-slate-100 px-4 py-3 text-left last:border-b-0 ${
                              selectedGroup?.groupId === group.groupId ? 'bg-[#EEF5EA]' : 'hover:bg-slate-50'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-black text-[#103D66]">{group.title}</div>
                                <div className="mt-1 text-xs font-semibold text-slate-500">
                                  riga {getGroupFirstSourceRow(group) || '-'} · {metricLabel(group.rowCount, 'righe')} · qta {group.totalQuantity.toLocaleString('it-IT')}
                                </div>
                              </div>
                              <StatusBadge status={group.decision.status} />
                            </div>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {group.priority === 'alta' ? (
                                <span className="rounded-full bg-[#103D66] px-2 py-1 text-[11px] font-black text-white">alta priorità</span>
                              ) : null}
                              {group.hasSkuConflict ? (
                                <span className="rounded-full bg-rose-100 px-2 py-1 text-[11px] font-black text-rose-800">SKU da verificare</span>
                              ) : null}
                              {group.hasMultipleCandidates ? (
                                <span className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-black text-amber-800">più match</span>
                              ) : null}
                              {group.isDoha ? (
                                <span className="rounded-full bg-sky-100 px-2 py-1 text-[11px] font-black text-sky-800">Doha nascosto</span>
                              ) : null}
                              {group.isCampionatura ? (
                                <span className="rounded-full bg-violet-100 px-2 py-1 text-[11px] font-black text-violet-800">campionatura</span>
                              ) : null}
                              {hasMatchStatus(group, 'review_unmapped_size') ? (
                                <span className="rounded-full bg-rose-100 px-2 py-1 text-[11px] font-black text-rose-800">13/14 fuori sito</span>
                              ) : null}
                            </div>
                          </button>
                        ))}
                      </div>
                    ))
                  ) : (
                    <div className="p-6 text-sm font-semibold text-slate-500">Nessun gruppo per questo filtro.</div>
                  )}
                </div>
              </aside>

              <section className="min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                {selectedGroup ? (
                  <div className="flex h-full min-h-0 flex-col">
                    <div className="border-b border-slate-200 p-5">
                      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-2xl font-black text-[#103D66]">{selectedGroup.title}</h2>
                            <StatusBadge status={selectedGroup.decision.status} />
                          </div>
                          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm font-semibold text-slate-600">
                            <span>{metricLabel(selectedGroup.rowCount, 'righe')}</span>
                            <span>Quantità {selectedGroup.totalQuantity.toLocaleString('it-IT')}</span>
                            <span>Fogli {selectedGroup.sheets.length}</span>
                            <span>Location <CompactList values={selectedGroup.locations} /></span>
                          </div>
                          {hasMatchStatus(selectedGroup, 'review_unmapped_size') ? (
                            <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800">
                              Questo gruppo contiene taglie 13/14 anni: non esistono come taglie nel nuovo sito, quindi non vanno forzate su una variante WooCommerce esistente.
                            </div>
                          ) : null}
                          {selectedGroup.isHiddenInventory ? (
                            <div className="mt-3 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-bold text-sky-900">
                              Questo gruppo è inventario nascosto {selectedGroup.isDoha ? 'Doha' : 'campionatura'}: se scegli un prodotto WooCommerce, viene usato come riferimento per creare un record nascosto separato. La quantità non verrà aggiunta allo stock vendibile del prodotto esistente.
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    <div className="grid min-h-0 gap-5 overflow-y-auto p-5 xl:grid-cols-[minmax(0,1fr)_360px]">
                      <div className="min-w-0 space-y-5">
                        <div className="rounded-lg border border-slate-200 p-4">
                          <h3 className="mb-3 text-sm font-black uppercase text-slate-500">Righe Excel da valutare</h3>
                          <div className="mb-4 grid gap-3 text-sm md:grid-cols-4">
                            <div>
                              <div className="font-black text-slate-500">Fogli</div>
                              <div className="font-semibold text-slate-800"><CompactList values={selectedGroup.sheets} /></div>
                            </div>
                            <div>
                              <div className="font-black text-slate-500">Modelli Excel</div>
                              <div className="font-semibold text-slate-800"><CompactList values={selectedGroup.models} /></div>
                            </div>
                            <div>
                              <div className="font-black text-slate-500">Colori / taglie</div>
                              <div className="font-semibold text-slate-800"><CompactList values={[...selectedGroup.colors, ...selectedGroup.sizes]} /></div>
                            </div>
                            <div>
                              <div className="font-black text-slate-500">Stagioni</div>
                              <div className="font-semibold text-slate-800"><CompactList values={[...selectedGroup.seasons, ...selectedGroup.years]} /></div>
                            </div>
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full min-w-[920px] text-left text-xs">
                              <thead className="border-b border-slate-200 text-slate-500">
                                <tr>
                                  <th className="py-2 pr-3 font-black">Foglio</th>
                                  <th className="py-2 pr-3 font-black">Riga</th>
                                  <th className="py-2 pr-3 font-black">Codice</th>
                                  <th className="py-2 pr-3 font-black">Modello</th>
                                  <th className="py-2 pr-3 font-black">Colore</th>
                                  <th className="py-2 pr-3 font-black">Taglia</th>
                                  <th className="py-2 pr-3 font-black">Qta</th>
                                  <th className="py-2 pr-3 font-black">Location</th>
                                  <th className="py-2 pr-3 font-black">Stato</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100">
                                {selectedGroup.sourceRows.slice(0, 16).map((row) => (
                                  <tr key={`${row.sheet}-${row.row}`}>
                                    <td className="max-w-[220px] truncate py-2 pr-3 font-semibold text-slate-700">{row.sheet}</td>
                                    <td className="py-2 pr-3 font-semibold text-slate-500">{row.row}</td>
                                    <td className="py-2 pr-3 font-semibold text-slate-700">{row.code || '-'}</td>
                                    <td className="py-2 pr-3 font-bold text-[#103D66]">{row.model || row.code || '-'}</td>
                                    <td className="py-2 pr-3">
                                      <SourceCanonicalValue source={row.color} canonical={row.canonicalColor} />
                                    </td>
                                    <td className="py-2 pr-3">
                                      <SourceCanonicalValue source={row.size} canonical={row.canonicalSize} />
                                    </td>
                                    <td className="py-2 pr-3 font-semibold text-slate-700">{row.stockQuantity}</td>
                                    <td className="py-2 pr-3 font-semibold text-slate-700">{row.location || '-'}</td>
                                    <td className="py-2 pr-3 font-semibold text-slate-500">{row.matchStatus}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </div>

                      <aside className="space-y-4">
                        <div className="rounded-lg border border-slate-200 p-4">
                          <div className="mb-3 flex items-center justify-between gap-3">
                            <h3 className="text-sm font-black uppercase text-slate-500">Opzioni WooCommerce</h3>
                            {selectedGroup.hasSkuConflict ? (
                              <span className="inline-flex items-center gap-1 text-xs font-black text-rose-700">
                                <AlertTriangle size={14} />
                                SKU
                              </span>
                            ) : null}
                          </div>
                          <p className="mb-3 text-xs font-semibold leading-5 text-slate-500">
                            {selectedGroup.isHiddenInventory
                              ? 'Qui si sceglie il prodotto WooCommerce di riferimento. Il record finale sarà nascosto e separato.'
                              : 'Qui si decide il prodotto WooCommerce. Le singole varianti vengono poi agganciate automaticamente usando colore e taglia riconciliati.'}
                          </p>
                          <div className="grid gap-3">
                            {selectedGroup.candidates.length > 0 ? (
                              selectedGroup.candidates.slice(0, 3).map((candidate) => (
                                <div key={candidate.productId} className="rounded-md border border-slate-200 bg-slate-50 p-3">
                                  <div className="text-sm font-black text-[#103D66]">
                                    #{candidate.productId} · {candidate.productName}
                                  </div>
                                  <div className="mt-1 text-xs font-semibold text-slate-600">
                                    {metricLabel(candidate.hitCount, 'hit')} · {metricLabel(candidate.variationCount, 'varianti')} · SKU {candidate.sampleSku || '-'}
                                  </div>
                                  <div className="mt-2 grid gap-1 text-xs text-slate-600">
                                    <div><span className="font-black">Colori:</span> <CompactList values={candidate.colors} /></div>
                                    <div><span className="font-black">Taglie:</span> <CompactList values={candidate.sizes} /></div>
                                  </div>
                                  <button
                                    type="button"
                                    disabled={saving}
                                    onClick={() => void saveDecision('approved_match', candidate.productId)}
                                    className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#6DA34D] px-3 py-2 text-sm font-black text-white hover:bg-[#5E9042] disabled:opacity-60"
                                  >
                                    <Check size={16} />
                                    {selectedGroup.isHiddenInventory ? 'Usa come riferimento' : 'Conferma prodotto Woo'}
                                  </button>
                                </div>
                              ))
                            ) : (
                              <div className="rounded-md border border-dashed border-slate-300 p-4 text-sm font-semibold text-slate-500">
                                Nessun candidato automatico abbastanza affidabile.
                              </div>
                            )}
                          </div>
                          <div className="mt-4 border-t border-slate-200 pt-4">
                            <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                              <div className="text-[10px] font-black uppercase tracking-wide text-slate-500">
                                Cerca prodotto WooCommerce
                              </div>
                            </div>
                            <input
                              value={wooProductSearch}
                              onChange={(event) => setWooProductSearch(event.target.value)}
                              placeholder="Cerca per nome, SKU o ID"
                              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-bold text-slate-700 outline-none focus:border-[#103D66]"
                            />
                            {selectedGroup.decision.status === 'approved_match' && selectedGroup.decision.selectedProductId ? (
                              <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800">
                                Prodotto confermato: #{selectedGroup.decision.selectedProductId}
                              </div>
                            ) : null}
                            <div className="mt-3 grid gap-2">
                              {wooProductOptions.map((product) => {
                                const imageUrl = product.image || product.images?.[0] || '';

                                return (
                                  <button
                                    key={product.id}
                                    type="button"
                                    disabled={saving}
                                    onClick={() => void saveDecision('approved_match', product.id)}
                                    className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 text-left hover:border-[#6DA34D] hover:bg-[#F1F7EC] disabled:opacity-60"
                                  >
                                    <div className="relative h-16 w-12 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                                      {imageUrl ? (
                                        <Image src={imageUrl} alt={product.name} fill sizes="48px" className="object-cover" unoptimized />
                                      ) : (
                                        <div className="flex h-full w-full items-center justify-center text-[10px] font-black uppercase text-slate-300">
                                          Woo
                                        </div>
                                      )}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-sm font-black text-[#103D66]">{product.name}</div>
                                      <div className="mt-1 text-[10px] font-bold uppercase text-slate-400">
                                        SKU: {product.sku || '-'} · ID: {product.id}
                                      </div>
                                    </div>
                                    <Check size={16} className="shrink-0 text-[#6DA34D]" />
                                  </button>
                                );
                              })}
                            </div>
                            {productsError ? (
                              <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-800">
                                {productsError}
                              </div>
                            ) : null}
                            {!productsError && wooProductOptions.length === 0 ? (
                              <div className="mt-3 rounded-xl border border-dashed border-slate-200 px-4 py-5 text-center text-sm font-semibold text-slate-400">
                                {productsLoading
                                  ? 'Caricamento prodotti WooCommerce...'
                                  : normalizedWooProductSearch.length === 0
                                    ? 'Scrivi nella ricerca per trovare un prodotto WooCommerce.'
                                    : 'Nessun prodotto trovato per questa ricerca.'}
                              </div>
                            ) : null}
                          </div>
                        </div>

                        <div className="rounded-lg border border-slate-200 p-4">
                          <h3 className="mb-3 text-sm font-black uppercase text-slate-500">Decisione alternativa</h3>
                          <div className="grid gap-2">
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => void saveDecision('create_hidden')}
                              className="inline-flex items-center justify-center gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-black text-sky-800 hover:bg-sky-100 disabled:opacity-60"
                            >
                              <PackagePlus size={16} />
                              Nuovo prodotto nascosto
                            </button>
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => void saveDecision('skip')}
                              className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-black text-slate-700 hover:bg-slate-100 disabled:opacity-60"
                            >
                              <X size={16} />
                              Non importare
                            </button>
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => void saveDecision('unclear')}
                              className="inline-flex items-center justify-center gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-black text-rose-800 hover:bg-rose-100 disabled:opacity-60"
                            >
                              <ShieldQuestion size={16} />
                              Da vedere insieme
                            </button>
                          </div>
                        </div>

                        <div className="rounded-lg border border-slate-200 p-4">
                          <label htmlFor="decision-note" className="text-sm font-black uppercase text-slate-500">
                            Nota decisione
                          </label>
                          <textarea
                            id="decision-note"
                            value={note}
                            onChange={(event) => setNote(event.target.value)}
                            rows={5}
                            className="mt-3 w-full resize-none rounded-md border border-slate-200 bg-slate-50 p-3 text-sm font-semibold text-slate-700 outline-none focus:border-[#103D66] focus:bg-white"
                            placeholder="Es. confermato da Farwa, creare come campionatura, non esiste più..."
                          />
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => void saveDecision(selectedGroup.decision.status)}
                            className="mt-3 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-black text-slate-700 hover:border-[#103D66] disabled:opacity-60"
                          >
                            Salva nota
                          </button>
                        </div>
                      </aside>
                    </div>
                  </div>
                ) : (
                  <div className="p-8 text-sm font-semibold text-slate-500">Seleziona un gruppo.</div>
                )}
              </section>
            </section>

            <footer className="break-all text-xs font-semibold text-slate-500">
              Output sorgente: {pack.sourceOutputDir}. Decisioni: {pack.decisionsPath}.
            </footer>
          </>
        ) : null}
      </div>
    </main>
  );
}
