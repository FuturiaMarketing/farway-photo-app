#!/usr/bin/env node
'use strict';

/**
 * farway-draft-acf-populate.cjs
 *
 * Popola gli ACF dei parent variable in bozza creati dal consolidamento
 * (`farway-draft-consolidate.cjs`), seguendo due strategie:
 *   1) MATCH PUBBLICATO: per ogni parent draft, cerca il prodotto pubblicato
 *      con nome matching (es. "Pantalone Capri sfilacciato" draft ↔ pubblicato).
 *      Se trovato, copia gli ACF customer-facing (`fw_*`, occasione_duso,
 *      tempistica_*).
 *   2) ESTRAZIONE DA NOME: per i parent senza match, estrae il materiale
 *      dal nome modello (es. "Abito Charlotte smanicato in mussola" → `fw_materiale=Mussola`).
 *
 * Vincoli:
 *   - NON cambia status/visibility/attributi/categorie/prezzi.
 *   - Lavora SOLO sui meta_data ACF customer-facing.
 *   - Idempotente: skip ACF già popolati sui draft.
 *   - I `fw_erp_*` (set dal consolidamento) restano intatti.
 *
 * Modi:
 *   - dry-run (default): genera report `.md` + plan JSON, nessuna scrittura
 *   - apply: scrive su WC (richiede --confirm FARWAY_DRAFTS_ACF_POPULATE_APPROVED)
 */

const fs = require('fs/promises');
const path = require('path');

// ============================================================
// COSTANTI
// ============================================================

const APPLY_CONFIRMATION = 'FARWAY_DRAFTS_ACF_POPULATE_APPROVED';
const WC_API_TIMEOUT_MS = 60000;
const WC_WRITE_DELAY_MS = 200;

// ACF customer-facing da copiare dai pubblicati ai draft.
// Ogni ACF ha 2 chiavi: la "user" (es. `fw_materiale`) e la "internal" `_fw_materiale`
// (ACF field key reference). Settiamo entrambe.
const ACF_USER_KEYS = [
  'fw_materiale',
  'fw_composizione_del_materiale_v2',
  'fw_rifiniture',
  'fw_orlo_v2',
  'fw_logo_v2',
  'fw_vestibilita_v2',
  'fw_dove_e_stato_creato_v2',
  'fw_cura_e_istruzioni_di_lavaggio_v2',
  'occasione_duso',
  'tempistica_di_progettazione',
  'tempistica_di_fabbricazione',
  'fw_design',
  'fw_note_della_designer',
  // Specifici pantaloni
  'fw_pantalone_elastico_v2',
  'fw_pantalone_risvolto_v2',
  'fw_pantalone_tasche_v2',
];

// Estrazione materiale dal nome modello (fallback se no match pubblicato).
// Pattern: "<modello> in <materiale>" o "<modello> <materiale>" con keyword precise.
const MATERIAL_KEYWORDS = [
  { label: 'Mussola', regex: /\bmussol[ae]?\b/i },
  { label: 'Lino', regex: /\blino\b/i },
  { label: 'Velluto', regex: /\bvelluto\b/i },
  { label: 'Voile', regex: /\bvoile\b/i },
  { label: 'Popeline', regex: /\bpopeline\b/i },
  { label: 'Denim', regex: /\bdenim\b/i },
  { label: 'Cotone', regex: /\bcotone\b/i },
  { label: 'Jersey', regex: /\bjersey\b/i },
  { label: 'Seta', regex: /\bseta\b/i },
  { label: 'Lana', regex: /\blana\b/i },
];

function extractMaterialFromName(name) {
  const n = String(name || '');
  for (const rule of MATERIAL_KEYWORDS) {
    if (rule.regex.test(n)) return rule.label;
  }
  return '';
}

// ============================================================
// UTILITY (riprodotta da consolidate script)
// ============================================================

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(value) {
  return normalizeText(value).replace(/\s+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

function nowCompact() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getMetaValue(metaData, key) {
  if (!Array.isArray(metaData)) return undefined;
  for (const m of metaData) {
    if (m && m.key === key) return m.value;
  }
  return undefined;
}

function metaIsMeaningful(value) {
  if (value === null || value === undefined) return false;
  const s = String(value).trim();
  if (!s) return false;
  if (s === '0' || s === 'false' || s === 'null') return false;
  return true;
}

// ============================================================
// ENV / WC
// ============================================================

async function loadEnvFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const sep = t.indexOf('=');
      if (sep <= 0) continue;
      const k = t.slice(0, sep).trim();
      if (!k || process.env[k]) continue;
      let v = t.slice(sep + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[k] = v;
    }
  } catch {}
}

