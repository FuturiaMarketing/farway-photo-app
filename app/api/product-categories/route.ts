import { NextResponse } from 'next/server';
import { getResolvedWooCommerceSettings } from '@/lib/server/woocommerce-settings';

type WooProductCategory = {
  id: number;
  name: string;
  slug?: string;
  parent?: number;
};

function decodeHtmlEntities(value: string) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

export async function GET() {
  try {
    const settings = await getResolvedWooCommerceSettings();

    if (!settings) {
      return NextResponse.json(
        { error: 'Configurazione WooCommerce mancante. Salvala da Impostazioni WooCommerce.' },
        { status: 500 }
      );
    }

    const cleanUrl = settings.storeUrl.replace(/\/$/, '');
    const authQuery = `consumer_key=${settings.consumerKey}&consumer_secret=${settings.consumerSecret}`;
    const perPage = 100;
    let page = 1;
    const categories: WooProductCategory[] = [];

    while (true) {
      const endpoint = `${cleanUrl}/wp-json/wc/v3/products/categories?per_page=${perPage}&page=${page}&${authQuery}`;
      const response = await fetch(endpoint, { next: { revalidate: 60 } });

      if (!response.ok) {
        return NextResponse.json(
          { error: `Errore WooCommerce categorie: ${response.status}` },
          { status: response.status }
        );
      }

      const pageCategories = (await response.json()) as WooProductCategory[];
      categories.push(...pageCategories);

      if (pageCategories.length < perPage) {
        break;
      }

      page += 1;
    }

    const normalized = categories
      .map((category) => ({
        id: category.id,
        name: decodeHtmlEntities(category.name || ''),
        slug: String(category.slug || ''),
        parent: Number(category.parent || 0),
      }))
      .filter((category) => category.id > 0 && category.name.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));

    return NextResponse.json(normalized);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Errore sconosciuto';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
