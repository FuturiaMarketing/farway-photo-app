import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { hasDatabaseConnection, readJsonValue, writeJsonValue } from '@/lib/server/db';

export type WooCommerceSettings = {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
};

const settingsDir = path.join(process.cwd(), 'data');
const settingsFile = path.join(settingsDir, 'woocommerce-settings.json');
const settingsNamespace = 'settings';
const settingsKey = 'woocommerce';

export async function readWooCommerceSettings(): Promise<WooCommerceSettings | null> {
  if (hasDatabaseConnection()) {
    const storedValue = await readJsonValue<Partial<WooCommerceSettings>>(settingsNamespace, settingsKey);

    if (
      storedValue?.storeUrl &&
      storedValue.consumerKey &&
      storedValue.consumerSecret
    ) {
      return {
        storeUrl: storedValue.storeUrl,
        consumerKey: storedValue.consumerKey,
        consumerSecret: storedValue.consumerSecret,
      };
    }
  }

  try {
    const file = await readFile(settingsFile, 'utf8');
    const parsed = JSON.parse(file) as Partial<WooCommerceSettings>;

    if (!parsed.storeUrl || !parsed.consumerKey || !parsed.consumerSecret) {
      return null;
    }

    const resolvedSettings = {
      storeUrl: parsed.storeUrl,
      consumerKey: parsed.consumerKey,
      consumerSecret: parsed.consumerSecret,
    };

    if (hasDatabaseConnection()) {
      await writeJsonValue(settingsNamespace, settingsKey, resolvedSettings);
    }

    return resolvedSettings;
  } catch {
    return null;
  }
}

export async function writeWooCommerceSettings(settings: WooCommerceSettings) {
  if (hasDatabaseConnection()) {
    await writeJsonValue(settingsNamespace, settingsKey, settings);
    return;
  }

  await mkdir(settingsDir, { recursive: true });
  await writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
}

export async function getResolvedWooCommerceSettings(): Promise<WooCommerceSettings | null> {
  const storedSettings = await readWooCommerceSettings();

  if (storedSettings) {
    return storedSettings;
  }

  const storeUrl = process.env.WC_STORE_URL;
  const consumerKey = process.env.WC_CONSUMER_KEY;
  const consumerSecret = process.env.WC_CONSUMER_SECRET;

  if (!storeUrl || !consumerKey || !consumerSecret) {
    return null;
  }

  return {
    storeUrl,
    consumerKey,
    consumerSecret,
  };
}