async function resolveWooSettings(scriptDir) {
  const envPath = path.join(scriptDir, '..', '.env.local');
  await loadEnvFile(envPath);
  const storeUrl = String(process.env.WC_STORE_URL || '').trim().replace(/\/$/, '');
  const consumerKey = String(process.env.WC_CONSUMER_KEY || '').trim();
  const consumerSecret = String(process.env.WC_CONSUMER_SECRET || '').trim();
  if (!storeUrl || !consumerKey || !consumerSecret) {
    throw new Error(`Credenziali WooCommerce mancanti in ${envPath}`);
  }
  return { storeUrl, consumerKey, consumerSecret };
}

async function fetchWithTimeout(url, init = {}, timeoutMs = WC_API_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(tid); }
}

function buildWooUrl(settings, endpoint) {
  const auth = `consumer_key=${encodeURIComponent(settings.consumerKey)}&consumer_secret=${encodeURIComponent(settings.consumerSecret)}`;
  const sep = endpoint.includes('?') ? '&' : '?';
  return `${settings.storeUrl}/wp-json/wc/v3/${endpoint}${sep}${auth}`;
}

async function wooRequest(settings, method, endpoint, body) {
  const res = await fetchWithTimeout(buildWooUrl(settings, endpoint), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`Woo ${method} ${endpoint} -> HTTP ${res.status}: ${String(text).slice(0, 400)}`);
  return data;
}

async function wooFetchAll(settings, endpoint, extra = '') {
  const out = [];
  let page = 1;
  while (true) {
    const sep = endpoint.includes('?') ? '&' : '?';
    const qs = `per_page=100&page=${page}${extra ? '&' + extra : ''}`;
    const batch = await wooRequest(settings, 'GET', `${endpoint}${sep}${qs}`);
    if (!Array.isArray(batch)) throw new Error(`Risposta Woo inattesa per ${endpoint}`);
    out.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return out;
}

// ============================================================
// ARGS
// ============================================================

function parseArgs(argv) {
  const args = {
    apply: false,
    confirm: '',
    outputDir: '',
    onlyExtractMaterial: false, // se true, salta match pubblicato, fa solo estrazione nome
    onlyMatchPublished: false, // se true, salta estrazione nome
    limitParents: 0,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i] || '');
    if (a === '--apply') { args.apply = true; continue; }
    if (a === '--confirm') { args.confirm = String(argv[i + 1] || '').trim(); i += 1; continue; }
    if (a === '--output-dir') { args.outputDir = String(argv[i + 1] || '').trim(); i += 1; continue; }
    if (a === '--only-extract-material') { args.onlyExtractMaterial = true; continue; }
    if (a === '--only-match-published') { args.onlyMatchPublished = true; continue; }
    if (a === '--limit-parents') { args.limitParents = Number(argv[i + 1] || 0); i += 1; continue; }
    if (a === '--verbose' || a === '-v') { args.verbose = true; continue; }
  }
  return args;
}

// ============================================================
// MATCH LOGIC
// ============================================================

/**
 * Normalizza il nome modello per matching: lowercase, no accenti, no spazi
 * extra, ignora suffissi tipo "manica corta/lunga" se utile.
 */
function buildMatchKey(name) {
  return normalizeText(name);
}

/**
 * Match strategie (in ordine di preferenza):
 *   1. Exact name match (normalizzato)
 *   2. Slug match (normalizzato senza spazi)
 *   3. Subset match: il nome draft è incluso completamente nel pubblicato o viceversa
 *      (utile per "Abito Charlotte smanicato in lino" ↔ "Abito Charlotte in lino smanicato")
 *   4. Token overlap >= 80% (Jaccard su token significativi)
 */
