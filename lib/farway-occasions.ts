export const farwayOccasionDusoFieldName = 'occasione_duso';
export const farwayOccasionDusoFieldKey = 'field_699dd68397a98';

export const farwayOccasionDusoChoices = [
  {
    value: 'casa_nonni',
    label: 'A casa dei nonni',
    aliases: ['A casa dei nonni'],
  },
  {
    value: 'passeggiata_famiglia',
    label: 'Passeggiata con mamma e papa',
    aliases: ['Passeggiata con mamma e papa', 'Passeggiata con mamma e papà'],
  },
  {
    value: 'compleanno',
    label: 'Compleanno',
    aliases: ['Compleanno'],
  },
  {
    value: 'vestito_domenica',
    label: 'Il vestito della domenica',
    aliases: ['Il vestito della domenica'],
  },
  {
    value: 'sera_estate_gelato',
    label: "Una sera d'estate: gelato con gli amici",
    aliases: [
      "Una sera d'estate: gelato con gli amici",
      'Una sera d’estate: gelato con gli amici',
    ],
  },
  {
    value: 'occasioni_eleganti',
    label: 'Cene o pranzi semplici ed eleganti',
    aliases: ['Cene o pranzi semplici ed eleganti', 'Pranzi semplici ed eleganti'],
  },
  {
    value: 'cerimonia_in-famiglia',
    label: 'Cerimonia in famiglia',
    aliases: ['Cerimonia in famiglia'],
  },
  {
    value: 'picnic_al_parco',
    label: 'Picnic al parco',
    aliases: ['Picnic al parco'],
  },
  {
    value: 'pomeriggio_al_museo',
    label: 'Pomeriggio al museo',
    aliases: ['Pomeriggio al museo'],
  },
  {
    value: 'weekend_al_lago',
    label: 'Weekend al lago',
    aliases: ['Weekend al lago'],
  },
] as const;

export type FarwayOccasionDusoValue = (typeof farwayOccasionDusoChoices)[number]['value'];

export function normalizeFarwayOccasionToken(value: string) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const farwayOccasionDusoChoicesByValue = new Map(
  farwayOccasionDusoChoices.map((choice) => [choice.value, choice])
);

const farwayOccasionDusoValueByLabel = new Map(
  farwayOccasionDusoChoices.flatMap((choice) =>
    [choice.label, choice.value, ...choice.aliases].map((label) => [
      normalizeFarwayOccasionToken(label),
      choice.value,
    ] as const)
  )
);

export function mapFarwayOccasionLabelToValue(label: string) {
  const normalized = normalizeFarwayOccasionToken(label);
  return farwayOccasionDusoValueByLabel.get(normalized) || null;
}

export function mapFarwayOccasionValueToLabel(value: string) {
  return farwayOccasionDusoChoicesByValue.get(value as FarwayOccasionDusoValue)?.label || value;
}

export function mapFarwayOccasionLabelsToValues(labels: string[]) {
  return Array.from(
    new Set(
      labels
        .map((label) => mapFarwayOccasionLabelToValue(label))
        .filter((value): value is FarwayOccasionDusoValue => Boolean(value))
    )
  );
}

export function getFarwayOccasionSearchTokens(valueOrLabel: string) {
  const mappedValue =
    farwayOccasionDusoChoicesByValue.has(valueOrLabel as FarwayOccasionDusoValue)
      ? (valueOrLabel as FarwayOccasionDusoValue)
      : mapFarwayOccasionLabelToValue(valueOrLabel);
  const choice = mappedValue ? farwayOccasionDusoChoicesByValue.get(mappedValue) : null;

  if (!choice) {
    return [normalizeFarwayOccasionToken(valueOrLabel)].filter(Boolean);
  }

  return Array.from(
    new Set(
      [choice.value, choice.label, ...choice.aliases]
        .map((token) => normalizeFarwayOccasionToken(token))
        .filter(Boolean)
    )
  );
}
