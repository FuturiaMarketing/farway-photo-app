const fs = require('fs');
const path = require('path');

function readEnvFile(filePath) {
  const env = {};
  const raw = fs.readFileSync(filePath, 'utf8');

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    env[key] = value;
  }

  return env;
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function textLength(value) {
  return stripHtml(value).length;
}

function hasMeaningfulText(value, minLength = 20) {
  return textLength(value) >= minLength;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function uniqueValues(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function sanitizeModelOutput(value) {
  return String(value || '')
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim();
}

function hasModernDescriptions(product) {
  const description = String(product.description || '');
  const shortDescription = String(product.short_description || '');
  const richLong =
    (description.match(/<p[\s>]/gi) || []).length >= 2 &&
    /<strong>/i.test(description) &&
    textLength(description) >= 260;
  const richShort =
    /<p[\s>]/i.test(shortDescription) &&
    /<strong>/i.test(shortDescription) &&
    textLength(shortDescription) >= 90;

  return richLong && richShort;
}

function buildMetaMap(metaData) {
  const map = new Map();
  for (const entry of Array.isArray(metaData) ? metaData : []) {
    if (entry && typeof entry.key === 'string' && entry.key.length > 0) {
      map.set(entry.key, entry);
    }
  }
  return map;
}

function getMetaValue(metaMap, key) {
  const entry = metaMap.get(key);
  return entry ? entry.value : undefined;
}

function buildUpdateMetaPayload(metaMap, values) {
  const payload = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    if (!String(value).trim()) continue;

    const existing = metaMap.get(key);
    if (existing && existing.id) {
      payload.push({ id: existing.id, key, value });
    } else {
      payload.push({ key, value });
    }
  }
  return payload;
}

function extractAcfFacts(metaMap) {
  const facts = [];

  const materiale = uniqueValues(normalizeStringArray(getMetaValue(metaMap, 'fw_materiale')));
  if (materiale.length > 0) {
    facts.push(`Materiali: ${materiale.join(', ')}`);
  }

  const composizione = String(getMetaValue(metaMap, 'fw_composizione_del_materiale_v2') || '').trim();
  if (composizione) facts.push(`Composizione: ${composizione}`);

  const vestibilita = String(getMetaValue(metaMap, 'fw_vestibilita_v2') || '').trim();
  if (vestibilita) facts.push(`Vestibilità: ${vestibilita}`);

  const lavaggio = String(getMetaValue(metaMap, 'fw_cura_e_istruzioni_di_lavaggio_v2') || '').trim();
  if (lavaggio) facts.push(`Cura e lavaggio: ${lavaggio}`);

  const occasioni = uniqueValues(normalizeStringArray(getMetaValue(metaMap, 'occasione_duso')));
  if (occasioni.length > 0) facts.push(`Occasioni d'uso: ${occasioni.join(', ')}`);

  return facts;
}

function buildPrompt(product, acfFacts) {
  const categories = (product.categories || [])
    .map((category) => String(category.name || '').trim())
    .filter(Boolean);
  const plainDescription = stripHtml(product.description || '').slice(0, 1800);

  return [
    'Scrivi in italiano e restituisci solo JSON valido.',
    'Chiavi obbligatorie: designHtml, designerNoteHtml.',
    'Usa solo tag HTML: <p>, <strong>, <br>.',
    'designHtml: un paragrafo breve, concreto, stile premium ma sobrio.',
    'designerNoteHtml: un paragrafo breve in prima persona, autentico e non enfatico.',
    'Non inventare dettagli tecnici non presenti nei dati.',
    'Se qualche dato manca, rimani generico ma credibile.',
    `Titolo prodotto: ${product.name}.`,
    categories.length > 0 ? `Categorie: ${categories.join(', ')}.` : '',
    acfFacts.length > 0 ? `Fatti ACF disponibili: ${acfFacts.join(' | ')}.` : 'Fatti ACF disponibili: nessuno.',
    plainDescription ? `Contesto descrizione attuale: ${plainDescription}` : ''
  ]
    .filter(Boolean)
    .join(' ');
}

async function callGeminiJson(apiKey, prompt) {
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['TEXT']
        }
      })
    }
  );

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      `Gemini ${response.status}: ${typeof data === 'string' ? data.slice(0, 200) : data?.error?.message || 'errore sconosciuto'}`
    );
  }

  const generatedText = sanitizeModelOutput(
    ((data?.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('\n')) || ''
  );

  if (!generatedText) {
    throw new Error('Gemini ha restituito una risposta vuota.');
  }

  try {
    return JSON.parse(generatedText);
  } catch {
    throw new Error(`JSON Gemini non valido: ${generatedText.slice(0, 300)}`);
  }
}

function validateGenerated(payload) {
  const designHtml = sanitizeModelOutput(payload?.designHtml || '');
  const designerNoteHtml = sanitizeModelOutput(payload?.designerNoteHtml || '');

  if (!hasMeaningfulText(designHtml, 30)) {
    return { ok: false, reason: 'designHtml troppo corto o vuoto' };
  }
  if (!hasMeaningfulText(designerNoteHtml, 30)) {
    return { ok: false, reason: 'designerNoteHtml troppo corto o vuoto' };
  }

  return {
    ok: true,
    value: {
      designHtml,
      designerNoteHtml
    }
  };
}

