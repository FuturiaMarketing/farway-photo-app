import crypto from 'crypto';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { hasDatabaseConnection, readJsonValue, writeJsonValue } from '@/lib/server/db';

export type FarwayErpLegendKind = 'color' | 'size';

export type FarwayErpLegendDecision = {
  itemId: string;
  kind: FarwayErpLegendKind;
  sourceValue: string;
  selectedValue: string;
  note?: string;
  updatedAt: string;
};

export type FarwayErpLegendRow = {
  itemId: string;
  kind: FarwayErpLegendKind;
  sourceValue: string;
  sourceCount: number;
  currentProposal: string;
  suggestedValues: string[];
  selectedValue: string;
  status: 'pending' | 'approved';
  note: string;
};

export type FarwayErpLegendsPack = {
  generatedAt: string;
  decisionsPath: string;
  sources: {
    colorLegend: string;
    colorTerms: string;
    sizeTerms: string;
    master: string;
  };
  destinations: Record<FarwayErpLegendKind, string[]>;
  summary: {
    colorRows: number;
    sizeRows: number;
    pendingColorRows: number;
    pendingSizeRows: number;
    approvedColorRows: number;
    approvedSizeRows: number;
  };
  rows: Record<FarwayErpLegendKind, FarwayErpLegendRow[]>;
};

type CsvRow = Record<string, string>;

const dataDir = path.join(process.cwd(), 'data');
const decisionsFilePath = path.join(dataDir, 'tmp-farway-erp-legend-decisions.json');
const seedDecisionsFilePath = path.join(dataDir, 'farway-erp-legend-seed-decisions.json');
const dbNamespace = 'farway_erp';
const dbDecisionsKey = 'legend_decisions';
const noSizeLabel = 'Nessuna taglia';

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

function parseCsv(raw: string): CsvRow[] {
  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
  });
}

function csvEscape(value: string | number) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(rows: Array<Record<string, string | number>>, headers: string[]) {
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header] || '')).join(',')),
  ].join('\n');
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

function stableItemId(kind: FarwayErpLegendKind, sourceValue: string) {
  return crypto.createHash('sha1').update(`${kind}:${sourceValue}`).digest('hex').slice(0, 12);
}

