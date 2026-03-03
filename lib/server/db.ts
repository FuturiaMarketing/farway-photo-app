import { Pool } from 'pg';

type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

let pool: Pool | null = null;
let schemaReady = false;

export type StoredBinaryAsset = {
  id: string;
  mimeType: string;
  bytes: Buffer;
  metadata: Record<string, unknown>;
};

export function hasDatabaseConnection() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL non configurata.');
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
  }

  return pool;
}

export async function ensureDatabaseSchema() {
  if (!hasDatabaseConnection() || schemaReady) {
    return;
  }

  const activePool = getPool();

  await activePool.query(`
    CREATE TABLE IF NOT EXISTS app_key_value (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (namespace, key)
    )
  `);

  await activePool.query(`
    CREATE TABLE IF NOT EXISTS app_binary_assets (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      bytes BYTEA NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (namespace, key)
    )
  `);

  schemaReady = true;
}

export async function readJsonValue<T extends JsonValue>(
  namespace: string,
  key: string
): Promise<T | null> {
  if (!hasDatabaseConnection()) {
    return null;
  }

  await ensureDatabaseSchema();

  const activePool = getPool();
  const result = await activePool.query<{ value: T }>(
    'SELECT value FROM app_key_value WHERE namespace = $1 AND key = $2 LIMIT 1',
    [namespace, key]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return result.rows[0]?.value ?? null;
}

export async function writeJsonValue(
  namespace: string,
  key: string,
  value: JsonValue
) {
  if (!hasDatabaseConnection()) {
    throw new Error('DATABASE_URL non configurata.');
  }

  await ensureDatabaseSchema();

  const activePool = getPool();
  await activePool.query(
    `
      INSERT INTO app_key_value (namespace, key, value, updated_at)
      VALUES ($1, $2, $3::jsonb, NOW())
      ON CONFLICT (namespace, key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [namespace, key, JSON.stringify(value)]
  );
}

type WriteBinaryAssetInput = {
  namespace: string;
  key: string;
  mimeType: string;
  bytes: Buffer;
  metadata?: Record<string, unknown>;
};

export async function writeBinaryAsset(input: WriteBinaryAssetInput) {
  if (!hasDatabaseConnection()) {
    throw new Error('DATABASE_URL non configurata.');
  }

  await ensureDatabaseSchema();

  const activePool = getPool();
  const assetId = `${input.namespace}_${input.key}`
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 180) || 'asset';

  const result = await activePool.query<{ id: string }>(
    `
      INSERT INTO app_binary_assets (id, namespace, key, mime_type, bytes, metadata, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
      ON CONFLICT (namespace, key)
      DO UPDATE SET
        mime_type = EXCLUDED.mime_type,
        bytes = EXCLUDED.bytes,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING id
    `,
    [
      assetId,
      input.namespace,
      input.key,
      input.mimeType,
      input.bytes,
      JSON.stringify(input.metadata || {}),
    ]
  );

  return result.rows[0]?.id || assetId;
}

export async function readBinaryAssetById(assetId: string): Promise<StoredBinaryAsset | null> {
  if (!hasDatabaseConnection()) {
    return null;
  }

  await ensureDatabaseSchema();

  const activePool = getPool();
  const result = await activePool.query<{
    id: string;
    mime_type: string;
    bytes: Buffer;
    metadata: Record<string, unknown> | null;
  }>(
    `
      SELECT id, mime_type, bytes, metadata
      FROM app_binary_assets
      WHERE id = $1
      LIMIT 1
    `,
    [assetId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];

  return {
    id: row.id,
    mimeType: row.mime_type,
    bytes: row.bytes,
    metadata: row.metadata || {},
  };
}
