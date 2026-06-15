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

function normalizeText(value) {
  return stripHtml(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function cleanTitleRemovingUnisex(title) {
  return String(title || '')
    .replace(/\bunisex\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
}

function ensureUniqueSlug(baseSlug, currentProductId, products) {
  const normalizedBase = slugify(baseSlug) || 'prodotto';
  const existing = new Set(
    products
      .filter((product) => Number(product.id) !== Number(currentProductId))
      .map((product) => String(product.slug || '').trim())
      .filter(Boolean)
  );

  if (!existing.has(normalizedBase)) {
    return normalizedBase;
  }

  let i = 2;
  while (existing.has(`${normalizedBase}-${i}`)) {
    i += 1;
  }

  return `${normalizedBase}-${i}`;
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

function inferComposition(text) {
  const normalized = normalizeText(text);
  const patterns = [
    {
      value: '95pct_di_cotone_organico_certificato_gots_e_5pct_di_elastane',
      regex: /95\s*%\s*(?:di\s*)?cotone(?:\s+organico|\s+biologico)?(?:\s+certificato\s+gots)?\s+e\s+5\s*%\s*(?:di\s*)?elastan/
    },
    {
      value: '55pct_lino_e_45pct_cotone',
      regex: /55\s*%\s*lino\s+e\s+45\s*%\s*(?:di\s*)?cotone/
    },
    {
      value: '80pct_cotone_e_20pct_poliestere',
      regex: /80\s*%\s*(?:di\s*)?cotone\s+e\s+20\s*%\s*(?:di\s*)?poliestere/
    },
    {
      value: '100pct_cotone_organico',
      regex: /100\s*%\s*(?:di\s*)?cotone(?:\s+organico|\s+biologico)/
    },
    {
      value: '100pct_cotone',
      regex: /100\s*%\s*(?:di\s*)?cotone(?!\s+(?:organico|biologico))/
    }
  ];

  const match = patterns.find((item) => item.regex.test(normalized));
  return match ? match.value : null;
}

function inferMaterials(text, composition) {
  const normalized = normalizeText(text);
  const materials = new Set();

  if (composition === '100pct_cotone_organico') {
    materials.add('cotone_biologico');
  }
  if (composition === '100pct_cotone') {
    materials.add('cotone');
  }
  if (composition === '95pct_di_cotone_organico_certificato_gots_e_5pct_di_elastane') {
    materials.add('cotone_biologico');
  }
  if (composition === '55pct_lino_e_45pct_cotone') {
    materials.add('lino');
    materials.add('cotone');
  }
  if (composition === '80pct_cotone_e_20pct_poliestere') {
    materials.add('cotone');
  }

  const keywordMap = [
    ['cotone_biologico', /\bcotone\s+(?:organico|biologico)\b/],
    ['cotone', /\bcotone\b/],
    ['velluto', /\bvelluto\b/],
    ['denim', /\bdenim\b/],
    ['voile', /\bvoile\b/],
    ['lino', /\blino\b/],
    ['mille_righe', /\bmille[\s-]?righe\b/],
    ['mussola', /\bmussola\b/]
  ];

  for (const [key, regex] of keywordMap) {
    if (regex.test(normalized)) {
      materials.add(key);
    }
  }

  return Array.from(materials);
}

function isAccessoryProduct(product) {
  const categorySlugs = (product.categories || []).map((category) =>
    String(category.slug || '').toLowerCase()
  );

  return categorySlugs.some((slug) =>
    [
      'accessori',
      'borse',
      'capelli',
      'cerchietti',
      'fermagli',
      'scrunchies'
    ].includes(slug)
  );
}

function normalizeMaterialSelection(materials, { isAccessory }) {
  const normalized = uniqueValues(normalizeStringArray(materials));
  const withoutCottonConflict = normalized.filter(
    (material) => material !== 'cotone' || !normalized.includes('cotone_biologico')
  );

  if (isAccessory) {
    return withoutCottonConflict;
  }

  return withoutCottonConflict.map((material) =>
    material === 'cotone' ? 'cotone_biologico' : material
  );
}

function resolveMaterialSelection(product, text, composition, existingMaterials) {
  const normalizedExisting = normalizeStringArray(existingMaterials);
  if (normalizedExisting.length > 0) {
    return normalizedExisting;
  }

  return normalizeMaterialSelection(inferMaterials(text, composition), {
    isAccessory: isAccessoryProduct(product)
  });
}

function inferWash(materials, composition, text) {
  const normalized = normalizeText(text);
  const set = new Set(materials || []);

  if (set.has('denim') || /\bdenim\b/.test(normalized)) {
    return 'resistente';
  }

  if (
    set.has('voile') ||
    set.has('mussola') ||
    set.has('lino') ||
    set.has('velluto') ||
    /\b(voile|mussola|lino|velluto)\b/.test(normalized)
  ) {
    return 'delicato';
  }

  if (
    composition ||
    set.has('cotone_biologico') ||
    set.has('cotone') ||
    set.has('mille_righe') ||
    /\b(cotone|gabardina|popeline)\b/.test(normalized)
  ) {
    return 'normale';
  }

  return null;
}

function inferFit(text, title) {
  const normalized = `${normalizeText(title)} ${normalizeText(text)}`;

  if (/\boversize\b/.test(normalized)) return 'oversize';
  if (/\b(?:slim|aderente|attillata|attillato|fitted)\b/.test(normalized)) return 'aderente';
  if (/\bvestibilita regolare\b/.test(normalized) || /\blinea regolare\b/.test(normalized)) {
    return 'regolare';
  }

  return null;
}

function inferGender(product, originalTitle, plainDescription) {
  const title = normalizeText(originalTitle);
  const description = normalizeText(plainDescription);
  const combined = `${title} ${description}`;
  const categorySlugs = (product.categories || []).map((category) => String(category.slug || '').toLowerCase());
  const currentGenre = categorySlugs.filter((slug) => ['femmina', 'maschio', 'unisex'].includes(slug));

  if (/\bunisex\b/.test(combined)) {
    return { value: 'unisex', reason: 'esplicito nel titolo o nella descrizione' };
  }

  const femininePatterns = [
    /\bbambin[ae]\b/,
    /\bbambine\b/,
    /\bgonna\b/,
    /\bgonne\b/,
    /\bcamicietta\b/,
    /\bgirl\b/
  ];
  const masculinePatterns = [
    /\bbambino\b/,
    /\bbambini\b/,
    /\bboy\b/
  ];

  const feminineHits = femininePatterns.filter((pattern) => pattern.test(combined)).length;
  const masculineHits = masculinePatterns.filter((pattern) => pattern.test(combined)).length;

  if (categorySlugs.includes('gonne')) {
    return { value: 'femmina', reason: 'tipologia gonna' };
  }

  if (feminineHits > 0 && masculineHits === 0) {
    return { value: 'femmina', reason: 'titolo o descrizione orientati al femminile' };
  }

  if (masculineHits > 0 && feminineHits === 0) {
    return { value: 'maschio', reason: 'titolo o descrizione orientati al maschile' };
  }

  if (currentGenre.length === 1 && currentGenre[0] !== 'unisex') {
    return { value: currentGenre[0], reason: 'unica categoria genere gia presente' };
  }

  return { value: null, reason: 'genere non abbastanza chiaro' };
}

function inferOccasioniDuso(product, originalTitle, plainDescription, existingValues) {
  const existing = normalizeStringArray(existingValues);
  if (existing.length > 0) {
    return existing.slice(0, 3);
  }

  const combined = `${normalizeText(originalTitle)} ${normalizeText(plainDescription)}`;
  const categorySlugs = (product.categories || []).map((category) =>
    String(category.slug || '').toLowerCase()
  );
  const scores = new Map([
    ['casa_nonni', 0],
    ['passeggiata_famiglia', 0],
    ['compleanno', 0],
    ['vestito_domenica', 0],
    ['sera_estate_gelato', 0],
    ['occasioni_eleganti', 0]
  ]);
  const fallbackOrder = isAccessoryProduct(product)
    ? ['compleanno', 'occasioni_eleganti', 'vestito_domenica', 'passeggiata_famiglia', 'sera_estate_gelato', 'casa_nonni']
    : ['passeggiata_famiglia', 'casa_nonni', 'vestito_domenica', 'compleanno', 'sera_estate_gelato', 'occasioni_eleganti'];

  const addScore = (key, value) => scores.set(key, (scores.get(key) || 0) + value);
  const addScores = (entries) => {
    for (const [key, value] of entries) addScore(key, value);
  };

  if (categorySlugs.includes('gonne') || /\b(gonna|abito|vestito|salopette)\b/.test(combined)) {
    addScores([
      ['vestito_domenica', 5],
      ['compleanno', 4],
      ['occasioni_eleganti', 4]
    ]);
  }

  if (/\b(camicia|blusa|giacca|velluto|elegant|raffinat|special)\b/.test(combined)) {
    addScores([
      ['occasioni_eleganti', 5],
      ['vestito_domenica', 4],
      ['compleanno', 3]
    ]);
  }

  if (/\b(t-?shirt|top|felpa|maglieria|pantalon|pantalonc|body|tutina|denim|quotidian|comodo|pratic)\b/.test(combined)) {
    addScores([
      ['passeggiata_famiglia', 5],
      ['casa_nonni', 4],
      ['sera_estate_gelato', 3]
    ]);
  }

  if (/\b(lino|voile|mussola|estate|legger[oa]|fresco)\b/.test(combined)) {
    addScores([
      ['sera_estate_gelato', 5],
      ['passeggiata_famiglia', 3],
      ['casa_nonni', 2]
    ]);
  }

  if (categorySlugs.some((slug) => ['cerchietti', 'fermagli', 'capelli', 'scrunchies'].includes(slug))) {
    addScores([
      ['compleanno', 5],
      ['occasioni_eleganti', 4],
      ['vestito_domenica', 3]
    ]);
  }

  if (categorySlugs.includes('borse')) {
    addScores([
      ['passeggiata_famiglia', 4],
      ['sera_estate_gelato', 4],
      ['occasioni_eleganti', 3]
    ]);
  }

  if (/\b(nonni|famiglia|weekend|quotidian)\b/.test(combined)) {
    addScores([
      ['casa_nonni', 4],
      ['passeggiata_famiglia', 3]
    ]);
  }

  if (/\b(compleanno|festa|party)\b/.test(combined)) {
    addScores([
      ['compleanno', 6],
      ['vestito_domenica', 2]
    ]);
  }

  if (/\b(pranzo|cena|cerimon|elegant)\b/.test(combined)) {
    addScores([
      ['occasioni_eleganti', 6],
      ['vestito_domenica', 3]
    ]);
  }

  const selected = Array.from(scores.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return fallbackOrder.indexOf(a[0]) - fallbackOrder.indexOf(b[0]);
    })
    .map(([key]) => key)
    .slice(0, 3);

  for (const fallback of fallbackOrder) {
    if (selected.length >= 3) break;
    if (!selected.includes(fallback)) selected.push(fallback);
  }

  return selected.slice(0, 3);
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

function buildFallbackAcf(categories) {
  const normalizedCategories = (categories || [])
    .map((value) => normalizeText(value))
    .join(' ');

  let designHours = 36;
  let manufacturingHours = 1;

  if (/\b(abiti|vestiti|salopette)\b/.test(normalizedCategories)) {
    designHours = 42;
    manufacturingHours = 2;
  } else if (/\bcamici/.test(normalizedCategories)) {
    designHours = 36;
    manufacturingHours = 1;
  } else if (/\bpantalon/.test(normalizedCategories)) {
    designHours = 34;
    manufacturingHours = 1;
  } else if (/\bgonn/.test(normalizedCategories)) {
    designHours = 34;
    manufacturingHours = 1;
  } else if (/\bt-?shirt|\btop\b/.test(normalizedCategories)) {
    designHours = 30;
    manufacturingHours = 1;
  }

  return {
    designHtml:
      '<p><strong>Design e stile</strong><br />Linee curate, proporzioni equilibrate e un gusto raffinato pensato per valorizzare il capo con eleganza contemporanea, senza eccessi.</p>',
    designerNoteHtml:
      '<p><strong>Note della designer</strong><br />Ho immaginato questo capo come una presenza speciale nel guardaroba dei piu piccoli: bello da vedere, piacevole da indossare e naturale da vivere nei momenti importanti di ogni giorno.</p>',
    designHours: String(Math.max(30, designHours)),
    manufacturingHours: String(Math.max(1, manufacturingHours))
  };
}

function sanitizeModelOutput(value) {
  return String(value || '')
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim();
}

function normalizeNumericHours(value, fallback, minimum = 1) {
  const numeric =
    typeof value === 'number'
      ? value
      : Number.parseInt(String(value || '').replace(/[^\d]/g, ''), 10);

  if (!Number.isFinite(numeric)) {
    return String(fallback);
  }

  return String(Math.max(minimum, Math.round(numeric)));
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

  const result = await response.json();
  if (!response.ok) {
    throw new Error(`Gemini ${response.status}: ${result?.error?.message || 'errore sconosciuto'}`);
  }

  const text = sanitizeModelOutput(
    (result?.candidates?.[0]?.content?.parts || [])
      .map((part) => part.text || '')
      .join('\n')
  );

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON Gemini non valido: ${text.slice(0, 300)}`);
  }
}

function buildGenerationPrompt(product, plainDescription, explicitFacts) {
  const categories = (product.categories || []).map((category) => category.name).filter(Boolean);

  return [
    'Scrivi in italiano e restituisci solo un oggetto JSON valido.',
    'Le chiavi devono essere esattamente: descriptionHtml, shortDescriptionHtml, designHtml, designerNoteHtml, designHours, manufacturingHours.',
    'descriptionHtml: descrizione e-commerce premium in HTML, con soli tag <p>, <strong>, <br>.',
    'shortDescriptionHtml: descrizione breve WooCommerce in HTML, con soli tag <p>, <strong>, <br>.',
    'designHtml: breve testo HTML per il campo "Design".',
    'designerNoteHtml: breve testo HTML per il campo "Note della designer", in prima persona.',
    'designHours: solo numero intero, mai sotto 30.',
    'manufacturingHours: solo numero intero, realistico, di solito tra 1 e 3.',
    `Titolo prodotto: ${product.name}.`,
    categories.length > 0 ? `Categorie prodotto: ${categories.join(', ')}.` : '',
    plainDescription ? `Descrizione attuale da usare come base fattuale: ${plainDescription}` : '',
    explicitFacts.length > 0 ? `Fatti espliciti da non contraddire: ${explicitFacts.join('; ')}.` : '',
    'Non inventare fatti tecnici non presenti nei dati forniti.',
    'Non inventare composizioni tessili specifiche se non sono esplicite.',
    'Non scrivere mai informazioni di prezzo.',
    'Non ripetere il titolo come heading o prima riga autonoma.',
    'Rivolgiti a chi compra il capo per un bambino: genitore, parente o amico di famiglia.',
    'Tono: caldo, raffinato, credibile, premium, mai enfatico in modo artificiale.',
    'Posiziona Farway come lusso intelligente, artigianale, etico e fatto in Italia a prezzo onesto.',
    'La descrizione lunga deve avere 3 paragrafi brevi o al massimo 4, leggibili.',
    'La descrizione breve deve avere un solo paragrafo breve, 2-4 frasi.',
    'Usa poche evidenziazioni in <strong> per guidare la lettura.',
    'Non aggiungere elenchi puntati.',
    'Non aggiungere tag, categorie o riepiloghi finali.',
    'Mantieni le maiuscole solo dove servono secondo l’italiano.'
  ]
    .filter(Boolean)
    .join(' ');
}

function collectExplicitFacts(product, plainDescription, inferred) {
  const facts = [];

  if (inferred.materials.length > 0) {
    facts.push(`materiali dedotti: ${inferred.materials.join(', ')}`);
  }
  if (inferred.composition) {
    facts.push(`composizione dedotta: ${inferred.composition}`);
  }
  if (inferred.gender) {
    facts.push(`genere dedotto: ${inferred.gender}`);
  }
  if (plainDescription) {
    const lines = plainDescription
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 4);
    if (lines.length > 0) {
      facts.push(`estratti testuali utili: ${lines.join(' | ')}`);
    }
  }

  return facts;
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

async function clickupRequest(env, endpoint, options = {}) {
  const response = await fetch(`https://api.clickup.com/api/v2${endpoint}`, {
    ...options,
    headers: {
      Authorization: env.CLICKUP_TOKEN,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`ClickUp ${response.status} ${endpoint}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
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

function buildUpdateMetaPayload(metaMap, values) {
  const payload = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (!Array.isArray(value) && String(value).trim() === '') continue;

    const existing = metaMap.get(key);
    if (existing && existing.id) {
      payload.push({ id: existing.id, key, value });
    } else {
      payload.push({ key, value });
    }
  }
  return payload;
}

async function createOrUpdateSubtask(env, listId, parentTaskId, assigneeUserId, product, notes) {
  const taskName = `[prodotto ${product.id}] ${product.name} - dati da verificare`;
  const tasks = await clickupRequest(env, `/list/${listId}/task?include_subtasks=true`);
  const existing = (tasks.tasks || []).find((task) => task.name === taskName);
  const description = [
    `Prodotto: ${product.name}`,
    `Backend: ${product.backendUrl}`,
    '',
    'Mancano o sono ambigui questi elementi:',
    ...notes.map((note) => `- ${note}`)
  ].join('\n');

  const body = {
    name: taskName,
    description,
    assignees: [assigneeUserId],
    status: 'backlog',
    parent: parentTaskId
  };

  if (existing) {
    await clickupRequest(env, `/task/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    await clickupRequest(env, `/task/${existing.id}/assignee/${assigneeUserId}`, {
      method: 'POST'
    });
    return { id: existing.id, created: false };
  }

  const created = await clickupRequest(env, `/list/${listId}/task`, {
    method: 'POST',
    body: JSON.stringify(body)
  });

  await clickupRequest(env, `/task/${created.id}/assignee/${assigneeUserId}`, {
    method: 'POST'
  });

  return { id: created.id, created: true };
}

function parseArgs(argv) {
  const args = {
    limit: 30,
    dryRun: false
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--limit=')) {
      args.limit = Number.parseInt(arg.split('=')[1], 10) || args.limit;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = readEnvFile(path.join(process.cwd(), '.env.local'));

  if (!env.WC_STORE_URL || !env.WC_CONSUMER_KEY || !env.WC_CONSUMER_SECRET) {
    throw new Error('Configurazione WooCommerce incompleta in .env.local');
  }

  if (!env.CLICKUP_TOKEN) {
    throw new Error('CLICKUP_TOKEN mancante in .env.local');
  }

  if (!env.GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new Error('GOOGLE_GENERATIVE_AI_API_KEY mancante in .env.local');
  }

  const products = await fetchPublishedProducts(env);
  const categoryResponse = await wcRequest(env, '/wp-json/wc/v3/products/categories?per_page=100');
  const categoryBySlug = new Map(categoryResponse.map((category) => [String(category.slug || '').toLowerCase(), category]));

  const selected = products
    .filter((product) => !hasModernDescriptions(product))
    .slice(0, args.limit)
    .map((product) => ({
      ...product,
      backendUrl: `${env.WC_STORE_URL.replace(/\/$/, '')}/wp-admin/post.php?post=${product.id}&action=edit`
    }));

  const listId = '901519228105';
  const parentTaskId = '86c8jfh8k';
  const agenteEcommerceUserId = 106622726;

  const results = [];

  for (const product of selected) {
    const metaMap = buildMetaMap(product.meta_data || []);
    const plainDescription = stripHtml(product.description || '');
    const originalTitle = product.name;
    const cleanedTitle = cleanTitleRemovingUnisex(originalTitle);
    const inferredComposition =
      String(getMetaValue(metaMap, 'fw_composizione_del_materiale_v2') || '').trim() ||
      inferComposition(plainDescription);
    const inferredMaterials = resolveMaterialSelection(
      product,
      plainDescription,
      inferredComposition,
      getMetaValue(metaMap, 'fw_materiale')
    );
    const inferredWash =
      String(getMetaValue(metaMap, 'fw_cura_e_istruzioni_di_lavaggio_v2') || '').trim() ||
      inferWash(inferredMaterials, inferredComposition, plainDescription);
    const inferredFit =
      String(getMetaValue(metaMap, 'fw_vestibilita_v2') || '').trim() ||
      inferFit(plainDescription, originalTitle);
    const genderDecision = inferGender(product, originalTitle, plainDescription);
    const targetOccasioni = inferOccasioniDuso(
      product,
      originalTitle,
      plainDescription,
      getMetaValue(metaMap, 'occasione_duso')
    );
    const targetTitle = cleanedTitle || originalTitle;
    const targetSlug =
      targetTitle !== originalTitle
        ? ensureUniqueSlug(targetTitle, product.id, products)
        : String(product.slug || '');
    const explicitFacts = collectExplicitFacts(product, plainDescription, {
      materials: inferredMaterials,
      composition: inferredComposition,
      gender: genderDecision.value
    });

    const generated = await callGeminiJson(
      env.GOOGLE_GENERATIVE_AI_API_KEY,
      buildGenerationPrompt(product, plainDescription, explicitFacts)
    );

    const fallbackAcf = buildFallbackAcf((product.categories || []).map((category) => category.name));
    const shouldRegenerateDescriptions = !hasModernDescriptions(product);
    const targetDescription = shouldRegenerateDescriptions
      ? sanitizeModelOutput(generated.descriptionHtml || '')
      : String(product.description || '');
    const targetShortDescription = shouldRegenerateDescriptions
      ? sanitizeModelOutput(generated.shortDescriptionHtml || '')
      : String(product.short_description || '');
    const targetDesign =
      hasMeaningfulText(getMetaValue(metaMap, 'fw_design'), 20)
        ? String(getMetaValue(metaMap, 'fw_design'))
        : sanitizeModelOutput(generated.designHtml || fallbackAcf.designHtml);
    const targetDesignerNote =
      hasMeaningfulText(getMetaValue(metaMap, 'fw_note_della_designer'), 20)
        ? String(getMetaValue(metaMap, 'fw_note_della_designer'))
        : sanitizeModelOutput(generated.designerNoteHtml || fallbackAcf.designerNoteHtml);
    const targetDesignHours =
      String(getMetaValue(metaMap, 'tempistica_di_progettazione') || '').trim() ||
      normalizeNumericHours(generated.designHours, Number(fallbackAcf.designHours), 30);
    const targetManufacturingHours =
      String(getMetaValue(metaMap, 'tempistica_di_fabbricazione') || '').trim() ||
      normalizeNumericHours(generated.manufacturingHours, Number(fallbackAcf.manufacturingHours), 1);

    const existingGenreCategories = (product.categories || []).filter((category) =>
      ['femmina', 'maschio', 'unisex'].includes(String(category.slug || '').toLowerCase())
    );
    const updatedCategories =
      existingGenreCategories.length === 0 && genderDecision.value && categoryBySlug.has(genderDecision.value)
        ? [
            ...(product.categories || []).map((category) => ({ id: category.id })),
            { id: categoryBySlug.get(genderDecision.value).id }
          ]
        : (product.categories || []).map((category) => ({ id: category.id }));

    const missingNotes = [];
    if (!genderDecision.value && existingGenreCategories.length === 0) {
      missingNotes.push('genere non determinabile con sufficiente certezza');
    }
    if (!inferredMaterials || inferredMaterials.length === 0) missingNotes.push('materiale da verificare');
    if (!inferredComposition) missingNotes.push('composizione del materiale da verificare');
    if (!inferredFit) missingNotes.push('vestibilita da verificare');
    if (!inferredWash) missingNotes.push('cura e istruzioni di lavaggio da verificare');
    if (!targetOccasioni || targetOccasioni.length < 3) missingNotes.push("occasioni d'uso da verificare");

    const metaUpdates = buildUpdateMetaPayload(metaMap, {
      fw_materiale: inferredMaterials,
      fw_composizione_del_materiale_v2: inferredComposition,
      fw_vestibilita_v2: inferredFit,
      fw_cura_e_istruzioni_di_lavaggio_v2: inferredWash,
      occasione_duso: targetOccasioni,
      fw_design: targetDesign,
      fw_note_della_designer: targetDesignerNote,
      tempistica_di_progettazione: targetDesignHours,
      tempistica_di_fabbricazione: targetManufacturingHours
    });

    const updatePayload = {
      name: targetTitle,
      slug: targetSlug,
      description: targetDescription,
      short_description: targetShortDescription,
      ...(updatedCategories.length > 0 ? { categories: updatedCategories } : {}),
      ...(metaUpdates.length > 0 ? { meta_data: metaUpdates } : {})
    };

    if (!args.dryRun) {
      await wcRequest(env, `/wp-json/wc/v3/products/${product.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatePayload)
      });
    }

    let taskResult = null;
    if (missingNotes.length > 0) {
      taskResult = args.dryRun
        ? { id: null, created: false }
        : await createOrUpdateSubtask(
            env,
            listId,
            parentTaskId,
            agenteEcommerceUserId,
            product,
            [
              ...missingNotes,
              ...(targetTitle !== originalTitle
                ? [`titolo ripulito da "unisex" e slug aggiornato in ${targetSlug}`]
                : [])
            ]
          );
    }

    results.push({
      id: product.id,
      originalTitle,
      targetTitle,
      originalSlug: product.slug,
      targetSlug,
      gender: genderDecision.value,
      missingNotes,
      taskId: taskResult ? taskResult.id : null,
      updated: !args.dryRun
    });
  }

  console.log(
    JSON.stringify(
      {
        dryRun: args.dryRun,
        selected: selected.length,
        updated: results.filter((result) => result.updated).length,
        withTasks: results.filter((result) => result.missingNotes.length > 0).length,
        results
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