function uniqueValues(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function findDestination(destinations: string[], value: string) {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  return destinations.find((destination) => normalizeText(destination) === normalized) || '';
}

function addSuggestion(target: string[], destinations: string[], value: string) {
  const destination = findDestination(destinations, value);
  if (destination && !target.includes(destination)) target.push(destination);
}

function ensureThreeSuggestions(
  suggestions: string[],
  destinations: string[],
  fallback: string[]
) {
  const next = uniqueValues(suggestions).filter((value) => destinations.includes(value));
  for (const value of fallback) {
    if (next.length >= 3) break;
    addSuggestion(next, destinations, value);
  }
  for (const value of destinations) {
    if (next.length >= 3) break;
    addSuggestion(next, destinations, value);
  }
  return next.slice(0, 3);
}

function colorFallbacksFor(value: string) {
  const normalized = normalizeText(value);
  const fallbacks: string[] = [];

  const add = (...items: string[]) => fallbacks.push(...items);

  if (/\b(arancione|orange)\b/.test(normalized)) add('Giallo e ocra', 'Rosso e ciliegia', 'Bordeaux e mattone');
  if (/\b(bordeaux|bordo|mattone)\b/.test(normalized)) add('Bordeaux e mattone', 'Rosso e ciliegia', 'Prugna profondo');
  if (/\b(giallo|yellow|ocra|cedro|chardonnay|chardonney|sudan|chd|cdr)\b/.test(normalized)) add('Giallo e ocra', 'Beige e sabbia', 'Marrone e mocha');
  if (/\b(rosso|red|tango|amb|ciliegia|cherry)\b/.test(normalized)) add('Rosso e ciliegia', 'Bordeaux e mattone', 'Fucsia e rosa vivace');
  if (/\b(rosa|rose|pink|nude|cipria|renai|petunia|zpm|brp)\b/.test(normalized)) add('Rosa cipria e nude', 'Rosa pastello e antico', 'Fucsia e rosa vivace');
  if (/\b(fucsia|fuchsia|crp|crs)\b/.test(normalized)) add('Fucsia e rosa vivace', 'Rosa pastello e antico', 'Rosa cipria e nude');
  if (/\b(blu|blue|bluette|bonnet|mrm)\b/.test(normalized)) add('Blu e azzurro intenso', 'Azzurro polvere e denim', 'Blu navy e notte');
  if (/\b(azzurro|denim|acqua|celeste|polvere|azafata|spr|vyc)\b/.test(normalized)) add('Azzurro polvere e denim', 'Celeste lino e polvere', 'Blu e azzurro intenso');
  if (/\b(navy|notte|noche)\b/.test(normalized)) add('Blu navy e notte', 'Blu e azzurro intenso', 'Antracite e grigio scuro');
  if (/\b(verde|green|kaki|khaki|cedar|liquen|salvia|bosco|militare|igr)\b/.test(normalized)) add('Verde khaki e militare', 'Verde bosco e scuri', 'Verde salvia e aloe');
  if (/\b(white|wht|bianco)\b/.test(normalized)) add('Bianco puro', 'Off-white e cloud', 'Panna e avorio');
  if (/\b(panna|avorio|ivory|ecru|ecru|lino|natural|natur|ntp|cbm|whm|li ps)\b/.test(normalized)) add('Panna e avorio', 'Ecru e lino naturale', 'Off-white e cloud');
  if (/\b(sand|sabbia|beige)\b/.test(normalized)) add('Beige e sabbia', 'Panna e avorio', 'Marrone e mocha');
  if (/\b(marrone|brown|mocha|cappuccino)\b/.test(normalized)) add('Marrone e mocha', 'Beige e sabbia', 'Giallo e ocra');
  if (/\b(grigio|grey|gray|cinder|cid|antracite)\b/.test(normalized)) add('Grigio melange e chiaro', 'Antracite e grigio scuro', 'Nero');
  if (/\b(nero|black)\b/.test(normalized)) add('Nero', 'Antracite e grigio scuro', 'Blu navy e notte');
  if (/\b(lilla|lavanda|lavender|lilac|lillac|viola|prugna)\b/.test(normalized)) add('Lilla e lavanda', 'Viola', 'Prugna profondo');
  if (/\b(marina|mare|stella)\b/.test(normalized)) add('Fantasia marina', 'Azzurro polvere e denim', 'Fantasie: natura');
  if (/\b(gatti|gatto|cat|zebra|giraffa|elefante|animal|animali|zeb|gfr|bat)\b/.test(normalized)) add('Fantasie: animali', 'Fantasie: natura', 'Fantasia marina');
  if (/\b(flower|flowers|fiore|fiori|natura|aquiloni|acquloni|ciliegie|tejido|allover|karo|jumbo|lips|pks|fks)\b/.test(normalized)) add('Fantasie: natura', 'Fantasie: animali', 'Fantasia marina');
  if (/\b(personaggi|fsk|acp)\b/.test(normalized)) add('Fantasie: personaggi', 'Fantasie: natura', 'Fantasie: animali');

  return fallbacks;
}

const relatedColors: Record<string, string[]> = {
  'Panna e avorio': ['Ecru e lino naturale', 'Off-white e cloud', 'Beige e sabbia'],
  'Ecru e lino naturale': ['Panna e avorio', 'Off-white e cloud', 'Cam11 Ecru'],
  'Off-white e cloud': ['Panna e avorio', 'Bianco puro', 'Ecru e lino naturale'],
  'Bianco puro': ['Off-white e cloud', 'Panna e avorio', 'Ecru e lino naturale'],
  'Azzurro polvere e denim': ['Celeste lino e polvere', 'Blu e azzurro intenso', 'Blu navy e notte'],
  'Celeste lino e polvere': ['Azzurro polvere e denim', 'Blu e azzurro intenso', 'Ecru e lino naturale'],
  'Blu e azzurro intenso': ['Azzurro polvere e denim', 'Blu navy e notte', 'Bering sea'],
  'Blu navy e notte': ['Blu e azzurro intenso', 'Azzurro polvere e denim', 'Nero'],
  'Verde khaki e militare': ['Verde bosco e scuri', 'Verde salvia e aloe', 'Beige e sabbia'],
  'Verde bosco e scuri': ['Verde khaki e militare', 'Verde salvia e aloe', 'Bering sea'],
  'Verde salvia e aloe': ['Verde khaki e militare', 'Verde bosco e scuri', 'Celeste lino e polvere'],
  'Rosa cipria e nude': ['Rosa pastello e antico', 'Fucsia e rosa vivace', 'Panna e avorio'],
  'Rosa pastello e antico': ['Rosa cipria e nude', 'Fucsia e rosa vivace', 'Lilla e lavanda'],
  'Fucsia e rosa vivace': ['Rosa pastello e antico', 'Rosa cipria e nude', 'Rosso e ciliegia'],
  'Rosso e ciliegia': ['Bordeaux e mattone', 'Fucsia e rosa vivace', 'Prugna profondo'],
  'Bordeaux e mattone': ['Rosso e ciliegia', 'Prugna profondo', 'Marrone e mocha'],
  'Giallo e ocra': ['Beige e sabbia', 'Marrone e mocha', 'Panna e avorio'],
  'Beige e sabbia': ['Panna e avorio', 'Ecru e lino naturale', 'Marrone e mocha'],
  'Marrone e mocha': ['Beige e sabbia', 'Giallo e ocra', 'Bordeaux e mattone'],
  'Fantasie: natura': ['Fantasie: animali', 'Fantasia marina', 'Fantasie: personaggi'],
  'Fantasie: animali': ['Fantasie: natura', 'Fantasia marina', 'Fantasie: personaggi'],
  'Fantasia marina': ['Fantasie: natura', 'Fantasie: animali', 'Azzurro polvere e denim'],
  'Fantasie: personaggi': ['Fantasie: natura', 'Fantasie: animali', 'Fucsia e rosa vivace'],
};

function buildColorSuggestions(sourceValue: string, proposal: string, destinations: string[]) {
  const suggestions: string[] = [];
  addSuggestion(suggestions, destinations, proposal);
  for (const value of colorFallbacksFor(sourceValue)) addSuggestion(suggestions, destinations, value);
  for (const value of relatedColors[suggestions[0]] || []) addSuggestion(suggestions, destinations, value);
  return ensureThreeSuggestions(suggestions, destinations, ['Panna e avorio', 'Verde khaki e militare', 'Rosa cipria e nude']);
}

function parseLegacySize(value: string) {
  const normalized = normalizeText(value).replace(/\banni?\b/g, 'anni').replace(/\bmesi?\b/g, 'mesi');
  const adult = normalized.match(/^(xxs|xs|s|m|l|xl|xxl)$/i)?.[1]?.toUpperCase() || '';
  if (adult) return { unit: 'adult', amount: 0, adult };
  if (/^(os|one size|tu|unica)$/.test(normalized)) return { unit: 'none', amount: 0, adult: '' };

  const monthsMatch = normalized.match(/^(\d{1,2})\s*(m|mesi)$/);
  if (monthsMatch) return { unit: 'months', amount: Number(monthsMatch[1]), adult: '' };

  const yearsMatch = normalized.match(/^(\d{1,2})\s*(y|anni|anno)$/);
  if (yearsMatch) return { unit: 'years', amount: Number(yearsMatch[1]), adult: '' };

  const numberMatch = normalized.match(/^(\d{1,2})$/);
  if (numberMatch) return { unit: 'years', amount: Number(numberMatch[1]), adult: '' };

  return { unit: '', amount: 0, adult: '' };
}

function isLikelySize(value: string) {
  const normalized = normalizeText(value);
  if (!normalized) return false;
  if (/\b(vendita|fattura|risulta|risultano|magazzino|doha|mamma|kawal|schole|prodotta|pezzi|taglia)\b/.test(normalized)) {
    return false;
  }
  const parsed = parseLegacySize(value);
  if (!parsed.unit) return false;
  if (parsed.unit === 'months') return parsed.amount > 0 && parsed.amount <= 36;
  if (parsed.unit === 'years') return parsed.amount > 0 && parsed.amount <= 14;
  return true;
}

function currentSizeProposal(sourceValue: string, canonicalValues: Map<string, number>, destinations: string[]) {
  const [canonical] = Array.from(canonicalValues.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || ['', 0];
  const exactCanonical = findDestination(destinations, canonical);
  if (exactCanonical) return exactCanonical;

  const parsed = parseLegacySize(sourceValue);
  if (parsed.unit === 'adult') return findDestination(destinations, parsed.adult);
  if (parsed.unit === 'none') return noSizeLabel;
  return '';
}

function buildSizeFallbacks(sourceValue: string) {
  const parsed = parseLegacySize(sourceValue);
  if (parsed.unit === 'adult') return [parsed.adult, 'M', 'S'];
  if (parsed.unit === 'none') return [noSizeLabel, 'XS', 'S'];

  if (parsed.unit === 'months') {
    if (parsed.amount <= 3) return ['0-3 mesi', '3-6 mesi', '6-9 mesi'];
    if (parsed.amount <= 6) return ['3-6 mesi', '6-9 mesi', '0-3 mesi'];
    if (parsed.amount <= 9) return ['6-9 mesi', '9-12 mesi', '1 anno'];
    if (parsed.amount <= 12) return ['9-12 mesi', '1 anno', '6-9 mesi'];
    if (parsed.amount <= 18) return ['1 anno', '2 anni', '9-12 mesi'];
    if (parsed.amount <= 24) return ['2 anni', '1 anno', '3-4 anni'];
    return ['3-4 anni', '2 anni', '5-6 anni'];
  }

  if (parsed.unit === 'years') {
    if (parsed.amount <= 1) return ['1 anno', '2 anni', '9-12 mesi'];
    if (parsed.amount === 2) return ['2 anni', '1 anno', '3-4 anni'];
    if (parsed.amount <= 4) return ['3-4 anni', '2 anni', '5-6 anni'];
    if (parsed.amount <= 6) return ['5-6 anni', '3-4 anni', '7-8 anni'];
    if (parsed.amount <= 8) return ['7-8 anni', '5-6 anni', '9-10 anni'];
    if (parsed.amount <= 10) return ['9-10 anni', '7-8 anni', '11-12 anni'];
    return ['11-12 anni', '9-10 anni', '7-8 anni'];
  }

  return ['3-4 anni', '5-6 anni', '2 anni'];
}

function buildSizeSuggestions(sourceValue: string, proposal: string, destinations: string[]) {
  const suggestions: string[] = [];
  addSuggestion(suggestions, destinations, proposal);
  for (const value of buildSizeFallbacks(sourceValue)) addSuggestion(suggestions, destinations, value);
  return ensureThreeSuggestions(suggestions, destinations, ['3-4 anni', '5-6 anni', '2 anni']);
}

async function findLatestMasterPath() {
  const entries = await readdir(dataDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('tmp-farway-erp-reconcile-'))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));

  for (const candidate of candidates) {
    const masterPath = path.join(dataDir, candidate, 'master-normalizzato.csv');
    try {
      await readFile(masterPath, 'utf8');
      return masterPath;
    } catch {
      continue;
    }
  }

  return null;
}

