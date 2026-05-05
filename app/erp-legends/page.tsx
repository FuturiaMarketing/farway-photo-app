"use client";

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react';

type LegendKind = 'color' | 'size';
type LegendStatus = 'pending' | 'approved';

type LegendRow = {
  itemId: string;
  kind: LegendKind;
  sourceValue: string;
  sourceCount: number;
  currentProposal: string;
  suggestedValues: string[];
  selectedValue: string;
  status: LegendStatus;
  note: string;
};

type LegendsPack = {
  generatedAt: string;
  decisionsPath: string;
  sources: {
    colorLegend: string;
    colorTerms: string;
    sizeTerms: string;
    master: string;
  };
  destinations: Record<LegendKind, string[]>;
  summary: {
    colorRows: number;
    sizeRows: number;
    pendingColorRows: number;
    pendingSizeRows: number;
    approvedColorRows: number;
    approvedSizeRows: number;
  };
  rows: Record<LegendKind, LegendRow[]>;
};

type FilterKey = 'pending' | 'approved' | 'all';

const kindLabels: Record<LegendKind, string> = {
  color: 'Colori',
  size: 'Taglie',
};

const statusLabels: Record<LegendStatus, string> = {
  pending: 'Da approvare',
  approved: 'Approvato',
};

function normalizeForSearch(value: string) {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function StatusBadge({ status }: { status: LegendStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-black uppercase ${
        status === 'approved'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
          : 'border-amber-200 bg-amber-50 text-amber-800'
      }`}
    >
      {statusLabels[status]}
    </span>
  );
}

function metric(value: number) {
  return value.toLocaleString('it-IT');
}

export default function FarwayErpLegendsPage() {
  const [pack, setPack] = useState<LegendsPack | null>(null);
  const [activeKind, setActiveKind] = useState<LegendKind>('color');
  const [selectedItemId, setSelectedItemId] = useState('');
  const [filter, setFilter] = useState<FilterKey>('pending');
  const [query, setQuery] = useState('');
  const [manualValue, setManualValue] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function loadPack() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/farway-erp-legends', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Caricamento legende fallito');
      setPack(data as LegendsPack);
      setSelectedItemId((current) => current || data.rows?.color?.[0]?.itemId || data.rows?.size?.[0]?.itemId || '');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Errore sconosciuto');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPack();
  }, []);

  const activeRows = useMemo(() => pack?.rows[activeKind] || [], [activeKind, pack?.rows]);

  const filteredRows = useMemo(() => {
    const normalizedQuery = normalizeForSearch(query.trim());
    return activeRows.filter((row) => {
      if (filter !== 'all' && row.status !== filter) return false;
      if (!normalizedQuery) return true;
      return normalizeForSearch([row.sourceValue, row.selectedValue, row.currentProposal, ...row.suggestedValues].join(' ')).includes(normalizedQuery);
    });
  }, [activeRows, filter, query]);

  const selectedRow = useMemo(() => {
    return activeRows.find((row) => row.itemId === selectedItemId) || filteredRows[0] || activeRows[0] || null;
  }, [activeRows, filteredRows, selectedItemId]);

  useEffect(() => {
    setManualValue(selectedRow?.selectedValue || '');
    setNote(selectedRow?.note || '');
  }, [selectedRow?.itemId, selectedRow?.note, selectedRow?.selectedValue]);

  useEffect(() => {
    const firstRow = pack?.rows[activeKind]?.find((row) => row.status === 'pending') || pack?.rows[activeKind]?.[0];
    setSelectedItemId(firstRow?.itemId || '');
  }, [activeKind, pack?.rows]);

  function updateLocalDecision(row: LegendRow, selectedValue: string, savedNote: string) {
    setPack((current) => {
      if (!current) return current;
      const nextRows = current.rows[row.kind].map((entry) =>
        entry.itemId === row.itemId
          ? {
              ...entry,
              selectedValue,
              note: savedNote,
              status: 'approved' as const,
            }
          : entry
      );
      const rows = {
        ...current.rows,
        [row.kind]: nextRows,
      };
      return {
        ...current,
        rows,
        summary: {
          ...current.summary,
          pendingColorRows: rows.color.filter((entry) => entry.status === 'pending').length,
          pendingSizeRows: rows.size.filter((entry) => entry.status === 'pending').length,
          approvedColorRows: rows.color.filter((entry) => entry.status === 'approved').length,
          approvedSizeRows: rows.size.filter((entry) => entry.status === 'approved').length,
        },
      };
    });

    const nextPending = activeRows.find((entry) => entry.itemId !== row.itemId && entry.status === 'pending');
    if (nextPending) setSelectedItemId(nextPending.itemId);
  }

  async function saveDecision(value: string) {
    if (!selectedRow) return;
    const selectedValue = value.trim();
    if (!selectedValue) return;

    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/farway-erp-legends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemId: selectedRow.itemId,
          kind: selectedRow.kind,
          sourceValue: selectedRow.sourceValue,
          selectedValue,
          note,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Salvataggio decisione fallito');
      updateLocalDecision(selectedRow, selectedValue, note);
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
          <span className="text-sm font-bold">Caricamento legende ERP</span>
        </div>
      </main>
    );
  }

  const destinations = pack?.destinations[activeKind] || [];
  const pendingCount = activeKind === 'color' ? pack?.summary.pendingColorRows || 0 : pack?.summary.pendingSizeRows || 0;
  const approvedCount = activeKind === 'color' ? pack?.summary.approvedColorRows || 0 : pack?.summary.approvedSizeRows || 0;

  return (
    <main className="min-h-screen bg-[#F4F4F5] text-[#103D66]">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-5 px-4 py-5 lg:px-6">
        <header className="flex flex-col gap-4 border-b border-slate-200 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <Link href="/" className="mb-3 inline-flex items-center gap-2 text-sm font-bold text-slate-600 hover:text-[#103D66]">
              <ArrowLeft size={16} />
              Photo Studio
            </Link>
            <h1 className="text-3xl font-black tracking-normal text-[#103D66]">Legende ERP Farway</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Approva la conversione tra nomi Excel e valori WooCommerce attuali. A sinistra trovi il vecchio nome, a destra le tre proposte più utili e una scelta manuale.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href="/api/farway-erp-legends?format=csv"
              className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 shadow-sm hover:border-[#103D66]"
            >
              <Download size={16} />
              Export decisioni
            </a>
            <button
              type="button"
              onClick={() => void loadPack()}
              className="inline-flex items-center gap-2 rounded-md bg-[#103D66] px-3 py-2 text-sm font-bold text-white shadow-sm hover:bg-[#0B2E4E]"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
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
            <section className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {[
                ['Colori', pack.summary.colorRows],
                ['Taglie', pack.summary.sizeRows],
                ['Colori da approvare', pack.summary.pendingColorRows],
                ['Taglie da approvare', pack.summary.pendingSizeRows],
                ['Colori approvati', pack.summary.approvedColorRows],
                ['Taglie approvate', pack.summary.approvedSizeRows],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                  <div className="text-xs font-black uppercase text-slate-500">{label}</div>
                  <div className="mt-1 text-2xl font-black text-[#103D66]">{metric(Number(value))}</div>
                </div>
              ))}
            </section>

            <section className="grid h-[calc(100vh-290px)] min-h-[620px] gap-4 overflow-hidden lg:grid-cols-[390px_minmax(0,1fr)]">
              <aside className="flex min-h-0 flex-col gap-3">
                <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                  <div className="grid grid-cols-2 gap-2">
                    {(['color', 'size'] as const).map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        onClick={() => setActiveKind(kind)}
                        className={`rounded-md border px-3 py-2 text-sm font-black ${
                          activeKind === kind
                            ? 'border-[#103D66] bg-[#103D66] text-white'
                            : 'border-slate-200 bg-white text-slate-600 hover:border-slate-400'
                        }`}
                      >
                        {kindLabels[kind]}
                      </button>
                    ))}
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {[
                      ['pending', 'Da fare'],
                      ['approved', 'Fatti'],
                      ['all', 'Tutti'],
                    ].map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setFilter(key as FilterKey)}
                        className={`rounded-md border px-3 py-2 text-xs font-black ${
                          filter === key
                            ? 'border-[#6DA34D] bg-[#EEF5EA] text-[#103D66]'
                            : 'border-slate-200 bg-white text-slate-600 hover:border-slate-400'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <div className="relative mt-3">
                    <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Cerca vecchio o nuovo nome"
                      className="w-full rounded-md border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm font-semibold outline-none focus:border-[#103D66] focus:bg-white"
                    />
                  </div>
                </div>

                <div className="min-h-0 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-sm">
                  {filteredRows.length > 0 ? (
                    filteredRows.map((row) => (
                      <button
                        key={row.itemId}
                        type="button"
                        onClick={() => setSelectedItemId(row.itemId)}
                        className={`block w-full border-b border-slate-100 px-4 py-3 text-left last:border-b-0 ${
                          selectedRow?.itemId === row.itemId ? 'bg-[#EEF5EA]' : 'hover:bg-slate-50'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-black text-[#103D66]">{row.sourceValue}</div>
                            <div className="mt-1 truncate text-xs font-semibold text-slate-500">
                              {row.selectedValue || 'Nessuna proposta selezionata'}
                            </div>
                          </div>
                          <StatusBadge status={row.status} />
                        </div>
                        {row.sourceCount > 0 ? (
                          <div className="mt-2 text-[11px] font-bold uppercase text-slate-400">{metric(row.sourceCount)} righe Excel</div>
                        ) : null}
                      </button>
                    ))
                  ) : (
                    <div className="p-6 text-sm font-semibold text-slate-500">Nessuna riga per questo filtro.</div>
                  )}
                </div>
              </aside>

              <section className="min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                {selectedRow ? (
                  <div className="flex min-h-full flex-col">
                    <div className="border-b border-slate-200 p-5">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="text-xs font-black uppercase text-slate-500">{kindLabels[selectedRow.kind]}</div>
                          <h2 className="mt-1 text-2xl font-black text-[#103D66]">{selectedRow.sourceValue}</h2>
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusBadge status={selectedRow.status} />
                          <span className="text-sm font-bold text-slate-500">
                            {metric(approvedCount)} approvati · {metric(pendingCount)} da fare
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="grid flex-1 gap-5 overflow-y-auto p-5 lg:grid-cols-[minmax(220px,0.85fr)_minmax(0,1.4fr)]">
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-5">
                        <div className="text-xs font-black uppercase text-slate-500">Vecchio nome nel file Excel</div>
                        <div className="mt-4 break-words text-4xl font-black leading-tight text-[#103D66]">{selectedRow.sourceValue}</div>
                        <div className="mt-4 grid gap-2 text-sm font-semibold text-slate-600">
                          <div>Tipo: {selectedRow.kind === 'color' ? 'colore' : 'taglia'}</div>
                          {selectedRow.sourceCount > 0 ? <div>Ricorrenze: {metric(selectedRow.sourceCount)} righe Excel</div> : null}
                          <div>Proposta corrente: {selectedRow.currentProposal || 'nessuna'}</div>
                        </div>
                      </div>

                      <div className="space-y-4">
                        <div>
                          <div className="mb-3 text-xs font-black uppercase text-slate-500">Scegli una delle tre proposte</div>
                          <div className="grid gap-3 xl:grid-cols-3">
                            {selectedRow.suggestedValues.map((value, index) => (
                              <button
                                key={value}
                                type="button"
                                disabled={saving}
                                onClick={() => void saveDecision(value)}
                                className={`group min-h-[150px] rounded-lg border p-4 text-left shadow-sm transition disabled:opacity-60 ${
                                  selectedRow.selectedValue === value
                                    ? 'border-[#6DA34D] bg-[#EEF5EA]'
                                    : 'border-slate-200 bg-white hover:border-[#103D66]'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-xs font-black uppercase text-slate-400">Opzione {index + 1}</span>
                                  {selectedRow.selectedValue === value ? <CheckCircle2 size={18} className="text-[#6DA34D]" /> : null}
                                </div>
                                <div className="mt-4 text-xl font-black leading-snug text-[#103D66]">{value}</div>
                                <div className="mt-4 inline-flex items-center gap-2 text-sm font-black text-[#6DA34D]">
                                  <Check size={16} />
                                  Conferma
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="rounded-lg border border-slate-200 p-4">
                          <label htmlFor="manual-destination" className="text-xs font-black uppercase text-slate-500">
                            Oppure scegli un altro valore WooCommerce
                          </label>
                          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                            <input
                              id="manual-destination"
                              list={`destinations-${activeKind}`}
                              value={manualValue}
                              onChange={(event) => setManualValue(event.target.value)}
                              className="min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 outline-none focus:border-[#103D66] focus:bg-white"
                              placeholder="Cerca o scrivi il valore esatto"
                            />
                            <datalist id={`destinations-${activeKind}`}>
                              {destinations.map((value) => (
                                <option key={value} value={value} />
                              ))}
                            </datalist>
                            <button
                              type="button"
                              disabled={saving || !destinations.includes(manualValue)}
                              onClick={() => void saveDecision(manualValue)}
                              className="inline-flex items-center justify-center gap-2 rounded-md bg-[#103D66] px-4 py-2 text-sm font-black text-white hover:bg-[#0B2E4E] disabled:opacity-50"
                            >
                              {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                              Salva altro
                            </button>
                          </div>
                          {!destinations.includes(manualValue) && manualValue ? (
                            <div className="mt-2 text-xs font-bold text-amber-700">Il valore deve essere uno di quelli WooCommerce attuali.</div>
                          ) : null}
                        </div>

                        <div className="rounded-lg border border-slate-200 p-4">
                          <label htmlFor="legend-note" className="text-xs font-black uppercase text-slate-500">
                            Nota opzionale
                          </label>
                          <textarea
                            id="legend-note"
                            value={note}
                            onChange={(event) => setNote(event.target.value)}
                            rows={3}
                            className="mt-3 w-full resize-none rounded-md border border-slate-200 bg-slate-50 p-3 text-sm font-semibold text-slate-700 outline-none focus:border-[#103D66] focus:bg-white"
                            placeholder="Es. confermato da Farwa, valore legacy ambiguo, da non usare..."
                          />
                          <button
                            type="button"
                            disabled={saving || !selectedRow.selectedValue}
                            onClick={() => void saveDecision(selectedRow.selectedValue)}
                            className="mt-3 inline-flex items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-black text-slate-700 hover:border-[#103D66] disabled:opacity-50"
                          >
                            Salva nota
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="p-8 text-sm font-semibold text-slate-500">Seleziona una riga.</div>
                )}
              </section>
            </section>

            <footer className="break-all text-xs font-semibold text-slate-500">
              Decisioni: {pack.decisionsPath}. Master: {pack.sources.master}.
            </footer>
          </>
        ) : null}
      </div>
    </main>
  );
}
