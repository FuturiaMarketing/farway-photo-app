import crypto from 'crypto';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { hasDatabaseConnection, readJsonValue, writeJsonValue } from '@/lib/server/db';

export type FarwayErpReviewDecisionStatus =
  | 'pending'
  | 'approved_match'
  | 'create_hidden'
  | 'skip'
  | 'unclear';

export type FarwayErpReviewDecision = {
  groupId: string;
  status: FarwayErpReviewDecisionStatus;
  selectedProductId?: number;
  note?: string;
  updatedAt: string;
};

type MasterRow = Record<string, string>;

type DryRunCandidate = {
  productId?: number;
  variationId?: number | null;
  productName?: string;
  sku?: string;
  color?: string;
  size?: string;
};

type DryRunAction = {
  type?: string;
  source?: {
    sheet?: string;
    row?: number;
    code?: string;
    model?: string;
    color?: string;
    size?: string;
    proposedSku?: string;
  };
  candidates?: DryRunCandidate[];
};

type ReviewGroupDraft = {
  groupId: string;
  styleCode: string;
  contextLabel: string;
  title: string;
  sourceRows: FarwayErpReviewSourceRow[];
  candidateMap: Map<number, FarwayErpReviewCandidate>;
  matchStatuses: Map<string, number>;
};

export type FarwayErpReviewSourceRow = {
  sheet: string;
  row: number;
  code: string;
  model: string;
  description: string;
  productKind: string;
  color: string;
  canonicalColor: string;
  size: string;
  canonicalSize: string;
  season: string;
  year: string;
  location: string;
  stockQuantity: number;
  matchStatus: string;
  notes: string;
};

export type FarwayErpReviewCandidate = {
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

export type FarwayErpReviewGroup = {
  groupId: string;
  styleCode: string;
  title: string;
  rowCount: number;
  totalQuantity: number;
  priority: 'alta' | 'media' | 'bassa';
  needsCodeMapping: boolean;
  hasSkuConflict: boolean;
  hasMultipleCandidates: boolean;
  sheets: string[];
  seasons: string[];
  years: string[];
  models: string[];
  colors: string[];
  sizes: string[];
  locations: string[];
  matchStatuses: Array<{ status: string; count: number }>;
  candidates: FarwayErpReviewCandidate[];
  sourceRows: FarwayErpReviewSourceRow[];
  decision: FarwayErpReviewDecision;
};

export type FarwayErpReviewPack = {
  generatedAt: string;
  sourceOutputDir: string;
  sourceDryRun: string;
  sourceMaster: string;
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
  groups: FarwayErpReviewGroup[];
};

const decisionsFilePath = path.join(process.cwd(), 'data', 'tmp-farway-erp-review-decisions.json');
const stableReviewDir = path.join(process.cwd(), 'data', 'farway-erp-review-latest');
const dbNamespace = 'farway_erp';
const dbDecisionsKey = 'product_review_decisions';

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells;
}

function parseCsv(raw: string): MasterRow[] {
  const lines = raw.trim().split(/\r?\n/);
  if (lines.length <= 1) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
  });
}

function normalizeText(value: string) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCode(value: string) {
  return String(value || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9-]+/g, '')
    .replace(/^ABO(?=\d)/, 'AB0')
    .trim();
}

function titleCaseFallback(value: string) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join(' ');
}

function deriveStyleCode(row: Pick<FarwayErpReviewSourceRow, 'code' | 'model' | 'description'>) {
  const explicitCode = normalizeCode(row.code);
  const modelCode = normalizeCode(row.model);

  for (const candidate of [explicitCode, modelCode]) {
    if (!candidate) continue;

    const faryMatch = candidate.match(/^FARY-?[A-Z]{2,5}\d{1,2}/);
    if (faryMatch) return faryMatch[0].replace(/^FARY(?!-)/, 'FARY-');

    const styleMatch = candidate.match(/^([A-Z]{2,6})(\d{1,2})/);
    if (styleMatch) return `${styleMatch[1]}${styleMatch[2].padStart(2, '0')}`;

    if (/^[A-Z]{3,}$/.test(candidate)) return candidate.slice(0, 24);
  }

  const textFallback = normalizeText(row.model || row.description || 'senza codice');
  return titleCaseFallback(textFallback).slice(0, 42) || 'Senza codice';
}

