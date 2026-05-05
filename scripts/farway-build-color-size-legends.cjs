#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const DECISION_CONFIDENCE = {
  HIGH: 'alta',
  MEDIUM: 'media',
  LOW: 'bassa',
  REVIEW: 'da_approvare',
  NON_COLOR: 'non_colore',
};

function parseCsvLine(line) {
  const cells = [];
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

function parseCsv(raw) {
  const lines = raw.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
  });
}

function csvEscape(value) {
  const stringValue = String(value ?? '');
  if (/[",\r\n]/.test(stringValue)) return `"${stringValue.replace(/"/g, '""')}"`;
  return stringValue;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCode(value) {
  return String(value || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]+/g, '')
    .trim();
}

function countMapIncrement(map, key, amount = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + amount);
}

function mostFrequent(map) {
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || ['', 0];
}

function uniqueSorted(values, limit = 10) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit);
}

async function findLatestMasterPath() {
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('tmp-farway-erp-reconcile-'))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));

  for (const candidate of candidates) {
    const masterPath = path.join(DATA_DIR, candidate, 'master-normalizzato.csv');
    try {
      await fs.access(masterPath);
      return masterPath;
    } catch {
      continue;
    }
  }

  throw new Error('Nessun master-normalizzato.csv trovato. Esegui prima npm run farway:erp:reconcile.');
}

async function loadEnvFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]]) continue;
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  } catch {
    // Optional local env file.
  }
}

async function resolveWooSettings() {
  await loadEnvFile(path.join(process.cwd(), '.env.local'));
  const storeUrl = String(process.env.WC_STORE_URL || '').trim().replace(/\/$/, '');
  const consumerKey = String(process.env.WC_CONSUMER_KEY || '').trim();
  const consumerSecret = String(process.env.WC_CONSUMER_SECRET || '').trim();
  if (!storeUrl || !consumerKey || !consumerSecret) return null;
  return { storeUrl, consumerKey, consumerSecret };
}

function buildWooUrl(settings, endpointPath) {
  const authQuery = `consumer_key=${encodeURIComponent(settings.consumerKey)}&consumer_secret=${encodeURIComponent(settings.consumerSecret)}`;
  const separator = endpointPath.includes('?') ? '&' : '?';
  return `${settings.storeUrl}/wp-json/wc/v3/${endpointPath}${separator}${authQuery}`;
}

async function wooRequest(settings, endpointPath) {
  const response = await fetch(buildWooUrl(settings, endpointPath));
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Woo API ${endpointPath} -> ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function wooFetchAll(settings, endpointPath) {
  const rows = [];
  for (let page = 1; page <= 80; page += 1) {
    const separator = endpointPath.includes('?') ? '&' : '?';
    const batch = await wooRequest(settings, `${endpointPath}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error(`Risposta Woo inattesa per ${endpointPath}`);
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows;
}

function extractAttributeValue(attributes, names) {
  const normalizedNames = names.map((name) => normalizeText(name));
  for (const attribute of attributes || []) {
    const label = normalizeText(attribute.name || attribute.slug || '');
    if (!normalizedNames.some((name) => label.includes(name))) continue;
    const value = attribute.option || (Array.isArray(attribute.options) ? attribute.options[0] : '');
    if (value) return String(value);
  }
  return '';
}

async function fetchWooTaxonomyAndSkuEvidence() {
  const settings = await resolveWooSettings();
  if (!settings) {
    return { colorTerms: [], sizeTerms: [], skuColorMap: new Map(), idColorMap: new Map(), source: 'missing_credentials' };
  }

  const attributes = await wooRequest(settings, 'products/attributes');
  const colorAttribute = attributes.find((attribute) =>
    /colou?r|colore/i.test(`${attribute.name || ''} ${attribute.slug || ''}`)
  );
  const sizeAttribute = attributes.find((attribute) =>
    /taglia|size/i.test(`${attribute.name || ''} ${attribute.slug || ''}`)
  );

  const colorTerms = colorAttribute
    ? await wooFetchAll(settings, `products/attributes/${colorAttribute.id}/terms?hide_empty=false`)
    : [];
  const sizeTerms = sizeAttribute
    ? await wooFetchAll(settings, `products/attributes/${sizeAttribute.id}/terms?hide_empty=false`)
    : [];

  const products = await wooFetchAll(
    settings,
    'products?status=any&_fields=id,name,type,sku,attributes'
  );
  const skuColorMap = new Map();
  const idColorMap = new Map();

  for (const product of products) {
    if (product.type === 'variable') {
      let variations = [];
      try {
        variations = await wooFetchAll(
          settings,
          `products/${product.id}/variations?_fields=id,sku,attributes,status`
        );
      } catch (error) {
        console.warn(`[farway-legend] Varianti Woo saltate per prodotto ${product.id}: ${error.message}`);
      }
      for (const variation of variations) {
        const color = extractAttributeValue(variation.attributes || [], ['colore', 'color']);
        if (variation.sku && color) skuColorMap.set(normalizeCode(variation.sku), color);
        if (color) idColorMap.set(`${product.id}:${variation.id}`, color);
      }
      continue;
    }

    const color = extractAttributeValue(product.attributes || [], ['colore', 'color']);
    if (product.sku && color) skuColorMap.set(normalizeCode(product.sku), color);
    if (color) idColorMap.set(`${product.id}:`, color);
  }

  return {
    colorTerms: colorTerms.map((term) => ({ name: term.name, slug: term.slug, count: term.count })),
    sizeTerms: sizeTerms.map((term) => ({ name: term.name, slug: term.slug, count: term.count })),
    skuColorMap,
    idColorMap,
    source: settings.storeUrl,
  };
}

function resolveCurrentTerm(terms, targetName) {
  if (!targetName) return null;
  const normalizedTarget = normalizeText(targetName);
  return (
    terms.find((term) => normalizeText(term.name) === normalizedTarget) ||
    terms.find((term) => normalizeText(term.slug) === normalizedTarget) ||
    null
  );
}

function buildLegacyGroups(rows, skuColorMap, idColorMap) {
  const groups = new Map();

  for (const row of rows) {
    const legacyColor = String(row.sourceColor || '').trim();
    const key = legacyColor || '(vuoto)';
    const group =
      groups.get(key) ||
      ({
        legacyColor: key,
        count: 0,
        rows: [],
        canonicalCounts: new Map(),
        evidenceCounts: new Map(),
        descriptions: [],
        models: [],
        sheets: [],
        examples: [],
        candidateTexts: [],
      });

    group.count += 1;
    group.rows.push(row);
    countMapIncrement(group.canonicalCounts, row.canonicalColor);
    if (row.sourceDescription) group.descriptions.push(row.sourceDescription);
    if (row.sourceModel) group.models.push(row.sourceModel);
    if (row.sourceSheet) group.sheets.push(row.sourceSheet);
    if (row.candidateRefs) group.candidateTexts.push(row.candidateRefs);
    if (group.examples.length < 4) {
      group.examples.push(`${row.sourceSheet || '-'} riga ${row.sourceRow || '-'} ${row.sourceCode || row.sourceModel || '-'}`);
    }

    const skuEvidence =
      skuColorMap.get(normalizeCode(row.wooSku)) ||
      skuColorMap.get(normalizeCode(row.sourceCode)) ||
      idColorMap.get(`${row.wooProductId || ''}:${row.wooVariationId || ''}`) ||
      '';
    countMapIncrement(group.evidenceCounts, skuEvidence);
    groups.set(key, group);
  }

  return groups;
}

function isNonColorValue(group) {
  const value = group.legacyColor;
  const normalized = normalizeText(value);
  const code = normalizeCode(value);
  const context = normalizeText([...group.descriptions, ...group.models].join(' '));

  if (value === '(vuoto)') return true;
  if (/^\d+$/.test(code)) return true;
  if (/^\d+(ANNI|ANNO|MESI|MESE|Y|M)$/.test(code)) return true;
  if (/^(AB|CAM|PAN|PT|MCA|FCM)\d{2}$/.test(code)) return true;
  if (/^(MODELLI|MODELLO|VENDITA|FATTURA|FAT|MAMMA)$/.test(code)) return true;
  if (/^(MUSSOLINA|FTSADIA)$/.test(code)) return true;
  if (/\b(in mag|in ft|risulta|risultano|fisicamente|manca taglia|mere prodotta|modelli doha)\b/.test(normalized)) return true;
  if (/\b(anni|mesi|anno)\b/.test(normalized) && !/\brosa|verde|blu|rosso|bianco|ecru|giallo|lilla\b/.test(normalized)) return true;
  if (!normalized && !context) return true;
  return false;
}

function inferByRules(group, colorTerms) {
  const legacy = group.legacyColor;
  const normalizedLegacy = normalizeText(legacy);
  const text = normalizeText([
    legacy,
    ...group.descriptions,
    ...group.models,
  ].join(' '));

  const rules = [
    {
      target: 'Fantasie: animali',
      confidence: DECISION_CONFIDENCE.HIGH,
      reason: 'Contiene riferimenti espliciti ad animali/giraffa/zebra/gatti/elefanti.',
      regex: /\b(giraff\w*|zeb\w*|elefant\w*|gatt\w*|animal\w*|animali)\b/,
    },
    {
      target: 'Fantasia marina',
      confidence: DECISION_CONFIDENCE.HIGH,
      reason: 'Contiene riferimenti espliciti alla fantasia marina.',
      regex: /\b(stella marina|fantasia marina|marina)\b/,
    },
    {
      target: 'Fantasie: personaggi',
      confidence: DECISION_CONFIDENCE.MEDIUM,
      reason: 'Contiene personaggi o nomi narrativi come Rapunzel/principesse.',
      regex: /\b(rapunzel|principess|personaggi)\b/,
    },
    {
      target: 'Fantasie: natura',
      confidence: DECISION_CONFIDENCE.MEDIUM,
      reason: 'Contiene fiori/natura/aquiloni o pattern senza colore dominante sicuro.',
      regex: /\b(flowers?|fiori|floreal|natura|aquiloni|acquloni|flower)\b/,
    },
    {
      target: 'Fucsia e rosa vivace',
      confidence: DECISION_CONFIDENCE.MEDIUM,
      reason: 'Contiene fucsia/magenta.',
      regex: /\b(fucsia|magenta|rhapsody|rasphody)\b/,
    },
    {
      target: 'Prugna profondo',
      confidence: DECISION_CONFIDENCE.HIGH,
      reason: 'Contiene prugna.',
      regex: /\b(prugna|plum)\b/,
    },
    {
      target: 'Rosa cipria e nude',
      confidence: DECISION_CONFIDENCE.MEDIUM,
      reason: 'Contiene rosa/nude/pink/petunia/sogno.',
      regex: /\b(rosa|rose|pink|nude|petunia|sogno|renai|renaissance|acp)\b/,
    },
    {
      target: 'Rosso e ciliegia',
      confidence: DECISION_CONFIDENCE.HIGH,
      reason: 'Contiene rosso/red/tango.',
      regex: /\b(rosso|red|tango|ciliegia|cherry|amb)\b/,
    },
    {
      target: 'Bordeaux e mattone',
      confidence: DECISION_CONFIDENCE.HIGH,
      reason: 'Contiene bordeaux/bordo.',
      regex: /\b(bordeaux|bordo|bordo)\b/,
    },
    {
      target: 'Blu navy e notte',
      confidence: DECISION_CONFIDENCE.MEDIUM,
      reason: 'Contiene notte/noche/navy.',
      regex: /\b(noche|notte|navy)\b/,
    },
    {
      target: 'Blu e azzurro intenso',
      confidence: DECISION_CONFIDENCE.MEDIUM,
      reason: 'Contiene blu/blue/bluette/bonnet/azafata.',
      regex: /\b(blu|blue|bluette|bonnet|azafata)\b/,
    },
    {
      target: 'Celeste lino e polvere',
      confidence: DECISION_CONFIDENCE.MEDIUM,
      reason: 'Contiene celeste/acqua/polvere.',
      regex: /\b(celeste|acqua|polvere)\b/,
    },
    {
      target: 'Azzurro polvere e denim',
      confidence: DECISION_CONFIDENCE.HIGH,
      reason: 'Contiene denim/jeans.',
      regex: /\b(denim|jeans|den)\b/,
    },
    {
      target: 'Verde khaki e militare',
      confidence: DECISION_CONFIDENCE.HIGH,
      reason: 'Contiene kaki/khaki.',
      regex: /\b(kaki|khaki)\b/,
    },
    {
      target: 'Verde salvia e aloe',
      confidence: DECISION_CONFIDENCE.MEDIUM,
      reason: 'Contiene menta/mint/salvia/aloe/liquen.',
      regex: /\b(menta|mint|salvia|aloe|liquen|lichen)\b/,
    },
    {
      target: 'Verde bosco e scuri',
      confidence: DECISION_CONFIDENCE.MEDIUM,
      reason: 'Contiene verde/green/cedar/ivey.',
      regex: /\b(verde|green|cedar|ivey)\b/,
    },
    {
      target: 'Giallo e ocra',
      confidence: DECISION_CONFIDENCE.HIGH,
      reason: 'Contiene giallo/yellow/ocra/cedro/chardonnay.',
      regex: /\b(giallo|yellow|ocra|cedro|chardonnay|chardonney|chd)\b/,
    },
    {
      target: 'Marrone e mocha',
      confidence: DECISION_CONFIDENCE.HIGH,
      reason: 'Contiene marrone/brown/cappuccino/mocha.',
      regex: /\b(marrone|brown|cappuccino|mocha)\b/,
    },
    {
      target: 'Beige e sabbia',
      confidence: DECISION_CONFIDENCE.HIGH,
      reason: 'Contiene beige/sabbia/sand.',
      regex: /\b(beige|sabbia|sand)\b/,
    },
    {
      target: 'Antracite e grigio scuro',
      confidence: DECISION_CONFIDENCE.MEDIUM,
      reason: 'Contiene grigio/antracite/cinder.',
      regex: /\b(grigio|grey|gray|antracite|cinder|cind)\b/,
    },
    {
      target: 'Lilla e lavanda',
      confidence: DECISION_CONFIDENCE.HIGH,
      reason: 'Contiene lilla/lilac/lavanda/lavender/glicine.',
      regex: /\b(lilla|lilac|lillac|lavanda|lavender|glicine|lic)\b/,
    },
    {
      target: 'Ecru e lino naturale',
      confidence: DECISION_CONFIDENCE.HIGH,
      reason: 'Contiene ecru/lino/naturale.',
      regex: /\b(ecru|ecru|lino|natural|naturale)\b/,
    },
    {
      target: 'Off-white e cloud',
      confidence: DECISION_CONFIDENCE.MEDIUM,
      reason: 'Contiene off-white/cloud/white con possibile variante non bianco puro.',
      regex: /\b(off white|offwhite|cloud|wht ntu)\b/,
    },
    {
      target: 'Bianco puro',
      confidence: DECISION_CONFIDENCE.MEDIUM,
      reason: 'Contiene bianco/white/WHT.',
      regex: /\b(bianco|white|wht)\b/,
    },
    {
      target: 'Fantasie: natura',
      confidence: DECISION_CONFIDENCE.LOW,
      reason: 'Contiene fantasia/tejido/pattern, ma senza tipo di fantasia certo.',
      regex: /\b(fantasia|tejido|pattern|stampa|allover|jumbo|lips)\b/,
    },
  ];

  for (const rule of rules) {
    if (!rule.regex.test(text)) continue;
    const term = resolveCurrentTerm(colorTerms, rule.target);
    if (!term) continue;
    return {
      proposedColor: term.name,
      proposedSlug: term.slug,
      confidence: rule.confidence,
      reason: rule.reason,
      alternatives: buildAlternatives(term.name, colorTerms, normalizedLegacy),
    };
  }

  return {
    proposedColor: '',
    proposedSlug: '',
    confidence: DECISION_CONFIDENCE.REVIEW,
    reason: 'Codice legacy o descrizione non sufficienti per una proposta affidabile.',
    alternatives: '',
  };
}

function buildAlternatives(primaryName, colorTerms, normalizedLegacy) {
  const normalizedPrimary = normalizeText(primaryName);
  const familyHints = [
    ['rosa', /rosa|pink|fucsia|magenta|rose/],
    ['verde', /verde|green|kaki|khaki|mint|salvia/],
    ['blu', /blu|blue|celeste|azzurro|navy/],
    ['bianco', /bianco|white|ecru|panna|avorio|lino/],
    ['fantasia', /fantasia|giraff|zebr|animal|flower|fiori|rapunzel|marina/],
    ['rosso', /rosso|red|bordeaux|tango|ciliegia/],
    ['marrone', /marrone|brown|beige|sand|sabbia|mocha/],
  ];
  const matchedFamily = familyHints.find(([, regex]) => regex.test(normalizedLegacy));
  if (!matchedFamily) return '';
  return colorTerms
    .filter((term) => normalizeText(term.name) !== normalizedPrimary)
    .filter((term) => matchedFamily[1].test(normalizeText(term.name)))
    .map((term) => term.name)
    .slice(0, 4)
    .join(' | ');
}

function inferProposal(group, colorTerms) {
  if (isNonColorValue(group)) {
    return {
      proposedColor: '',
      proposedSlug: '',
      confidence: DECISION_CONFIDENCE.NON_COLOR,
      reason: 'Valore probabilmente non colore: vuoto, totale, nota o dato finito nella colonna colore.',
      alternatives: '',
    };
  }

  const [evidenceColor, evidenceCount] = mostFrequent(group.evidenceCounts);
  const evidenceTotal = Array.from(group.evidenceCounts.values()).reduce((sum, count) => sum + count, 0);
  const hasEnoughEvidence =
    evidenceTotal >= 3 ||
    evidenceTotal / group.count >= 0.4 ||
    (group.count <= 3 && evidenceTotal >= 1);
  if (evidenceColor && evidenceTotal > 0) {
    const term = resolveCurrentTerm(colorTerms, evidenceColor);
    if (term && evidenceCount / evidenceTotal >= 0.6 && hasEnoughEvidence) {
      return {
        proposedColor: term.name,
        proposedSlug: term.slug,
        confidence:
          evidenceCount >= 5 || evidenceCount / group.count >= 0.75
            ? DECISION_CONFIDENCE.HIGH
            : DECISION_CONFIDENCE.MEDIUM,
        reason: `Derivato da match SKU/variante WooCommerce (${evidenceCount}/${evidenceTotal} evidenze).`,
        alternatives: buildAlternatives(term.name, colorTerms, normalizeText(group.legacyColor)),
      };
    }
  }

  const exactTerm = colorTerms.find(
    (term) => normalizeText(term.name) === normalizeText(group.legacyColor) || normalizeText(term.slug) === normalizeText(group.legacyColor)
  );
  if (exactTerm) {
    return {
      proposedColor: exactTerm.name,
      proposedSlug: exactTerm.slug,
      confidence: DECISION_CONFIDENCE.HIGH,
      reason: 'Valore legacy uguale a un termine colore WooCommerce.',
      alternatives: '',
    };
  }

  return inferByRules(group, colorTerms);
}

function buildColorLegendRows(groups, colorTerms) {
  return Array.from(groups.values())
    .map((group) => {
      const [canonicalColor, canonicalCount] = mostFrequent(group.canonicalCounts);
      const [evidenceColor, evidenceCount] = mostFrequent(group.evidenceCounts);
      const proposal = inferProposal(group, colorTerms);
      return {
        legacyColor: group.legacyColor,
        normalizedLegacy: normalizeText(group.legacyColor),
        sourceRowCount: group.count,
        proposedColor: proposal.proposedColor,
        proposedSlug: proposal.proposedSlug,
        confidence: proposal.confidence,
        reason: proposal.reason,
        alternatives: proposal.alternatives,
        previousHeuristicColor: canonicalColor,
        previousHeuristicCount: canonicalCount || '',
        skuEvidenceColor: evidenceColor,
        skuEvidenceCount: evidenceCount || '',
        exampleSheets: uniqueSorted(group.sheets, 4).join(' | '),
        exampleModels: uniqueSorted(group.models, 4).join(' | '),
        exampleDescriptions: uniqueSorted(group.descriptions, 4).join(' | '),
        examples: group.examples.join(' | '),
      };
    })
    .sort((a, b) => {
      const confidenceWeight = {
        [DECISION_CONFIDENCE.REVIEW]: 0,
        [DECISION_CONFIDENCE.LOW]: 1,
        [DECISION_CONFIDENCE.NON_COLOR]: 2,
        [DECISION_CONFIDENCE.MEDIUM]: 3,
        [DECISION_CONFIDENCE.HIGH]: 4,
      };
      return (
        confidenceWeight[a.confidence] - confidenceWeight[b.confidence] ||
        b.sourceRowCount - a.sourceRowCount ||
        a.legacyColor.localeCompare(b.legacyColor)
      );
    });
}

async function writeCsv(filePath, rows, headers) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function buildSimpleColorLegendRows(colorRows) {
  return colorRows
    .filter((row) => {
      const sourceColor = String(row.legacyColor || '').trim();
      return sourceColor && row.confidence !== DECISION_CONFIDENCE.NON_COLOR;
    })
    .map((row) => ({
      colore_di_partenza: row.legacyColor,
      colore_di_destinazione: row.proposedColor || '',
    }))
    .sort((a, b) => a.colore_di_partenza.localeCompare(b.colore_di_partenza));
}

function buildMarkdownSummary(colorRows, simpleColorRows, colorTerms, sizeTerms, masterPath, source) {
  const confidenceCounts = new Map();
  for (const row of colorRows) countMapIncrement(confidenceCounts, row.confidence);
  const blankDestinations = simpleColorRows.filter((row) => !row.colore_di_destinazione).length;

  const table = (rows, headers) => {
    if (!rows.length) return '_Nessuna riga._';
    return [
      `| ${headers.join(' | ')} |`,
      `| ${headers.map(() => '---').join(' | ')} |`,
      ...rows.map((row) => `| ${headers.map((header) => String(row[header] || '').replace(/\|/g, '\\|')).join(' | ')} |`),
    ].join('\n');
  };

  return `# Farway - proposta legenda colori

Generato: ${new Date().toISOString()}

Fonte master: \`${masterPath}\`

Fonte termini WooCommerce: \`${source}\`

## Sintesi

- Valori colore legacy unici: ${colorRows.length}
- Valori non colore o sporchi: ${confidenceCounts.get(DECISION_CONFIDENCE.NON_COLOR) || 0}
- Righe nella legenda semplice: ${simpleColorRows.length}
- Righe senza destinazione proposta: ${blankDestinations}

## Tabella proposta

${table(
  simpleColorRows,
  ['colore_di_partenza', 'colore_di_destinazione']
)}

## Colori ammessi come destinazione

${table(
  colorTerms.map((term) => ({ colore: term.name })),
  ['colore']
)}

## Taglie attuali lette dal sito

${table(
  sizeTerms.map((term) => ({ taglia: term.name })),
  ['taglia']
)}

## Uso previsto

Questa e una proposta di mappatura. La riconciliazione prodotti non deve usarla finche non viene approvata.
`;
}

async function main() {
  const masterPath = await findLatestMasterPath();
  const masterRows = parseCsv(await fs.readFile(masterPath, 'utf8'));
  const { colorTerms, sizeTerms, skuColorMap, idColorMap, source } = await fetchWooTaxonomyAndSkuEvidence();
  if (!colorTerms.length) throw new Error('Impossibile leggere i termini colore WooCommerce.');

  const groups = buildLegacyGroups(masterRows, skuColorMap, idColorMap);
  const colorRows = buildColorLegendRows(groups, colorTerms);
  const simpleColorRows = buildSimpleColorLegendRows(colorRows);
  const colorTermsRows = colorTerms
    .map((term) => ({ name: term.name, slug: term.slug, productCount: term.count }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const sizeTermsRows = sizeTerms
    .map((term) => ({ name: term.name, slug: term.slug, productCount: term.count }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const colorLegendPath = path.join(DATA_DIR, 'farway-color-legend-proposal.csv');
  const colorTermsPath = path.join(DATA_DIR, 'farway-current-color-terms.csv');
  const sizeTermsPath = path.join(DATA_DIR, 'farway-current-size-terms.csv');
  const summaryPath = path.join(DATA_DIR, 'farway-color-size-legend-summary.md');

  await writeCsv(colorLegendPath, simpleColorRows, ['colore_di_partenza', 'colore_di_destinazione']);
  await writeCsv(colorTermsPath, colorTermsRows, ['name', 'slug', 'productCount']);
  await writeCsv(sizeTermsPath, sizeTermsRows, ['name', 'slug', 'productCount']);
  await fs.writeFile(
    summaryPath,
    buildMarkdownSummary(
      colorRows,
      simpleColorRows,
      colorTermsRows.map((row) => ({ name: row.name, slug: row.slug, count: row.productCount })),
      sizeTermsRows.map((row) => ({ name: row.name, slug: row.slug, count: row.productCount })),
      masterPath,
      source
    ),
    'utf8'
  );

  console.log(`[farway-legend] Colori legacy: ${colorRows.length}`);
  console.log(`[farway-legend] Legenda semplice: ${simpleColorRows.length}`);
  console.log(`[farway-legend] Termini colore WooCommerce: ${colorTermsRows.length}`);
  console.log(`[farway-legend] Termini taglia WooCommerce: ${sizeTermsRows.length}`);
  console.log(`[farway-legend] Proposta colori: ${colorLegendPath}`);
  console.log(`[farway-legend] Sintesi: ${summaryPath}`);
}

main().catch((error) => {
  console.error(`[farway-legend] ${error.stack || error.message}`);
  process.exit(1);
});
