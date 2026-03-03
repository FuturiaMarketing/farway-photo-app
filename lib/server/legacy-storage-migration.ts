import { access, readFile, readdir } from 'fs/promises';
import path from 'path';
import {
  hasDatabaseConnection,
  readJsonValue,
  writeBinaryAsset,
  writeJsonValue,
} from '@/lib/server/db';

const imageExtensions = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);

let migrationPromise: Promise<void> | null = null;

async function pathExists(targetPath: string) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

async function migrateDirectory(namespace: string, rootDir: string) {
  if (!(await pathExists(rootDir))) {
    return 0;
  }

  const files = await collectFiles(rootDir);
  let migratedCount = 0;

  for (const filePath of files) {
    const extension = path.extname(filePath).toLowerCase();
    const mimeType = imageExtensions.get(extension);

    if (!mimeType) {
      continue;
    }

    const relativePath = path.relative(rootDir, filePath).split(path.sep).join('/');
    const bytes = await readFile(filePath);

    await writeBinaryAsset({
      namespace,
      key: `legacy::${relativePath}`,
      mimeType,
      bytes,
      metadata: {
        legacyPath: relativePath,
        migratedFrom: rootDir,
      },
    });

    migratedCount += 1;
  }

  return migratedCount;
}

async function runLegacyMigration() {
  if (!hasDatabaseConnection()) {
    return;
  }

  const existingFlag = await readJsonValue<{ done?: boolean }>('migrations', 'legacy_local_assets_v1');

  if (existingFlag?.done) {
    return;
  }

  const savedProjectsCount = await migrateDirectory(
    'saved-projects',
    path.join(process.cwd(), 'saved-projects')
  );
  const wooSyncCount = await migrateDirectory(
    'woo-sync',
    path.join(process.cwd(), 'public', 'woo-sync')
  );

  await writeJsonValue('migrations', 'legacy_local_assets_v1', {
    done: true,
    savedProjectsCount,
    wooSyncCount,
    migratedAt: new Date().toISOString(),
  });
}

export async function ensureLegacyLocalDataMigrated() {
  if (!hasDatabaseConnection()) {
    return;
  }

  if (!migrationPromise) {
    migrationPromise = runLegacyMigration().catch((error) => {
      console.error('Errore migrazione storage legacy verso DB:', error);
    });
  }

  await migrationPromise;
}
