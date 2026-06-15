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

function extractUsefulAcfFacts(metaMap) {
  const facts = [];
  const usedKeys = [];
  let score = 0;

  const pushFact = (key, label, value, points) => {
    if (!value) return;
    const rendered = String(value).trim();
    if (!rendered) return;
    facts.push(`${label}: ${rendered}`);
    usedKeys.push(key);
    score += points;
  };

  const fwMateriale = uniqueValues(normalizeStringArray(getMetaValue(metaMap, 'fw_materiale')));
  if (fwMateriale.length > 0) {
    facts.push(`Materiali: ${fwMateriale.join(', ')}`);
    usedKeys.push('fw_materiale');
    score += 2;
  }

  pushFact(
    'fw_composizione_del_materiale_v2',
    'Composizione materiale',
    getMetaValue(metaMap, 'fw_composizione_del_materiale_v2'),
    2
  );
  pushFact('fw_vestibilita_v2', 'Vestibilità', getMetaValue(metaMap, 'fw_vestibilita_v2'), 1);
  pushFact(
    'fw_cura_e_istruzioni_di_lavaggio_v2',
    'Cura e lavaggio',
    getMetaValue(metaMap, 'fw_cura_e_istruzioni_di_lavaggio_v2'),
    1
  );

  const occasioni = uniqueValues(normalizeStringArray(getMetaValue(metaMap, 'occasione_duso')));
  if (occasioni.length > 0) {
    facts.push(`Occasioni d'uso: ${occasioni.join(', ')}`);
    usedKeys.push('occasione_duso');
    score += occasioni.length >= 2 ? 2 : 1;
  }

  const additionalTextKeys = [
    'fw_stile',
    'fw_stagione',
    'fw_collezione',
    'fw_finitura',
    'fw_dettagli'
  ];
  for (const key of additionalTextKeys) {
    const value = getMetaValue(metaMap, key);
    if (hasMeaningfulText(value, 10)) {
      facts.push(`${key}: ${stripHtml(String(value))}`);
      usedKeys.push(key);
      score += 1;
    }
  }

  return {
    facts,
    usedKeys: uniqueValues(usedKeys),
    score
  };
}

function isUsefulAcfSet(acfData) {
  return acfData.score >= 3 && acfData.usedKeys.length >= 2;
}

function buildGenerationPrompt(product, plainDescription, acfFacts) {
  const categories = (product.categories || [])
    .map((category) => String(category.name || '').trim())
    .filter(Boolean);

  const factualSummary = acfFacts.join(' | ');
  const oldDescription = plainDescription
    ? `Descrizione attuale (può essere vecchia/corta): ${plainDescription.slice(0, 1500)}`
    : 'Descrizione attuale assente.';

  return [
    'Scrivi in italiano e restituisci solo un oggetto JSON valido.',
    'Le chiavi devono essere: descriptionHtml, shortDescriptionHtml, designHtml, designerNoteHtml.',
    'Usa solo tag HTML: <p>, <strong>, <br>.',
    'Tono: premium, caldo, concreto, credibile. Niente frasi vuote o artificiose.',
    'descriptionHtml: 3 paragrafi brevi (max 4), leggibili e orientati e-commerce.',
    'shortDescriptionHtml: 1 paragrafo breve (2-4 frasi).',
    'designHtml: 1 paragrafo breve sul design del capo.',
    'designerNoteHtml: 1 paragrafo breve in prima persona.',
    'Usa come base principale i fatti ACF forniti. Non inventare dettagli tecnici mancanti.',
    'Se un dato non è presente negli ACF, resta generico senza inventare.',
    'Non inserire prezzo, spedizione, CTA aggressive, elenchi puntati, tag o categorie finali.',
    `Titolo prodotto: ${product.name}.`,
    categories.length > 0 ? `Categorie: ${categories.join(', ')}.` : '',
    `Fatti ACF affidabili: ${factualSummary}.`,
    oldDescription
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

function validateGeneratedPayload(payload) {
  const descriptionHtml = sanitizeModelOutput(payload?.descriptionHtml || '');
  const shortDescriptionHtml = sanitizeModelOutput(payload?.shortDescriptionHtml || '');
  const designHtml = sanitizeModelOutput(payload?.designHtml || '');
  const designerNoteHtml = sanitizeModelOutput(payload?.designerNoteHtml || '');

  if (!hasMeaningfulText(descriptionHtml, 220)) {
    return { ok: false, reason: 'descriptionHtml troppo corta o vuota' };
  }
  if (!hasMeaningfulText(shortDescriptionHtml, 70)) {
    return { ok: false, reason: 'shortDescriptionHtml troppo corta o vuota' };
  }
  if (!hasMeaningfulText(designHtml, 35)) {
    return { ok: false, reason: 'designHtml troppo corto o vuoto' };
  }
  if (!hasMeaningfulText(designerNoteHtml, 35)) {
    return { ok: false, reason: 'designerNoteHtml troppo corto o vuoto' };
  }

  return {
    ok: true,
    value: {
      descriptionHtml,
      shortDescriptionHtml,
      designHtml,
      designerNoteHtml
    }
  };
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
    limit: 0
  };

  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    if (arg.startsWith('--limit=')) {
      args.limit = Number.parseInt(arg.split('=')[1], 10) || 0;
    }
  }

  return args;
}