async function generateWithRetry(apiKey, prompt, maxAttempts = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const payload = await callGeminiJson(apiKey, prompt);
      const validated = validateGenerated(payload);
      if (!validated.ok) {
        throw new Error(validated.reason);
      }
      return validated.value;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Errore generazione sconosciuto');
}

async function wcRequest(env, endpoint, options = {}) {
  const base = env.WC_STORE_URL.replace(/\/$/, '');
  const auth = `consumer_key=${env.WC_CONSUMER_KEY}&consumer_secret=${env.WC_CONSUMER_SECRET}`;
  const glue = endpoint.includes('?') ? '&' : '?';
  const url = `${base}${endpoint}${glue}${auth}`;
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`Woo ${response.status} ${url}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }

  return data;
}

async function fetchPublishedProducts(env) {
  const all = [];
  let page = 1;

  while (true) {
    const batch = await wcRequest(
      env,
      `/wp-json/wc/v3/products?per_page=100&page=${page}&status=publish`
    );
    all.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }

  return all;
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    limit: 0,
    excludeIds: new Set()
  };

  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    if (arg.startsWith('--limit=')) {
      args.limit = Number.parseInt(arg.split('=')[1], 10) || 0;
    }
    if (arg.startsWith('--exclude-ids=')) {
      const ids = arg
        .split('=')[1]
        .split(',')
        .map((value) => Number.parseInt(String(value).trim(), 10))
        .filter((value) => Number.isInteger(value) && value > 0);
      args.excludeIds = new Set(ids);
    }
  }

  return args;
}

function nowCompact() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envPath = path.join(process.cwd(), '.env.local');
  const env = readEnvFile(envPath);

  if (!env.WC_STORE_URL || !env.WC_CONSUMER_KEY || !env.WC_CONSUMER_SECRET) {
    throw new Error('Configurazione WooCommerce incompleta in .env.local');
  }
  if (!env.GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new Error('GOOGLE_GENERATIVE_AI_API_KEY mancante in .env.local');
  }

  const products = await fetchPublishedProducts(env);
  const group1All = products.filter((product) => hasModernDescriptions(product));
  const group1Filtered = group1All.filter((product) => !args.excludeIds.has(Number(product.id)));
  const group1 = args.limit > 0 ? group1Filtered.slice(0, args.limit) : group1Filtered;

  const updatedProducts = [];
  const notUpdatedProducts = [];
  const alreadyCompleteProducts = [];

  for (let index = 0; index < group1.length; index += 1) {
    const product = group1[index];
    const metaMap = buildMetaMap(product.meta_data || []);
    const existingDesign = getMetaValue(metaMap, 'fw_design');
    const existingDesignerNote = getMetaValue(metaMap, 'fw_note_della_designer');
    const missingDesign = !hasMeaningfulText(existingDesign, 25);
    const missingDesignerNote = !hasMeaningfulText(existingDesignerNote, 25);
    const progressPrefix = `[${index + 1}/${group1.length}] #${product.id} ${product.name}`;

    if (!missingDesign && !missingDesignerNote) {
      console.log(`${progressPrefix} -> SKIP (design/note già presenti)`);
      alreadyCompleteProducts.push({
        id: product.id,
        name: product.name
      });
      continue;
    }

    const acfFacts = extractAcfFacts(metaMap);
    const prompt = buildPrompt(product, acfFacts);

    try {
      const generated = await generateWithRetry(env.GOOGLE_GENERATIVE_AI_API_KEY, prompt, 2);
      const metaUpdates = buildUpdateMetaPayload(metaMap, {
        ...(missingDesign ? { fw_design: generated.designHtml } : {}),
        ...(missingDesignerNote ? { fw_note_della_designer: generated.designerNoteHtml } : {})
      });

      if (metaUpdates.length === 0) {
        console.log(`${progressPrefix} -> SKIP (nessun campo da aggiornare)`);
        alreadyCompleteProducts.push({
          id: product.id,
          name: product.name
        });
        continue;
      }

      if (!args.dryRun) {
        await wcRequest(env, `/wp-json/wc/v3/products/${product.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            meta_data: metaUpdates
          })
        });
      }

      console.log(`${progressPrefix} -> UPDATED`);
      updatedProducts.push({
        id: product.id,
        name: product.name,
        updatedFields: [
          ...(missingDesign ? ['fw_design'] : []),
          ...(missingDesignerNote ? ['fw_note_della_designer'] : [])
        ],
        acfFactsUsed: acfFacts.length
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Errore sconosciuto';
      console.log(`${progressPrefix} -> SKIP (${reason})`);
      notUpdatedProducts.push({
        id: product.id,
        name: product.name,
        reason
      });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    totals: {
      publishedProducts: products.length,
      group1NewComplete: group1All.length,
      excludedByInput: args.excludeIds.size,
      processedInThisRun: group1.length,
      updated: updatedProducts.length,
      notUpdated: notUpdatedProducts.length,
      alreadyCompleteDesignAndNote: alreadyCompleteProducts.length
    },
    updatedProducts,
    notUpdatedProducts,
    alreadyCompleteProducts
  };

  const outDir = path.join(process.cwd(), '_local');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `farway-fill-design-notes-group1-report-${nowCompact()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(JSON.stringify({ outPath, report }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
