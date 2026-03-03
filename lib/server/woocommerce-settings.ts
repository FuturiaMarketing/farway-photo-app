import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

export type WooCommerceSettings = {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
};

const settingsDir = path.join(process.cwd(), 'data');
const settingsFile = path.join(settingsDir, 'woocommerce-settings.json');

export async function readWooCommerceSettings(): Promise<WooCommerceSettings | null> {
  try {
    const file = await readFile(settingsFile, 'utf8');
    const parsed = JSON.parse(file) as Partial<WooCommerceSettings>;

    if (!parsed.storeUrl || !parsed.consumerKey || !parsed.consumerSecret) {
      return null;
    }

    return {
      storeUrl: parsed.storeUrl,
      consumerKey: parsed.consumerKey,
      consumerSecret: parsed.consumerSecret,
    };
  } catch {
    return null;
  }
}

export async function writeWooCommerceSettings(settings: WooCommerceSettings) {
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