function findPublishedMatch(draftName, publishedIndex) {
  const draftKey = buildMatchKey(draftName);
  const draftSlug = slugify(draftName);

  // 1. Exact name match
  if (publishedIndex.byName.has(draftKey)) {
    return { match: publishedIndex.byName.get(draftKey), confidence: 'exact_name' };
  }

  // 2. Slug match (sub-slug)
  if (publishedIndex.bySlug.has(draftSlug)) {
    return { match: publishedIndex.bySlug.get(draftSlug), confidence: 'exact_slug' };
  }

  // 3. Token Jaccard
  const draftTokens = new Set(draftKey.split(' ').filter((t) => t && t.length >= 3));
  if (draftTokens.size === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const pub of publishedIndex.all) {
    const pubKey = buildMatchKey(pub.name);
    const pubTokens = new Set(pubKey.split(' ').filter((t) => t && t.length >= 3));
    if (pubTokens.size === 0) continue;
    const intersection = [...draftTokens].filter((t) => pubTokens.has(t)).length;
    const union = new Set([...draftTokens, ...pubTokens]).size;
    const jaccard = intersection / union;
    if (jaccard > bestScore) {
      bestScore = jaccard;
      best = pub;
    }
  }

  if (best && bestScore >= 0.8) {
    return { match: best, confidence: `jaccard_${bestScore.toFixed(2)}` };
  }
  if (best && bestScore >= 0.6) {
    return { match: best, confidence: `jaccard_low_${bestScore.toFixed(2)}`, low_confidence: true };
  }
  return null;
}

function buildPublishedIndex(publishedProducts) {
  const byName = new Map();
  const bySlug = new Map();
  for (const p of publishedProducts) {
    const k = buildMatchKey(p.name);
    if (!byName.has(k)) byName.set(k, p);
    const s = slugify(p.name);
    if (!bySlug.has(s)) bySlug.set(s, p);
  }
  return { byName, bySlug, all: publishedProducts };
}