function buildGroupContext(row: FarwayErpReviewSourceRow, styleCode: string) {
  const sheet = String(row.sheet || '').trim();
  const seasonYear = [row.season, row.year]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  const sourceColor = String(row.color || '').trim();
  const colorContext = sourceColor || String(row.canonicalColor || '').trim() || 'senza colore';
  const key = [styleCode, sheet, seasonYear, colorContext].filter(Boolean).join('::');
  const label = [styleCode, seasonYear, colorContext].filter(Boolean).join(' - ');

  return {
    key,
    label,
  };
}

function stableGroupId(groupKey: string) {
  return crypto.createHash('sha1').update(groupKey).digest('hex').slice(0, 12);
}

function countMapToSortedArray(map: Map<string, number>) {
  return Array.from(map.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
}

function uniqueSorted(values: string[], max = 16) {
  return Array.from(
    new Set(values.map((value) => String(value || '').trim()).filter(Boolean))
  )
    .sort((a, b) => a.localeCompare(b))
    .slice(0, max);
}

function mostFrequent(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values.map((entry) => String(entry || '').trim()).filter(Boolean)) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';
}

function toNumber(value: string) {
  const parsed = Number(String(value || '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function findLatestReconcileOutput() {
  const dataDir = path.join(process.cwd(), 'data');
  const stableDryRunPath = path.join(stableReviewDir, 'dry-run-import.json');
  const stableMasterPath = path.join(stableReviewDir, 'master-normalizzato.csv');
  try {
    await Promise.all([readFile(stableDryRunPath, 'utf8'), readFile(stableMasterPath, 'utf8')]);
    return { outputDir: stableReviewDir, dryRunPath: stableDryRunPath, masterPath: stableMasterPath };
  } catch {
    // Local development can still use the ignored temporary dry-run folders.
  }

  const entries = await readdir(dataDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('tmp-farway-erp-reconcile-'))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));

  for (const candidate of candidates) {
    const outputDir = path.join(dataDir, candidate);
    const dryRunPath = path.join(outputDir, 'dry-run-import.json');
    const masterPath = path.join(outputDir, 'master-normalizzato.csv');

    try {
      await Promise.all([readFile(dryRunPath, 'utf8'), readFile(masterPath, 'utf8')]);
      return { outputDir, dryRunPath, masterPath };
    } catch {
      continue;
    }
  }

  throw new Error('Nessun output dry-run Farway ERP trovato. Esegui prima npm run farway:erp:reconcile.');
}

async function readDecisions() {
  if (hasDatabaseConnection()) {
    const stored = await readJsonValue<{ decisions?: Record<string, FarwayErpReviewDecision> }>(
      dbNamespace,
      dbDecisionsKey
    );
    return stored?.decisions || {};
  }

  try {
    const parsed = JSON.parse(await readFile(decisionsFilePath, 'utf8')) as {
      decisions?: Record<string, FarwayErpReviewDecision>;
    };
    return parsed.decisions || {};
  } catch {
    return {};
  }
}

async function writeDecisions(decisions: Record<string, FarwayErpReviewDecision>) {
  if (hasDatabaseConnection()) {
    await writeJsonValue(dbNamespace, dbDecisionsKey, {
      updatedAt: new Date().toISOString(),
      decisions,
    });
    return;
  }

  await mkdir(path.dirname(decisionsFilePath), { recursive: true });
  await writeFile(
    decisionsFilePath,
    `${JSON.stringify({ updatedAt: new Date().toISOString(), decisions }, null, 2)}\n`,
    'utf8'
  );
}

function normalizeDecision(input: Partial<FarwayErpReviewDecision>) {
  const allowed = new Set<FarwayErpReviewDecisionStatus>([
    'pending',
    'approved_match',
    'create_hidden',
    'skip',
    'unclear',
  ]);
  const status = allowed.has(input.status || 'pending') ? input.status || 'pending' : 'pending';
  const selectedProductId = Number(input.selectedProductId || 0);

  return {
    groupId: String(input.groupId || '').trim(),
    status,
    ...(selectedProductId > 0 ? { selectedProductId } : {}),
    note: String(input.note || '').trim(),
    updatedAt: new Date().toISOString(),
  };
}