async function readDecisions() {
  if (hasDatabaseConnection()) {
    const dbValue = await readJsonValue<{ decisions?: FarwayErpLegendDecision[] }>(dbNamespace, dbDecisionsKey);
    if (Array.isArray(dbValue?.decisions) && dbValue.decisions.length > 0) {
      return new Map(dbValue.decisions.map((decision) => [decision.itemId, decision]));
    }
  }

  try {
    const parsed = JSON.parse(await readFile(decisionsFilePath, 'utf8')) as { decisions?: FarwayErpLegendDecision[] };
    return new Map((parsed.decisions || []).map((decision) => [decision.itemId, decision]));
  } catch {
    try {
      const parsed = JSON.parse(await readFile(seedDecisionsFilePath, 'utf8')) as { decisions?: FarwayErpLegendDecision[] };
      return new Map((parsed.decisions || []).map((decision) => [decision.itemId, decision]));
    } catch {
      return new Map<string, FarwayErpLegendDecision>();
    }
  }
}

async function writeDecisions(decisions: Map<string, FarwayErpLegendDecision>) {
  const rows = Array.from(decisions.values()).sort((a, b) => a.kind.localeCompare(b.kind) || a.sourceValue.localeCompare(b.sourceValue));
  if (hasDatabaseConnection()) {
    await writeJsonValue(dbNamespace, dbDecisionsKey, { decisions: rows });
    return;
  }

  await mkdir(path.dirname(decisionsFilePath), { recursive: true });
  await writeFile(decisionsFilePath, `${JSON.stringify({ decisions: rows }, null, 2)}\n`, 'utf8');
}

