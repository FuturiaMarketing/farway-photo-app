import fs from 'fs';
import path from 'path';
import { hasDatabaseConnection, readJsonValue, writeJsonValue } from '@/lib/server/db';

// Confirmed decisions persist in Postgres (works on Vercel; survives serverless) under
// app_key_value namespace 'photo_matches', key 'decisions' -> Record<file, Decision>.
// Local dev without DATABASE_URL falls back to data/reconcile/decisions.json.
const NS = 'photo_matches';
const KEY = 'decisions';

export const STILL_LIFE_DIR =
  process.env.STILL_LIFE_DIR ||
  'D:\\GoogleDrive\\Futuria at work\\Clienti e progetti\\Farway Milano\\Website\\Sito Next\\Foto still life sfondo chiaro';

const LOCAL_PATH = path.join(process.cwd(), 'data', 'reconcile', 'decisions.json');

export type Decision = {
  file: string;
  status: 'confirmed' | 'bucket' | 'multi' | 'skip';
  productId: number | null;
  productName: string;
  sku?: string;
  colorway: string | null;
  view: string;
  note?: string;
  updatedAt: string;
};
export type DecisionMap = Record<string, Decision>;

export async function readDecisions(): Promise<DecisionMap> {
  if (hasDatabaseConnection()) {
    const v = await readJsonValue<DecisionMap>(NS, KEY);
    return v && typeof v === 'object' ? v : {};
  }
  try {
    return JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8')) as DecisionMap;
  } catch {
    return {};
  }
}

async function writeDecisions(all: DecisionMap): Promise<void> {
  if (hasDatabaseConnection()) {
    await writeJsonValue(NS, KEY, all);
    return;
  }
  fs.mkdirSync(path.dirname(LOCAL_PATH), { recursive: true });
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(all, null, 2));
}

export async function upsertDecision(d: Decision): Promise<DecisionMap> {
  const all = await readDecisions();
  all[d.file] = d;
  await writeDecisions(all);
  return all;
}

export async function removeDecision(file: string): Promise<DecisionMap> {
  const all = await readDecisions();
  delete all[file];
  await writeDecisions(all);
  return all;
}
