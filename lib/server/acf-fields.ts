import { access, readFile } from 'fs/promises';
import path from 'path';

type AcfLocationRule = {
  param?: string;
  operator?: string;
  value?: string;
};

type AcfExportField = {
  key?: string;
  label?: string;
  name?: string;
  type?: string;
  instructions?: string;
  choices?: Record<string, string>;
  allow_custom?: number;
  other_choice?: number;
  allow_null?: number;
  placeholder?: string;
  append?: string;
};

type AcfExportGroup = {
  key?: string;
  title?: string;
  active?: boolean;
  fields?: AcfExportField[];
  location?: AcfLocationRule[][];
};

export type AcfProductCategory = {
  id: number;
  name: string;
  slug?: string;
  parentId?: number;
  topLevelParentId?: number;
  lineageIds?: number[];
};

export type AcfRenderableFieldType = 'checkbox' | 'radio' | 'text' | 'wysiwyg';

export type AcfFieldDefinition = {
  key: string;
  name: string;
  label: string;
  type: AcfRenderableFieldType;
  instructions: string;
  choices: Array<{ value: string; label: string }>;
  allowCustom: boolean;
  allowNull: boolean;
  placeholder: string;
  append: string;
  groupKey: string;
  groupTitle: string;
};

const supportedFieldTypes = new Set<AcfRenderableFieldType>([
  'checkbox',
  'radio',
  'text',
  'wysiwyg',
]);

let acfExportCache: AcfExportGroup[] | null = null;
let acfExportPathCache: string | null = null;

function normalizeToken(value: string) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function resolveAcfExportPath() {
  if (acfExportPathCache) {
    return acfExportPathCache;
  }

  const candidates = [
    process.env.ACF_EXPORT_PATH,
    path.join(process.cwd(), 'data', 'acf-export-2026-03-02 (1).json'),
    path.join(process.cwd(), 'data', 'acf-export-2026-03-02.json'),
    'C:\\Users\\fabri\\Downloads\\acf-export-2026-03-02 (1).json',
    'C:\\Users\\fabri\\Downloads\\acf-export-2026-03-02.json',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      acfExportPathCache = candidate;
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error(
    'Export ACF non trovato. Imposta ACF_EXPORT_PATH oppure salva il file in data/acf-export-2026-03-02.json.'
  );
}

async function readAcfExportGroups() {
  if (acfExportCache) {
    return acfExportCache;
  }

  const exportPath = await resolveAcfExportPath();
  const raw = await readFile(exportPath, 'utf8');
  const parsed = JSON.parse(raw) as AcfExportGroup[];

  acfExportCache = Array.isArray(parsed) ? parsed : [];
  return acfExportCache;
}

function buildCategoryTokens(categories: AcfProductCategory[]) {
  const tokens = new Set<string>();

  for (const category of categories) {
    tokens.add(String(category.id));

    if (category.parentId) {
      tokens.add(String(category.parentId));
    }

    if (category.topLevelParentId) {
      tokens.add(String(category.topLevelParentId));
    }

    for (const lineageId of category.lineageIds || []) {
      tokens.add(String(lineageId));
    }

    const normalizedName = normalizeToken(category.name);
    if (normalizedName) {
      tokens.add(normalizedName);
    }

    const normalizedSlug = normalizeToken(category.slug || '');
    if (normalizedSlug) {
      tokens.add(normalizedSlug);
      tokens.add(String(category.slug));
    }
  }

  return tokens;
}

function matchesRule(
  rule: AcfLocationRule,
  postType: string,
  categoryTokens: Set<string>
) {
  const param = String(rule.param || '');
  const operator = String(rule.operator || '==');
  const rawValue = String(rule.value || '');

  if (param === 'post_type') {
    if (operator === '!=') {
      return rawValue !== postType;
    }

    return rawValue === postType;
  }

  if (param === 'product_cat') {
    const candidate = normalizeToken(rawValue);
    const hasMatch = categoryTokens.has(rawValue) || (candidate ? categoryTokens.has(candidate) : false);

    if (operator === '!=') {
      return !hasMatch;
    }

    return hasMatch;
  }

  if (param === 'post_taxonomy') {
    const [, taxonomyValue] = rawValue.split(':');
    const candidate = normalizeToken(taxonomyValue || rawValue);
    const hasMatch =
      categoryTokens.has(rawValue) ||
      categoryTokens.has(taxonomyValue || rawValue) ||
      (candidate ? categoryTokens.has(candidate) : false);

    if (operator === '!=') {
      return !hasMatch;
    }

    return hasMatch;
  }

  return false;
}

function fieldToDefinition(group: AcfExportGroup, field: AcfExportField): AcfFieldDefinition | null {
  const type = String(field.type || '') as AcfRenderableFieldType;

  if (!supportedFieldTypes.has(type)) {
    return null;
  }

  const name = String(field.name || '').trim();
  const key = String(field.key || '').trim();

  if (!name || !key) {
    return null;
  }

  const choices = Object.entries(field.choices || {}).map(([value, label]) => ({
    value,
    label,
  }));

  return {
    key,
    name,
    label: String(field.label || name),
    type,
    instructions: String(field.instructions || ''),
    choices,
    allowCustom: Boolean(field.allow_custom || field.other_choice),
    allowNull: Boolean(field.allow_null),
    placeholder: String(field.placeholder || ''),
    append: String(field.append || ''),
    groupKey: String(group.key || ''),
    groupTitle: String(group.title || ''),
  };
}

export async function getAcfFieldsForProduct(params: {
  postType?: string;
  categories?: AcfProductCategory[];
}) {
  const postType = params.postType || 'product';
  const categories = params.categories || [];
  const categoryTokens = buildCategoryTokens(categories);
  const groups = await readAcfExportGroups();
  const definitions: AcfFieldDefinition[] = [];
  const seenNames = new Set<string>();

  for (const group of groups) {
    if (group.active === false) {
      continue;
    }

    const locationSets = Array.isArray(group.location) ? group.location : [];
    const matchesLocation =
      locationSets.length === 0 ||
      locationSets.some((ruleSet) =>
        Array.isArray(ruleSet) &&
        ruleSet.every((rule) => matchesRule(rule, postType, categoryTokens))
      );

    if (!matchesLocation) {
      continue;
    }

    for (const field of group.fields || []) {
      const definition = fieldToDefinition(group, field);

      if (!definition || seenNames.has(definition.name)) {
        continue;
      }

      seenNames.add(definition.name);
      definitions.push(definition);
    }
  }

  return definitions;
}

export function normalizeAcfValue(
  field: AcfFieldDefinition,
  rawValue: unknown
): string | string[] | null {
  if (field.type === 'checkbox') {
    const values = Array.isArray(rawValue)
      ? rawValue
      : typeof rawValue === 'string'
        ? [rawValue]
        : [];
    const normalized = Array.from(
      new Set(
        values
          .map((value) => String(value || '').trim())
          .filter(Boolean)
          .filter((value) =>
            field.allowCustom || field.choices.length === 0
              ? true
              : field.choices.some((choice) => choice.value === value)
          )
      )
    );

    return normalized.length > 0 ? normalized : null;
  }

  const normalized = String(rawValue || '').trim();

  if (!normalized) {
    return null;
  }

  if (
    field.type === 'radio' &&
    !field.allowCustom &&
    field.choices.length > 0 &&
    !field.choices.some((choice) => choice.value === normalized)
  ) {
    return null;
  }

  return normalized;
}
