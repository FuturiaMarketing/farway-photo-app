"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Download, RotateCcw, Search, FolderInput, Layers } from 'lucide-react';
import { buildTargetName, VIEWS } from '@/lib/reconcile-naming';

// ---- types (mirror lib/server/reconcile-store.ts) ----
type Candidate = {
  productId: number | null;
  productName: string;
  sku?: string;
  colorway: string | null;
  confidence: 'alta' | 'media' | 'bassa';
  reason: string;
};
type ManifestItem = {
  file: string;
  garmentType: string;
  category: string;
  colorDescription: string;
  viewGuess: string;
  disposition: 'match' | 'bucket';
  bucketReason?: string;
  candidates: Candidate[];
  flags: string[];
};
type Decision = {
  file: string;
  status: 'confirmed' | 'bucket' | 'multi' | 'skip';
  productId: number | null;
  productName: string;
  sku?: string;
  colorway: string | null;
  view: string;
  note?: string;
  updatedAt: string;
};
type SlimColorway = { colorway: string | null; thumb: string | null };
type SlimProduct = {
  id: number;
  name: string;
  sku: string;
  categories: string[];
  isMono: boolean;
  primaryThumb: string | null;
  colorways: SlimColorway[];
};
type Counts = { total: number; decided: number; pending: number; confirmed: number; bucket: number; multi: number; skip: number };
type Filter = 'pending' | 'all' | 'confirmed' | 'bucket' | 'multi';

const C = {
  primary: '#103D66', accent: '#6DA34D', accentBg: '#E6F0E0',
  surface: '#FFFFFF', surface2: '#EEF1F4', surface3: '#F8FAFB',
  border: '#D7D9DD', muted: '#4C6583',
};

const stillThumb = (file: string) => `/reconcile/stilllife/${encodeURIComponent(file)}`;
const catThumb = (file: string) => `/reconcile/catalog/${encodeURIComponent(file)}`;

const confBadge: Record<Candidate['confidence'], { bg: string; fg: string; label: string }> = {
  alta: { bg: '#E6F0E0', fg: '#3F6B2A', label: 'alta' },
  media: { bg: '#FFF3D6', fg: '#8A6400', label: 'media' },
  bassa: { bg: '#F1E0E0', fg: '#9A3B3B', label: 'bassa' },
};