function defaultDecision(groupId: string): FarwayErpReviewDecision {
  return {
    groupId,
    status: 'pending',
    note: '',
    updatedAt: '',
  };
}

function buildSourceRow(row: MasterRow): FarwayErpReviewSourceRow {
  return {
    sheet: row.sourceSheet || '',
    row: Math.round(toNumber(row.sourceRow)),
    code: row.sourceCode || '',
    model: row.sourceModel || '',
    description: row.sourceDescription || '',
    productKind: row.productKind || '',
    color: row.sourceColor || '',
    canonicalColor: row.canonicalColor || '',
    size: row.sourceSize || '',
    canonicalSize: row.canonicalSize || '',
    season: row.season || '',
    year: row.year || '',
    location: row.location || '',
    stockQuantity: toNumber(row.stockQuantity),
    matchStatus: row.matchStatus || '',
    notes: row.notes || '',
  };
}

function addCandidate(group: ReviewGroupDraft, candidate: DryRunCandidate) {
  const productId = Number(candidate.productId || 0);
  if (!productId) return;

  const existing =
    group.candidateMap.get(productId) ||
    ({
      productId,
      productName: String(candidate.productName || `Prodotto ${productId}`),
      hitCount: 0,
      variationCount: 0,
      sampleSku: '',
      skus: [],
      colors: [],
      sizes: [],
      variationIds: [],
    } satisfies FarwayErpReviewCandidate);

  existing.hitCount += 1;

  const variationId = Number(candidate.variationId || 0);
  if (variationId > 0 && !existing.variationIds.includes(variationId)) {
    existing.variationIds.push(variationId);
    existing.variationCount = existing.variationIds.length;
  }

  const sku = String(candidate.sku || '').trim();
  if (sku && !existing.skus.includes(sku)) existing.skus.push(sku);
  if (!existing.sampleSku && sku) existing.sampleSku = sku;

  const color = String(candidate.color || '').trim();
  if (color && !existing.colors.includes(color)) existing.colors.push(color);

  const size = String(candidate.size || '').trim();
  if (size && !existing.sizes.includes(size)) existing.sizes.push(size);

  group.candidateMap.set(productId, existing);
}

function inferKindFromCandidateName(productName: string) {
  const text = normalizeText(productName);
  if (/\b(abito|vestito|sopravveste)\b/.test(text)) return 'abito';
  if (/\b(camicia|blusa|coreana)\b/.test(text)) return 'camicia';
  if (/\b(pantalone|pantaloni|pantaloncino|short|bermuda|salopette)\b/.test(text)) return 'pantalone';
  if (/\b(gonna)\b/.test(text)) return 'gonna';
  if (/\b(t shirt|tshirt|maglietta)\b/.test(text)) return 't-shirt';
  if (/\b(felpa)\b/.test(text)) return 'felpa';
  if (/\b(borsa|yes|capri)\b/.test(text)) return 'borsa';
  if (/\b(scrunchies|scrunchie|elastico)\b/.test(text)) return 'scrunchies';
  if (/\b(fiocco|fermaglio|bow)\b/.test(text)) return 'fiocco';
  if (/\b(cerchietto)\b/.test(text)) return 'cerchietto';
  return '';
}

function candidateCompatibleWithRow(candidate: DryRunCandidate, row: FarwayErpReviewSourceRow) {
  const rowKind = normalizeText(row.productKind);
  const candidateKind = inferKindFromCandidateName(candidate.productName || '');
  const exactSku = normalizeCode(candidate.sku || '') && normalizeCode(candidate.sku || '') === normalizeCode(row.code);

  if (exactSku) return true;
  if (!rowKind) return row.matchStatus === 'review_sku_attribute_conflict';
  return rowKind === candidateKind;
}

export async function saveFarwayErpReviewDecision(input: Partial<FarwayErpReviewDecision>) {
  const decision = normalizeDecision(input);
  if (!decision.groupId) {
    throw new Error('Decisione non valida: manca groupId.');
  }

  const decisions = await readDecisions();
  decisions[decision.groupId] = decision;
  await writeDecisions(decisions);
  return decision;
}