function applyDecision(
  row: Omit<FarwayErpLegendRow, 'selectedValue' | 'status' | 'note'>,
  decision?: FarwayErpLegendDecision,
  autoApprovedNote = ''
): FarwayErpLegendRow {
  const isAutoApproved = Boolean(autoApprovedNote && row.currentProposal);
  return {
    ...row,
    selectedValue: decision?.selectedValue || row.currentProposal,
    status: decision || isAutoApproved ? 'approved' : 'pending',
    note: decision?.note || autoApprovedNote,
  };
}

function normalizeSizeAlias(value: string) {
  const normalized = normalizeText(value);
  const monthCompact = normalized.match(/^(\d{1,2})\s*m(?:esi)?$/);
  if (monthCompact) return `${Number(monthCompact[1])} mesi`;

  const monthJoined = normalized.match(/^(\d{1,2})mesi$/);
  if (monthJoined) return `${Number(monthJoined[1])} mesi`;

  const yearCompact = normalized.match(/^(\d{1,2})\s*y$/);
  if (yearCompact) {
    const amount = Number(yearCompact[1]);
    return amount === 1 ? '1 anno' : `${amount} anni`;
  }

  const yearJoined = normalized.match(/^(\d{1,2})anni$/);
  if (yearJoined) {
    const amount = Number(yearJoined[1]);
    return amount === 1 ? '1 anno' : `${amount} anni`;
  }

  const plainNumber = normalized.match(/^(\d{1,2})$/);
  if (plainNumber) {
    const amount = Number(plainNumber[1]);
    return amount === 1 ? '1 anno' : `${amount} anni`;
  }

  return normalized;
}

