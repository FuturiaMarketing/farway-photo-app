// Isomorphic helpers shared by the review UI (filename preview) and the rename step.
// Standard: <Nome-Prodotto>-<Colorway>-still-life-<vista>-di-Farway-Milano.jpg
// Monocolor products omit the colorway token. Duplicate (product, colorway, view) get a -N suffix,
// assigned only at rename time (when the full set is known), so the preview shows the base name.

export const VIEWS = ['front', 'retro', 'retro-risvolto', 'dettaglio', 'lato'] as const;
export type View = (typeof VIEWS)[number] | string;

/** Filename-safe slug that preserves case and accents; spaces/punctuation -> single hyphen. */
export function cleanSegment(s: string): string {
  return String(s || '')
    .normalize('NFC')
    .replace(/&/g, 'e')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/['’.,()]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildTargetName(opts: {
  productName: string;
  colorway?: string | null;
  view?: string | null;
  suffix?: number | null;
}): string {
  const parts: string[] = [cleanSegment(opts.productName)];
  if (opts.colorway && opts.colorway.trim()) parts.push(cleanSegment(opts.colorway));
  parts.push('still-life');
  let view = (opts.view || '').trim();
  if (view) {
    if (opts.suffix && opts.suffix > 1) view = `${view}-${opts.suffix}`;
    parts.push(view);
  } else if (opts.suffix && opts.suffix > 1) {
    parts.push(String(opts.suffix));
  }
  parts.push('di-Farway-Milano');
  return parts.filter(Boolean).join('-') + '.jpg';
}