export async function buildFarwayErpReviewPack(): Promise<FarwayErpReviewPack> {
  const latest = await findLatestReconcileOutput();
  const [masterRaw, dryRunRaw, decisions] = await Promise.all([
    readFile(latest.masterPath, 'utf8'),
    readFile(latest.dryRunPath, 'utf8'),
    readDecisions(),
  ]);
  const masterRows = parseCsv(masterRaw);
  const dryRun = JSON.parse(dryRunRaw) as { generatedAt?: string; actions?: DryRunAction[] };
  const masterBySource = new Map(
    masterRows.map((row) => [`${row.sourceSheet}::${row.sourceRow}`, row])
  );
  const groupMap = new Map<string, ReviewGroupDraft>();

  for (const action of dryRun.actions || []) {
    if (action.type !== 'review_required') continue;

    const source = action.source || {};
    const masterRow = masterBySource.get(`${source.sheet || ''}::${source.row || ''}`);
    const sourceRow = buildSourceRow(masterRow || {
      sourceSheet: source.sheet || '',
      sourceRow: String(source.row || ''),
      sourceCode: source.code || '',
      sourceModel: source.model || '',
      sourceColor: source.color || '',
      sourceSize: source.size || '',
      matchStatus: 'review_required',
    });
    const styleCode = deriveStyleCode(sourceRow);
    const groupContext = buildGroupContext(sourceRow, styleCode);
    const groupId = stableGroupId(groupContext.key);
    const titleModel = sourceRow.model || sourceRow.description || sourceRow.code || 'Prodotto da riconciliare';

    const group =
      groupMap.get(groupId) ||
      ({
        groupId,
        styleCode,
        contextLabel: groupContext.label,
        title: `${groupContext.label} - ${titleModel}`,
        sourceRows: [],
        candidateMap: new Map<number, FarwayErpReviewCandidate>(),
        matchStatuses: new Map<string, number>(),
      } satisfies ReviewGroupDraft);

    group.sourceRows.push(sourceRow);
    group.matchStatuses.set(
      sourceRow.matchStatus || 'review_required',
      (group.matchStatuses.get(sourceRow.matchStatus || 'review_required') || 0) + 1
    );

    const shouldCollectCandidates =
      sourceRow.matchStatus === 'review_sku_attribute_conflict' ||
      Boolean(normalizeText(sourceRow.productKind));

    if (shouldCollectCandidates) {
      for (const candidate of action.candidates || []) {
        if (candidateCompatibleWithRow(candidate, sourceRow)) {
          addCandidate(group, candidate);
        }
      }
    }

    groupMap.set(groupId, group);
  }

  const groups = Array.from(groupMap.values()).map((group) => {
    const sourceRows = group.sourceRows.sort((a, b) => a.sheet.localeCompare(b.sheet) || a.row - b.row);
    const rowCount = sourceRows.length;
    const totalQuantity = sourceRows.reduce((sum, row) => sum + row.stockQuantity, 0);
    const models = uniqueSorted(sourceRows.map((row) => row.model || row.description), 10);
    const hasSkuConflict = sourceRows.some((row) => row.matchStatus === 'review_sku_attribute_conflict');
    const hasMultipleCandidates = sourceRows.some((row) => row.matchStatus === 'review_multiple_candidates');
    const hasDecodedProductKind = sourceRows.some((row) => Boolean(normalizeText(row.productKind)));
    const needsCodeMapping = !hasDecodedProductKind || group.styleCode === 'Senza codice';
    const rawCandidates = Array.from(group.candidateMap.values())
      .map((candidate) => ({
        ...candidate,
        skus: uniqueSorted(candidate.skus, 8),
        colors: uniqueSorted(candidate.colors, 8),
        sizes: uniqueSorted(candidate.sizes, 8),
        variationIds: candidate.variationIds.sort((a, b) => a - b),
      }))
      .sort((a, b) => b.hitCount - a.hitCount || b.variationCount - a.variationCount || a.productName.localeCompare(b.productName))
      .slice(0, 5);
    const candidates = hasSkuConflict || hasDecodedProductKind ? rawCandidates : [];
    const decision = decisions[group.groupId] || defaultDecision(group.groupId);

    return {
      groupId: group.groupId,
      styleCode: group.styleCode,
      title: group.contextLabel || `${group.styleCode} - ${mostFrequent(models) || titleCaseFallback(group.styleCode)}`,
      rowCount,
      totalQuantity,
      priority: rowCount >= 10 ? 'alta' : rowCount >= 3 ? 'media' : 'bassa',
      needsCodeMapping,
      hasSkuConflict,
      hasMultipleCandidates,
      sheets: uniqueSorted(sourceRows.map((row) => row.sheet), 8),
      seasons: uniqueSorted(sourceRows.map((row) => row.season), 4),
      years: uniqueSorted(sourceRows.map((row) => row.year), 8),
      models,
      colors: uniqueSorted(sourceRows.flatMap((row) => [row.canonicalColor, row.color]), 12),
      sizes: uniqueSorted(sourceRows.flatMap((row) => [row.canonicalSize, row.size]), 12),
      locations: uniqueSorted(sourceRows.map((row) => row.location), 4),
      matchStatuses: countMapToSortedArray(group.matchStatuses),
      candidates,
      sourceRows: sourceRows.slice(0, 40),
      decision,
    } satisfies FarwayErpReviewGroup;
  });

  groups.sort((a, b) => {
    const statusWeight = (group: FarwayErpReviewGroup) => (group.decision.status === 'pending' ? 0 : 1);
    return (
      statusWeight(a) - statusWeight(b) ||
      b.rowCount - a.rowCount ||
      Number(b.hasSkuConflict) - Number(a.hasSkuConflict) ||
      a.styleCode.localeCompare(b.styleCode)
    );
  });

  const top20 = [...groups].sort((a, b) => b.rowCount - a.rowCount).slice(0, 20);
  const summary = {
    reviewRows: groups.reduce((sum, group) => sum + group.rowCount, 0),
    groups: groups.length,
    highImpactGroups: groups.filter((group) => group.priority === 'alta').length,
    pendingGroups: groups.filter((group) => group.decision.status === 'pending').length,
    approvedGroups: groups.filter((group) => group.decision.status === 'approved_match').length,
    createHiddenGroups: groups.filter((group) => group.decision.status === 'create_hidden').length,
    skippedGroups: groups.filter((group) => group.decision.status === 'skip').length,
    unclearGroups: groups.filter((group) => group.decision.status === 'unclear').length,
    rowsCoveredByTop20: top20.reduce((sum, group) => sum + group.rowCount, 0),
  };

  return {
    generatedAt: new Date().toISOString(),
    sourceOutputDir: latest.outputDir,
    sourceDryRun: latest.dryRunPath,
    sourceMaster: latest.masterPath,
    decisionsPath: hasDatabaseConnection()
      ? `${dbNamespace}:${dbDecisionsKey}`
      : decisionsFilePath,
    summary,
    groups,
  };
}

function csvEscape(value: unknown) {
  const stringValue = String(value ?? '');
  if (/[",\r\n]/.test(stringValue)) return `"${stringValue.replace(/"/g, '""')}"`;
  return stringValue;
}

export function buildFarwayErpReviewDecisionsCsv(pack: FarwayErpReviewPack) {
  const headers = [
    'groupId',
    'status',
    'selectedProductId',
    'styleCode',
    'title',
    'rowCount',
    'totalQuantity',
    'priority',
    'topCandidateProductId',
    'topCandidateName',
    'note',
  ];
  const lines = [headers.join(',')];

  for (const group of pack.groups) {
    const topCandidate = group.candidates[0];
    lines.push(
      [
        group.groupId,
        group.decision.status,
        group.decision.selectedProductId || '',
        group.styleCode,
        group.title,
        group.rowCount,
        group.totalQuantity,
        group.priority,
        topCandidate?.productId || '',
        topCandidate?.productName || '',
        group.decision.note || '',
      ]
        .map(csvEscape)
        .join(',')
    );
  }

  return `${lines.join('\n')}\n`;
}