async function generateWithRetry(apiKey, prompt, maxAttempts = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const payload = await callGeminiJson(apiKey, prompt);
      const validated = validateGeneratedPayload(payload);
      if (!validated.ok) {
        throw new Error(validated.reason);
      }
      return validated.value;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 900 * attempt));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Errore generazione sconosciuto');
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
  const group1 = products.filter((product) => hasModernDescriptions(product));
  const group2All = products.filter((product) => !hasModernDescriptions(product));
  const group2 = args.limit > 0 ? group2All.slice(0, args.limit) : group2All;

  const updatedProducts = [];
  const notUpdatedProducts = [];

  for (let index = 0; index < group2.length; index += 1) {
    const product = group2[index];
    const metaMap = buildMetaMap(product.meta_data || []);
    const acfData = extractUsefulAcfFacts(metaMap);
    const progressPrefix = `[${index + 1}/${group2.length}] #${product.id} ${product.name}`;

    if (!isUsefulAcfSet(acfData)) {
      console.log(`${progressPrefix} -> SKIP (ACF utili insufficienti)`);
      notUpdatedProducts.push({
        id: product.id,
        name: product.name,
        reason: 'ACF utili insufficienti per una riscrittura affidabile',
        usedAcfKeys: acfData.usedKeys
      });
      continue;
    }

    const plainDescription = stripHtml(product.description || '');
    const prompt = buildGenerationPrompt(product, plainDescription, acfData.facts);

    try {
      const generated = await generateWithRetry(env.GOOGLE_GENERATIVE_AI_API_KEY, prompt, 2);
      const metaUpdates = buildUpdateMetaPayload(metaMap, {
        fw_design: generated.designHtml,
        fw_note_della_designer: generated.designerNoteHtml
      });
      const payload = {
        description: generated.descriptionHtml,
        short_description: generated.shortDescriptionHtml,
        ...(metaUpdates.length > 0 ? { meta_data: metaUpdates } : {})
      };

      if (!args.dryRun) {
        await wcRequest(env, `/wp-json/wc/v3/products/${product.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }

      console.log(`${progressPrefix} -> UPDATED`);
      updatedProducts.push({
        id: product.id,
        name: product.name,
        usedAcfKeys: acfData.usedKeys,
        dryRun: args.dryRun
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Errore sconosciuto in generazione/aggiornamento';
      console.log(`${progressPrefix} -> SKIP (${reason})`);
      notUpdatedProducts.push({
        id: product.id,
        name: product.name,
        reason,
        usedAcfKeys: acfData.usedKeys
      });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    totals: {
      publishedProducts: products.length,
      group1NewCompleteUntouched: group1.length,
      group2Candidates: group2All.length,
      processedInThisRun: group2.length,
      updated: updatedProducts.length,
      notUpdated: notUpdatedProducts.length
    },
    updatedProducts,
    notUpdatedProducts
  };

  const outDir = path.join(process.cwd(), '_local');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `farway-description-rewrite-report-${nowCompact()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(JSON.stringify({ outPath, report }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