const officialSizeMapEntries: Array<[string, string]> = [
  ['0 3 mesi', '0-3 mesi'],
  ['3 mesi', '0-3 mesi'],
  ['3 6 mesi', '3-6 mesi'],
  ['6 mesi', '3-6 mesi'],
  ['6 9 mesi', '6-9 mesi'],
  ['9 mesi', '6-9 mesi'],
  ['9 12 mesi', '9-12 mesi'],
  ['12 mesi', '9-12 mesi'],
  ['12 18 mesi', '1 anno'],
  ['18 mesi', '1 anno'],
  ['1 anno', '1 anno'],
  ['18 24 mesi', '2 anni'],
  ['24 mesi', '2 anni'],
  ['2 anni', '2 anni'],
  ['24 36 mesi', '3-4 anni'],
  ['36 mesi', '3-4 anni'],
  ['3 anni', '3-4 anni'],
  ['4 anni', '3-4 anni'],
  ['3 4 anni', '3-4 anni'],
  ['4 6 anni', '5-6 anni'],
  ['5 anni', '5-6 anni'],
  ['6 anni', '5-6 anni'],
  ['5 6 anni', '5-6 anni'],
  ['6 8 anni', '7-8 anni'],
  ['7 anni', '7-8 anni'],
  ['8 anni', '7-8 anni'],
  ['7 8 anni', '7-8 anni'],
  ['8 10 anni', '9-10 anni'],
  ['9 anni', '9-10 anni'],
  ['10 anni', '9-10 anni'],
  ['9 10 anni', '9-10 anni'],
  ['9 11 anni', '9-10 anni'],
  ['10 12 anni', '11-12 anni'],
  ['11 anni', '11-12 anni'],
  ['12 anni', '11-12 anni'],
  ['12 13 anni', '11-12 anni'],
  ['11 12 anni', '11-12 anni'],
  ['xxs', 'XXS'],
  ['xs', 'XS'],
  ['s', 'S'],
  ['m', 'M'],
  ['l', 'L'],
  ['xl', 'XL'],
  ['xxl', 'XXL'],
];

function officialSizeDestination(sourceValue: string, destinations: string[]) {
  const alias = normalizeSizeAlias(sourceValue);
  const mapped = officialSizeMapEntries.find(([legacy]) => normalizeSizeAlias(legacy) === alias)?.[1] || '';
  return mapped && destinations.includes(mapped) ? mapped : '';
}