export default function AbbinaFotoPage() {
  const [items, setItems] = useState<ManifestItem[]>([]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [catalog, setCatalog] = useState<SlimProduct[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('pending');
  const [idx, setIdx] = useState(0);

  // per-item working selection
  const [chosenProductId, setChosenProductId] = useState<number | null>(null);
  const [chosenColorway, setChosenColorway] = useState<string | null>(null);
  const [chosenView, setChosenView] = useState<string>('front');
  const [note, setNote] = useState('');
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);

  const catalogById = useMemo(() => {
    const m = new Map<number, SlimProduct>();
    for (const p of catalog) m.set(p.id, p);
    return m;
  }, [catalog]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, cRes, dRes] = await Promise.all([
        fetch('/reconcile/suggestions-manifest.json', { cache: 'no-store' }),
        fetch('/reconcile/catalog-slim.json', { cache: 'no-store' }),
        fetch('/api/reconcile/decision', { cache: 'no-store' }),
      ]);
      const m = await mRes.json();
      const c = await cRes.json();
      const d = await dRes.json();
      setItems(m.items || []);
      setCatalog(Array.isArray(c) ? c : c.products || []);
      setDecisions(d.decisions || {});
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Errore caricamento');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const queue = useMemo(() => {
    if (filter === 'all') return items;
    if (filter === 'pending') return items.filter((i) => !decisions[i.file]);
    if (filter === 'confirmed') return items.filter((i) => decisions[i.file]?.status === 'confirmed');
    if (filter === 'bucket') return items.filter((i) => decisions[i.file]?.status === 'bucket');
    if (filter === 'multi') return items.filter((i) => decisions[i.file]?.status === 'multi');
    return items;
  }, [items, decisions, filter]);

  const current = queue[Math.min(idx, Math.max(0, queue.length - 1))];

  // hydrate working selection from decision or AI top candidate when the current item changes
  useEffect(() => {
    if (!current) return;
    const d = decisions[current.file];
    const top = current.candidates[0];
    if (d) {
      setChosenProductId(d.productId);
      setChosenColorway(d.colorway);
      setChosenView(d.view || current.viewGuess || 'front');
      setNote(d.note || '');
    } else {
      setChosenProductId(top?.productId ?? null);
      setChosenColorway(top?.colorway ?? null);
      setChosenView(normalizeView(current.viewGuess));
      setNote('');
    }
    setQuery('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.file]);

  const chosenProduct = chosenProductId != null ? catalogById.get(chosenProductId) : undefined;

  const targetPreview = useMemo(() => {
    if (!chosenProduct) return null;
    return buildTargetName({ productName: chosenProduct.name, colorway: chosenProduct.isMono ? null : chosenColorway, view: chosenView });
  }, [chosenProduct, chosenColorway, chosenView]);

  const advance = useCallback(() => {
    setIdx((i) => Math.min(i + 1, Math.max(0, queue.length - 1)));
  }, [queue.length]);

  const postDecision = useCallback(async (payload: Partial<Decision>) => {
    setSaving(true);
    try {
      const res = await fetch('/api/reconcile/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setDecisions(json.decisions || {});
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Errore salvataggio');
    } finally {
      setSaving(false);
    }
  }, []);

  const confirm = useCallback(async () => {
    if (!current || !chosenProduct) return;
    await postDecision({
      file: current.file, status: 'confirmed',
      productId: chosenProduct.id, productName: chosenProduct.name, sku: chosenProduct.sku,
      colorway: chosenProduct.isMono ? null : chosenColorway, view: chosenView,
    });
    advance();
  }, [current, chosenProduct, chosenColorway, chosenView, postDecision, advance]);

  const sendToBucket = useCallback(async () => {
    if (!current) return;
    await postDecision({
      file: current.file, status: 'bucket',
      productId: null, productName: '', colorway: null, view: '',
      note: note || current.bucketReason || 'da verificare',
    });
    advance();
  }, [current, note, postDecision, advance]);

  const sendMulti = useCallback(async () => {
    if (!current) return;
    await postDecision({
      file: current.file, status: 'multi',
      productId: null, productName: '', colorway: null, view: '',
      note: note || 'foto con più prodotti',
    });
    advance();
  }, [current, note, postDecision, advance]);

  const resetDecision = useCallback(async (file: string) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/reconcile/decision?file=${encodeURIComponent(file)}`, { method: 'DELETE' });
      const json = await res.json();
      setDecisions(json.decisions || {});
    } finally {
      setSaving(false);
    }
  }, []);

  // recompute counts locally for the header
  useEffect(() => {
    const dec = Object.values(decisions);
    setCounts({
      total: items.length,
      decided: dec.length,
      pending: items.filter((i) => !decisions[i.file]).length,
      confirmed: dec.filter((d) => d.status === 'confirmed').length,
      bucket: dec.filter((d) => d.status === 'bucket').length,
      multi: dec.filter((d) => d.status === 'multi').length,
      skip: dec.filter((d) => d.status === 'skip').length,
    });
  }, [decisions, items]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (!current) return;
      if (e.key >= '1' && e.key <= '5') {
        const n = Number(e.key) - 1;
        const cand = current.candidates[n];
        if (cand && cand.productId != null) {
          setChosenProductId(cand.productId);
          setChosenColorway(cand.colorway);
        }
      } else if (e.key === 'Enter') { void confirm(); }
      else if (e.key.toLowerCase() === 'b') { void sendToBucket(); }
      else if (e.key.toLowerCase() === 'm') { void sendMulti(); }
      else if (e.key === 'ArrowRight') { advance(); }
      else if (e.key === 'ArrowLeft') { setIdx((i) => Math.max(0, i - 1)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, confirm, sendToBucket, sendMulti, advance]);

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return catalog
      .filter((p) => p.name.toLowerCase().includes(q) || p.categories.some((c) => c.toLowerCase().includes(q)) || p.sku.toLowerCase().includes(q))
      .slice(0, 12);
  }, [query, catalog]);

  return (
    <div style={{ minHeight: '100vh', background: C.surface3 }}>
      <nav style={{ borderBottom: `1px solid ${C.border}`, background: C.surface }}>
        <div className="mx-auto max-w-7xl px-6 py-3" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 6, color: C.muted, textDecoration: 'none', fontSize: 14 }}>
            <ArrowLeft size={16} /> Home
          </Link>
          <h1 style={{ fontWeight: 800, color: C.primary, fontSize: 18, margin: 0 }}>Abbina foto → prodotto</h1>
          {counts && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, fontSize: 12 }}>
              <Pill label={`${counts.decided}/${counts.total} decise`} />
              <Pill label={`${counts.confirmed} confermate`} bg={C.accentBg} fg="#3F6B2A" />
              <Pill label={`${counts.bucket} da verificare`} bg="#FFF3D6" fg="#8A6400" />
              <Pill label={`${counts.multi} multiprodotto`} bg="#ECE6F5" fg="#5A3E8A" />
              <a href="/api/reconcile/export" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8, border: `1px solid ${C.border}`, color: C.primary, textDecoration: 'none' }}>
                <Download size={14} /> Esporta
              </a>
            </div>
          )}
        </div>
        <div className="mx-auto max-w-7xl px-6 pb-3" style={{ display: 'flex', gap: 8 }}>
          {(['pending', 'all', 'confirmed', 'bucket', 'multi'] as Filter[]).map((f) => (
            <button key={f} onClick={() => { setFilter(f); setIdx(0); }}
              style={{ padding: '4px 12px', borderRadius: 999, fontSize: 12, border: `1px solid ${filter === f ? C.primary : C.border}`,
                background: filter === f ? C.primary : C.surface, color: filter === f ? '#fff' : C.muted, cursor: 'pointer' }}>
              {f === 'pending' ? 'Da decidere' : f === 'all' ? 'Tutte' : f === 'confirmed' ? 'Confermate' : f === 'bucket' ? 'Da verificare' : 'Multiprodotto'}
            </button>
          ))}
        </div>
      </nav>

      <main className="mx-auto max-w-7xl p-6">
        {loading && <p style={{ color: C.muted }}>Caricamento…</p>}
        {error && <p style={{ color: '#9A3B3B' }}>⚠ {error}</p>}
        {!loading && !error && queue.length === 0 && (
          <div style={{ padding: 40, textAlign: 'center', color: C.muted }}>
            <CheckCircle2 size={32} style={{ color: C.accent }} />
            <p>Nessuna foto in questa vista.</p>
          </div>
        )}

        {current && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 20, alignItems: 'start' }}>
            {/* LEFT: still-life photo */}
            <div style={card()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <Micro>Foto {idx + 1} / {queue.length}</Micro>
                <Micro>{current.file}</Micro>
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={stillThumb(current.file)} alt={current.file}
                style={{ width: '100%', borderRadius: 12, border: `1px solid ${C.border}`, background: C.surface2, display: 'block' }} />
              <div style={{ marginTop: 12, fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
                <div><strong style={{ color: C.primary }}>Vede:</strong> {current.garmentType}</div>
                <div><strong style={{ color: C.primary }}>Colore:</strong> {current.colorDescription}</div>
                {current.disposition === 'bucket' && (
                  <div style={{ marginTop: 6, color: '#8A6400' }}>⚠ {current.bucketReason}</div>
                )}
                {current.flags?.length > 0 && (
                  <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {current.flags.map((f, i) => <Pill key={i} label={f} bg={C.surface2} fg={C.muted} />)}
                  </div>
                )}
              </div>
              {decisions[current.file] && (
                <div style={{ marginTop: 12, padding: 10, borderRadius: 10, background: C.surface2, fontSize: 13 }}>
                  <strong style={{ color: C.primary }}>Decisione salvata:</strong>{' '}
                  {decisions[current.file].status === 'confirmed'
                    ? `${decisions[current.file].productName}${decisions[current.file].colorway ? ' · ' + decisions[current.file].colorway : ''} (${decisions[current.file].view})`
                    : decisions[current.file].status === 'bucket' ? `Da verificare — ${decisions[current.file].note || ''}`
                    : decisions[current.file].status === 'multi' ? `Multiprodotto — ${decisions[current.file].note || ''}` : 'Saltata'}
                  <button onClick={() => resetDecision(current.file)} style={{ marginLeft: 8, fontSize: 12, color: C.primary, background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <RotateCcw size={12} /> rifai
                  </button>
                </div>
              )}
            </div>

            {/* RIGHT: suggestions + controls */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={card()}>
                <Micro>Suggerimenti AI — premi 1-{Math.min(5, current.candidates.length)} per scegliere</Micro>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                  {current.candidates.length === 0 && <p style={{ color: C.muted, fontSize: 13 }}>Nessun candidato — cerca un prodotto sotto.</p>}
                  {current.candidates.map((cand, i) => {
                    const selected = chosenProductId === cand.productId && chosenColorway === cand.colorway;
                    const prod = cand.productId != null ? catalogById.get(cand.productId) : undefined;
                    const thumbFile = thumbForCandidate(prod, cand.colorway);
                    return (
                      <button key={i} onClick={() => { setChosenProductId(cand.productId); setChosenColorway(cand.colorway); }}
                        style={{ display: 'flex', gap: 12, alignItems: 'center', textAlign: 'left', padding: 10, borderRadius: 12, cursor: 'pointer',
                          border: `2px solid ${selected ? C.accent : C.border}`, background: selected ? C.accentBg : C.surface }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {thumbFile
                          ? <img src={catThumb(thumbFile)} alt={cand.productName} style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: `1px solid ${C.border}`, flexShrink: 0 }} />
                          : <div style={{ width: 64, height: 64, borderRadius: 8, background: C.surface2, flexShrink: 0 }} />}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontWeight: 700, color: C.primary, fontSize: 14 }}>{i + 1}. {cand.productName}</span>
                            <ConfBadge c={cand.confidence} />
                          </div>
                          {cand.colorway && <div style={{ fontSize: 13, color: C.muted }}>{cand.colorway}</div>}
                          <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{cand.reason}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* search other product */}
              <div style={card()}>
                <Micro>Cerca un altro prodotto</Micro>
                <div style={{ position: 'relative', marginTop: 8 }}>
                  <Search size={15} style={{ position: 'absolute', left: 10, top: 10, color: C.muted }} />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="nome, categoria o SKU…"
                    style={{ width: '100%', padding: '8px 8px 8px 32px', borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 14 }} />
                </div>
                {searchResults.length > 0 && (
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
                    {searchResults.map((p) => (
                      <button key={p.id} onClick={() => { setChosenProductId(p.id); setChosenColorway(p.isMono ? null : (p.colorways[0]?.colorway ?? null)); setQuery(''); }}
                        style={{ display: 'flex', gap: 10, alignItems: 'center', textAlign: 'left', padding: 6, borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface, cursor: 'pointer' }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {p.primaryThumb && <img src={catThumb(p.primaryThumb)} alt={p.name} style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6, border: `1px solid ${C.border}` }} />}
                        <div style={{ fontSize: 13 }}>
                          <div style={{ fontWeight: 600, color: C.primary }}>{p.name}</div>
                          <div style={{ color: C.muted, fontSize: 11 }}>{p.categories.join(' · ')}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* selection + confirm */}
              <div style={card()}>
                <Micro>Conferma</Micro>
                {chosenProduct ? (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontWeight: 700, color: C.primary }}>{chosenProduct.name}</div>
                    {/* colorway */}
                    {!chosenProduct.isMono && chosenProduct.colorways.length > 0 ? (
                      <label style={{ display: 'block', marginTop: 8, fontSize: 13, color: C.muted }}>
                        Colorway
                        <select value={chosenColorway ?? ''} onChange={(e) => setChosenColorway(e.target.value || null)}
                          style={{ display: 'block', width: '100%', marginTop: 4, padding: 8, borderRadius: 8, border: `1px solid ${C.border}` }}>
                          <option value="">— scegli —</option>
                          {chosenProduct.colorways.map((cw) => (
                            <option key={cw.colorway ?? 'x'} value={cw.colorway ?? ''}>{cw.colorway}</option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <div style={{ marginTop: 6, fontSize: 13, color: C.muted }}>Monocolore — nessun token colore</div>
                    )}
                    {/* view */}
                    <label style={{ display: 'block', marginTop: 8, fontSize: 13, color: C.muted }}>
                      Vista
                      <select value={chosenView} onChange={(e) => setChosenView(e.target.value)}
                        style={{ display: 'block', width: '100%', marginTop: 4, padding: 8, borderRadius: 8, border: `1px solid ${C.border}` }}>
                        {VIEWS.map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </label>
                    {/* filename preview */}
                    {targetPreview && (
                      <div style={{ marginTop: 10, padding: 8, borderRadius: 8, background: C.surface2, fontFamily: 'var(--font-geist-mono, monospace)', fontSize: 12, color: C.primary, wordBreak: 'break-all' }}>
                        {targetPreview}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                      <button onClick={confirm} disabled={saving || (!chosenProduct.isMono && !chosenColorway)}
                        style={btn(C.accent, '#fff', saving || (!chosenProduct.isMono && !chosenColorway))}>
                        <Check size={16} /> Conferma <kbd style={kbd()}>⏎</kbd>
                      </button>
                    </div>
                  </div>
                ) : (
                  <p style={{ color: C.muted, fontSize: 13, marginTop: 8 }}>Scegli un suggerimento o cerca un prodotto.</p>
                )}

                <div style={{ marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
                  <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="nota (opzionale, per 'da verificare' / 'multiprodotto')"
                    style={{ width: '100%', padding: 8, borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13 }} />
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                    <button onClick={sendMulti} disabled={saving} style={btn(C.surface, '#5A3E8A', saving, '#D8C9EE')}>
                      <Layers size={16} /> Multiprodotto <kbd style={kbd()}>M</kbd>
                    </button>
                    <button onClick={sendToBucket} disabled={saving} style={btn(C.surface, '#8A6400', saving, '#FFE6A8')}>
                      <FolderInput size={16} /> Da verificare <kbd style={kbd()}>B</kbd>
                    </button>
                    <button onClick={advance} style={btn(C.surface, C.muted, false, C.border)}>
                      Salta <ArrowRight size={16} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ---- helpers ----
function normalizeView(v: string): string {
  const s = (v || '').toLowerCase();
  const found = (VIEWS as readonly string[]).find((x) => s.includes(x));
  return found || 'front';
}
function thumbForCandidate(prod: SlimProduct | undefined, colorway: string | null): string | null {
  if (!prod) return null;
  if (colorway) {
    const cw = prod.colorways.find((c) => c.colorway === colorway);
    if (cw?.thumb) return cw.thumb;
  }
  return prod.primaryThumb;
}

// ---- tiny presentational components ----
function card(): React.CSSProperties {
  return { borderRadius: 16, border: `1px solid ${C.border}`, background: C.surface, padding: 20, boxShadow: '0 1px 2px rgba(16,61,102,0.04)' };
}
function btn(bg: string, fg: string, disabled: boolean, border?: string): React.CSSProperties {
  return { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderRadius: 10, fontWeight: 700, fontSize: 14,
    background: bg, color: fg, border: `1px solid ${border || bg}`, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 };
}
function kbd(): React.CSSProperties {
  return { fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'rgba(0,0,0,0.12)', fontFamily: 'monospace' };
}
function Micro({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.5, color: C.muted }}>{children}</div>;
}
function Pill({ label, bg = '#EEF1F4', fg = '#4C6583' }: { label: string; bg?: string; fg?: string }) {
  return <span style={{ padding: '3px 9px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: bg, color: fg }}>{label}</span>;
}
function ConfBadge({ c }: { c: Candidate['confidence'] }) {
  const b = confBadge[c];
  return <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', background: b.bg, color: b.fg }}>{b.label}</span>;
}