function extractAcfFromPublished(pubProduct) {
  const acf = {};
  for (const m of pubProduct.meta_data || []) {
    if (!m || !m.key) continue;
    if (ACF_USER_KEYS.includes(m.key) && metaIsMeaningful(m.value)) {
      acf[m.key] = m.value;
    }
  }
  return acf;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const scriptDir = __dirname;
  const args = parseArgs(process.argv.slice(2));

  console.log('========================================');
  console.log(' Farway — ACF populate parent variable draft');
  console.log(`  Modalità: ${args.apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log('========================================');

  if (args.apply && args.confirm !== APPLY_CONFIRMATION) {
    throw new Error(`Apply richiede --confirm ${APPLY_CONFIRMATION}`);
  }

  const settings = await resolveWooSettings(scriptDir);
  console.log(`[setup] store: ${settings.storeUrl}`);

  const baseDataDir = path.join(scriptDir, '..', 'data');
  const outputDir = args.outputDir || path.join(baseDataDir, `farway-draft-acf-populate-${nowCompact()}`);
  await fs.mkdir(outputDir, { recursive: true });
  console.log(`[setup] output dir: ${outputDir}`);

  // === Fase 0 — Discovery ===
  console.log('[phase 0] discovery...');

  // Fetch parent variable in draft
  console.log('  - fetch parent variable in draft...');
  const draftsAll = await wooFetchAll(settings, 'products', 'status=draft&type=variable');
  console.log(`  ✓ ${draftsAll.length} parent variable draft`);

  // Filtriamo solo i parent creati dal consolidamento (marker `_fw_consolidate_run_id`)
  const drafts = draftsAll.filter((d) => {
    return d.meta_data && d.meta_data.some((m) => m.key === '_fw_consolidate_run_id');
  });
  console.log(`  ✓ ${drafts.length} parent con marker consolidamento`);

  // Fetch tutti i pubblicati (simple + variable)
  console.log('  - fetch prodotti pubblicati...');
  const publishedAll = await wooFetchAll(settings, 'products', 'status=publish');
  // Escludi varianti (type=variation non viene comunque da /products, ma per sicurezza)
  const published = publishedAll.filter((p) => p.type !== 'variation');
  console.log(`  ✓ ${published.length} prodotti pubblicati`);

  await fs.writeFile(path.join(outputDir, 'backup-drafts-pre-acf.json'), JSON.stringify(drafts, null, 2), 'utf8');
  await fs.writeFile(path.join(outputDir, 'backup-published-snapshot.json'), JSON.stringify(published, null, 2), 'utf8');

  const pubIndex = buildPublishedIndex(published);

  // === Fase 1 — Match + plan ===
  console.log('[phase 1] match parent draft ↔ pubblicato + plan ACF...');

  let targets = drafts;
  if (args.limitParents > 0) targets = drafts.slice(0, args.limitParents);

  const plan = [];
  let countMatched = 0;
  let countLowConf = 0;
  let countNoMatch = 0;
  let countExtractedMaterial = 0;

  for (const draft of targets) {
    const entry = {
      parent_id: draft.id,
      parent_name: draft.name,
      match: null,
      acf_from_match: {},
      acf_from_extraction: {},
      acf_skipped_already_set: {},
      total_acf_to_set: 0,
      changes_planned: false,
    };

    // Quali ACF il draft ha già?
    const draftAcfPresent = {};
    for (const k of ACF_USER_KEYS) {
      const v = getMetaValue(draft.meta_data, k);
      if (metaIsMeaningful(v)) draftAcfPresent[k] = v;
    }

    // 1) Match pubblicato
    if (!args.onlyExtractMaterial) {
      const m = findPublishedMatch(draft.name, pubIndex);
      if (m) {
        entry.match = {
          id: m.match.id,
          name: m.match.name,
          confidence: m.confidence,
          low_confidence: m.low_confidence || false,
        };
        // GUARDRAIL: low_confidence match NON triggera copia (rischio mismatch).
        // Esempio: "Camicia RIF" ↔ "Camicia Coreana" → modelli diversi.
        if (!m.low_confidence) {
          const acfFromPub = extractAcfFromPublished(m.match);
          for (const k of ACF_USER_KEYS) {
            if (!metaIsMeaningful(acfFromPub[k])) continue;
            if (draftAcfPresent[k]) {
              entry.acf_skipped_already_set[k] = draftAcfPresent[k];
            } else {
              entry.acf_from_match[k] = acfFromPub[k];
            }
          }
          countMatched += 1;
        } else {
          countLowConf += 1;
        }
      } else {
        countNoMatch += 1;
      }
    }

    // 2) Estrazione materiale dal nome (fallback o complemento)
    if (!args.onlyMatchPublished) {
      // Se fw_materiale non è già settato (né dal draft né dal match), prova ad estrarlo
      const matAlreadySet = draftAcfPresent.fw_materiale || entry.acf_from_match.fw_materiale;
      if (!matAlreadySet) {
        const extracted = extractMaterialFromName(draft.name);
        if (extracted) {
          entry.acf_from_extraction.fw_materiale = extracted;
          countExtractedMaterial += 1;
        }
      }
    }

    entry.total_acf_to_set =
      Object.keys(entry.acf_from_match).length + Object.keys(entry.acf_from_extraction).length;
    entry.changes_planned = entry.total_acf_to_set > 0;

    plan.push(entry);
  }

  await fs.writeFile(path.join(outputDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');

  // === Report ===
  const lines = [];
  lines.push('# Farway — ACF populate parent variable draft: report');
  lines.push('');
  lines.push(`Generato: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Sintesi');
  lines.push('');
  lines.push(`- Parent variable draft analizzati: **${targets.length}**`);
  lines.push(`- Match pubblicato (alta confidence): **${countMatched}**`);
  lines.push(`- Match pubblicato (bassa confidence Jaccard 0.6-0.8): **${countLowConf}**`);
  lines.push(`- Senza match pubblicato: **${countNoMatch}**`);
  lines.push(`- Materiale estratto da nome (fallback): **${countExtractedMaterial}**`);
  const totalChanges = plan.filter((p) => p.changes_planned).length;
  lines.push(`- Parent con modifiche ACF previste: **${totalChanges}**`);
  lines.push(`- Parent senza modifiche (ACF già completi o nessuna fonte): **${targets.length - totalChanges}**`);
  lines.push('');
  lines.push('## Per parent');
  lines.push('');
  lines.push('| Parent ID | Nome | Match | Confidence | ACF da copia | ACF da estrazione | Skip (già set) |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const p of plan) {
    const matchName = p.match ? p.match.name + ' (id ' + p.match.id + ')' : '—';
    const conf = p.match ? p.match.confidence : '—';
    const fromMatch = Object.keys(p.acf_from_match).length;
    const fromExtr = Object.keys(p.acf_from_extraction).length;
    const skipped = Object.keys(p.acf_skipped_already_set).length;
    lines.push(`| ${p.parent_id} | ${escapeMd(p.parent_name)} | ${escapeMd(matchName)} | ${conf} | ${fromMatch} | ${fromExtr} | ${skipped} |`);
  }
  lines.push('');
  // Dettaglio ACF estratti
  lines.push('## Dettaglio estrazione materiale da nome');
  lines.push('');
  lines.push('| Parent ID | Nome | Materiale estratto |');
  lines.push('|---|---|---|');
  for (const p of plan) {
    if (p.acf_from_extraction.fw_materiale) {
      lines.push(`| ${p.parent_id} | ${escapeMd(p.parent_name)} | ${p.acf_from_extraction.fw_materiale} |`);
    }
  }
  lines.push('');
  // ACF copy summary per parent (top 30 by changes)
  lines.push('## Esempi parent con copy ACF (top per # ACF copiati)');
  lines.push('');
  const sortedByCopy = [...plan]
    .filter((p) => Object.keys(p.acf_from_match).length > 0)
    .sort((a, b) => Object.keys(b.acf_from_match).length - Object.keys(a.acf_from_match).length)
    .slice(0, 30);
  for (const p of sortedByCopy) {
    lines.push(`### ${p.parent_name} (id ${p.parent_id})`);
    lines.push('');
    lines.push(`- Match: ${p.match.name} (id ${p.match.id}, confidence ${p.match.confidence})`);
    lines.push('- ACF copiati:');
    for (const [k, v] of Object.entries(p.acf_from_match)) {
      const preview = String(v).slice(0, 80).replace(/\n/g, ' ');
      lines.push(`  - \`${k}\`: ${preview}${String(v).length > 80 ? '…' : ''}`);
    }
    if (Object.keys(p.acf_from_extraction).length) {
      lines.push('- ACF da estrazione nome:');
      for (const [k, v] of Object.entries(p.acf_from_extraction)) {
        lines.push(`  - \`${k}\`: ${v}`);
      }
    }
    lines.push('');
  }
  await fs.writeFile(path.join(outputDir, 'report.md'), lines.join('\n'), 'utf8');

  console.log(`  ✓ plan: ${path.join(outputDir, 'plan.json')}`);
  console.log(`  ✓ report: ${path.join(outputDir, 'report.md')}`);

  if (!args.apply) {
    console.log('');
    console.log('==========================================');
    console.log('[ok] DRY-RUN completato.');
    console.log(`     Per applicare:`);
    console.log(`       node scripts/farway-draft-acf-populate.cjs --apply --confirm ${APPLY_CONFIRMATION} --output-dir "${outputDir}"`);
    console.log('==========================================');
    return;
  }

  // === Fase 2 — Apply ===
  console.log('[phase 2] APPLY...');

  const runId = nowCompact();
  const appliedSummary = {
    run_id: runId,
    started_at: new Date().toISOString(),
    parents_total: targets.length,
    parents_updated: [],
    failures: [],
  };

  let i = 0;
  for (const entry of plan) {
    i += 1;
    if (!entry.changes_planned) continue;
    console.log(`  [${i}/${plan.length}] ${entry.parent_name} (id ${entry.parent_id}) — ${entry.total_acf_to_set} ACF`);

    const newMeta = [];
    const allAcf = { ...entry.acf_from_match, ...entry.acf_from_extraction };
    for (const [k, v] of Object.entries(allAcf)) {
      newMeta.push({ key: k, value: v });
    }
    // Marker
    newMeta.push({ key: '_fw_acf_populated_at', value: new Date().toISOString() });
    newMeta.push({ key: '_fw_acf_populated_run_id', value: runId });
    if (entry.match) {
      newMeta.push({ key: '_fw_acf_populated_source_id', value: String(entry.match.id) });
    }

    try {
      await wooRequest(settings, 'PUT', `products/${entry.parent_id}`, { meta_data: newMeta });
      appliedSummary.parents_updated.push({
        parent_id: entry.parent_id,
        parent_name: entry.parent_name,
        acf_count: entry.total_acf_to_set,
        source_match_id: entry.match ? entry.match.id : null,
      });
      console.log(`    ✓ aggiornato`);
      await sleep(WC_WRITE_DELAY_MS);
    } catch (err) {
      console.error(`    ✗ FALLITO: ${err.message}`);
      appliedSummary.failures.push({ parent_id: entry.parent_id, error: err.message });
    }
  }

  appliedSummary.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(outputDir, 'applied-summary.json'), JSON.stringify(appliedSummary, null, 2), 'utf8');
  console.log('');
  console.log('==========================================');
  console.log(`[ok] APPLY completato: ${appliedSummary.parents_updated.length} aggiornati, ${appliedSummary.failures.length} falliti`);
  console.log(`     Riepilogo: ${path.join(outputDir, 'applied-summary.json')}`);
  console.log('==========================================');
}

function escapeMd(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

main().catch((err) => {
  console.error('');
  console.error('[ERRORE FATALE]', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