async function buildColorRows(decisions: Map<string, FarwayErpLegendDecision>, colorDestinations: string[]) {
  const colorLegendPath = path.join(dataDir, 'farway-color-legend-proposal.csv');
  const rows = parseCsv(await readFile(colorLegendPath, 'utf8'));
  const sourceCounts = new Map<string, number>();
  const colorCountsPath = path.join(dataDir, 'farway-color-legend-counts.csv');
  try {
    for (const row of parseCsv(await readFile(colorCountsPath, 'utf8'))) {
      const sourceColor = String(row.colore_di_partenza || '').trim();
      const count = Number(row.righe_sorgente || 0);
      if (sourceColor && Number.isFinite(count)) sourceCounts.set(sourceColor, count);
    }
  } catch {
    const masterPath = await findLatestMasterPath();
    if (masterPath) {
      for (const row of parseCsv(await readFile(masterPath, 'utf8'))) {
        const sourceColor = String(row.sourceColor || '').trim();
        if (sourceColor) sourceCounts.set(sourceColor, (sourceCounts.get(sourceColor) || 0) + 1);
      }
    }
  }

  return rows
    .map((row) => {
      const sourceValue = String(row.colore_di_partenza || '').trim();
      const currentProposal = findDestination(colorDestinations, String(row.colore_di_destinazione || '').trim());
      const itemId = stableItemId('color', sourceValue);
      return applyDecision(
        {
          itemId,
          kind: 'color',
          sourceValue,
          sourceCount: sourceCounts.get(sourceValue) || 0,
          currentProposal,
          suggestedValues: buildColorSuggestions(sourceValue, currentProposal, colorDestinations),
        },
        decisions.get(itemId)
      );
    })
    .filter((row) => row.sourceValue)
    .sort((a, b) => (a.status === b.status ? b.sourceCount - a.sourceCount || a.sourceValue.localeCompare(b.sourceValue) : b.status.localeCompare(a.status)));
}

async function buildSizeRows(decisions: Map<string, FarwayErpLegendDecision>, sizeDestinations: string[]) {
  const sizeLegendPath = path.join(dataDir, 'farway-size-legend-proposal.csv');
  try {
    return parseCsv(await readFile(sizeLegendPath, 'utf8'))
      .map((row) => {
        const sourceValue = String(row.taglia_di_partenza || '').trim();
        const itemId = stableItemId('size', sourceValue);
        const officialProposal = officialSizeDestination(sourceValue, sizeDestinations);
        const currentProposal = officialProposal || currentSizeProposal(
          sourceValue,
          new Map([[String(row.taglia_di_destinazione || '').trim(), Number(row.righe_sorgente || 0)]]),
          sizeDestinations
        );
        return applyDecision(
          {
            itemId,
            kind: 'size',
            sourceValue,
            sourceCount: Number(row.righe_sorgente || 0) || 0,
            currentProposal,
            suggestedValues: buildSizeSuggestions(sourceValue, currentProposal, sizeDestinations),
          },
          decisions.get(itemId),
          officialProposal ? 'Mappa taglie ufficiale' : ''
        );
      })
      .filter((row) => row.sourceValue && isLikelySize(row.sourceValue))
      .sort((a, b) => (a.status === b.status ? b.sourceCount - a.sourceCount || a.sourceValue.localeCompare(b.sourceValue) : b.status.localeCompare(a.status)));
  } catch {
    // Fallback for local development before the compact proposal CSV exists.
  }

  const masterPath = await findLatestMasterPath();
  if (!masterPath) return [];
  const masterRows = parseCsv(await readFile(masterPath, 'utf8'));
  const groups = new Map<string, { count: number; canonicalValues: Map<string, number> }>();

  for (const row of masterRows) {
    const sourceValue = String(row.sourceSize || '').trim();
    if (!isLikelySize(sourceValue)) continue;
    const group = groups.get(sourceValue) || { count: 0, canonicalValues: new Map<string, number>() };
    group.count += 1;
    const canonicalSize = String(row.canonicalSize || '').trim();
    if (canonicalSize) group.canonicalValues.set(canonicalSize, (group.canonicalValues.get(canonicalSize) || 0) + 1);
    groups.set(sourceValue, group);
  }

  return Array.from(groups.entries())
    .map(([sourceValue, group]) => {
      const itemId = stableItemId('size', sourceValue);
      const officialProposal = officialSizeDestination(sourceValue, sizeDestinations);
      const currentProposal = officialProposal || currentSizeProposal(sourceValue, group.canonicalValues, sizeDestinations);
      return applyDecision(
        {
          itemId,
          kind: 'size',
          sourceValue,
          sourceCount: group.count,
          currentProposal,
          suggestedValues: buildSizeSuggestions(sourceValue, currentProposal, sizeDestinations),
        },
        decisions.get(itemId),
        officialProposal ? 'Mappa taglie ufficiale' : ''
      );
    })
    .sort((a, b) => (a.status === b.status ? b.sourceCount - a.sourceCount || a.sourceValue.localeCompare(b.sourceValue) : b.status.localeCompare(a.status)));
}

export async function buildFarwayErpLegendsPack(): Promise<FarwayErpLegendsPack> {
  const colorTermsPath = path.join(dataDir, 'farway-current-color-terms.csv');
  const sizeTermsPath = path.join(dataDir, 'farway-current-size-terms.csv');
  const colorLegendPath = path.join(dataDir, 'farway-color-legend-proposal.csv');
  const masterPath = await findLatestMasterPath();

  const colorDestinations = parseCsv(await readFile(colorTermsPath, 'utf8')).map((row) => row.name).filter(Boolean);
  const sizeDestinations = [
    noSizeLabel,
    ...parseCsv(await readFile(sizeTermsPath, 'utf8')).map((row) => row.name).filter(Boolean),
  ];
  const decisions = await readDecisions();
  const colorRows = await buildColorRows(decisions, colorDestinations);
  const sizeRows = await buildSizeRows(decisions, sizeDestinations);

  return {
    generatedAt: new Date().toISOString(),
    decisionsPath: hasDatabaseConnection()
      ? `${dbNamespace}:${dbDecisionsKey}`
      : decisionsFilePath,
    sources: {
      colorLegend: colorLegendPath,
      colorTerms: colorTermsPath,
      sizeTerms: sizeTermsPath,
      master: masterPath || path.join(dataDir, 'farway-size-legend-proposal.csv'),
    },
    destinations: {
      color: colorDestinations,
      size: sizeDestinations,
    },
    summary: {
      colorRows: colorRows.length,
      sizeRows: sizeRows.length,
      pendingColorRows: colorRows.filter((row) => row.status === 'pending').length,
      pendingSizeRows: sizeRows.filter((row) => row.status === 'pending').length,
      approvedColorRows: colorRows.filter((row) => row.status === 'approved').length,
      approvedSizeRows: sizeRows.filter((row) => row.status === 'approved').length,
    },
    rows: {
      color: colorRows,
      size: sizeRows,
    },
  };
}

export async function saveFarwayErpLegendDecision(input: {
  itemId?: string;
  kind?: FarwayErpLegendKind;
  sourceValue?: string;
  selectedValue?: string;
  note?: string;
}) {
  if (!input.itemId || !input.kind || !input.sourceValue) {
    throw new Error('Decisione legenda incompleta.');
  }

  const pack = await buildFarwayErpLegendsPack();
  const row = pack.rows[input.kind].find((entry) => entry.itemId === input.itemId);
  if (!row) throw new Error('Riga legenda non trovata.');

  const allowedValues = pack.destinations[input.kind];
  const selectedValue = String(input.selectedValue || '').trim();
  if (!selectedValue || !allowedValues.includes(selectedValue)) {
    throw new Error('Valore destinazione non valido.');
  }

  const decisions = await readDecisions();
  const decision: FarwayErpLegendDecision = {
    itemId: row.itemId,
    kind: row.kind,
    sourceValue: row.sourceValue,
    selectedValue,
    note: String(input.note || '').trim(),
    updatedAt: new Date().toISOString(),
  };
  decisions.set(row.itemId, decision);
  await writeDecisions(decisions);
  return decision;
}

export async function buildFarwayErpLegendsCsv(pack: FarwayErpLegendsPack) {
  const rows = [...pack.rows.color, ...pack.rows.size].map((row) => ({
    tipo: row.kind === 'color' ? 'colore' : 'taglia',
    valore_di_partenza: row.sourceValue,
    valore_di_destinazione: row.selectedValue,
    stato: row.status === 'approved' ? 'approvato' : 'da_approvare',
    righe_sorgente: row.sourceCount,
    nota: row.note,
  }));

  return `${toCsv(rows, ['tipo', 'valore_di_partenza', 'valore_di_destinazione', 'stato', 'righe_sorgente', 'nota'])}\n`;
}
