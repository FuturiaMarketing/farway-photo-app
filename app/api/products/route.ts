import { NextResponse } from 'next/server';
import {
  getAcfFieldsForProduct,
  normalizeAcfValue,
  type AcfFieldDefinition,
} from '@/lib/server/acf-fields';
import { ensureLegacyLocalDataMigrated } from '@/lib/server/legacy-storage-migration';
import { getResolvedWooCommerceSettings } from '@/lib/server/woocommerce-settings';

type WooCommerceAttribute = {
  name: string;
  options: string[];
};

type WooCommerceImage = {
  src: string;
};

type WooCommerceCategory = {
  id: number;
  name: string;
  slug?: string;
  parent?: number;
};

type WooCommerceCategoryTerm = {
  id: number;
  name: string;
  slug?: string;
  parent: number;
};

type WooCommerceProduct = {
  id: number;
  name: string;
  permalink?: string;
  description?: string;
  short_description?: string;
  images: WooCommerceImage[];
  attributes?: WooCommerceAttribute[];
  sku?: string;
  categories: WooCommerceCategory[];
  meta_data?: Array<{
    key?: string;
    value?: unknown;
  }>;
};

export async function GET(req: Request) {
  try {
    await ensureLegacyLocalDataMigrated();

    const url = new URL(req.url);
    const forceFresh = url.searchParams.get('fresh') === '1';
    const settings = await getResolvedWooCommerceSettings();

    if (!settings) {
      return NextResponse.json(
        { error: 'Configurazione WooCommerce mancante. Salvala da Impostazioni WooCommerce.' },
        { status: 500 }
      );
    }

    const cleanUrl = settings.storeUrl.replace(/\/$/, '');
    const authQuery = `consumer_key=${settings.consumerKey}&consumer_secret=${settings.consumerSecret}`;
    const categoriesEndpoint = `${cleanUrl}/wp-json/wc/v3/products/categories?per_page=100&${authQuery}`;

    const fetchOptions = forceFresh ? { cache: 'no-store' as const } : { next: { revalidate: 10 } };

    const categoriesRes = await fetch(categoriesEndpoint, fetchOptions);

    if (!categoriesRes.ok) {
      return NextResponse.json(
        { error: `Errore WooCommerce categorie: ${categoriesRes.status}` },
        { status: categoriesRes.status }
      );
    }

    const decodeHtmlEntities = (value: string) =>
      value
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ');

    const products: WooCommerceProduct[] = [];
    let page = 1;

    while (true) {
      const productsEndpoint = `${cleanUrl}/wp-json/wc/v3/products?per_page=100&page=${page}&${authQuery}`;
      const productsRes = await fetch(productsEndpoint, fetchOptions);

      if (!productsRes.ok) {
        return NextResponse.json(
          { error: `Errore WooCommerce prodotti: ${productsRes.status}` },
          { status: productsRes.status }
        );
      }

      const pageProducts = (await productsRes.json()) as WooCommerceProduct[];
      products.push(...pageProducts);

      if (pageProducts.length < 100) {
        break;
      }

      page += 1;
    }

    const categoryTerms = (await categoriesRes.json()) as WooCommerceCategoryTerm[];
    const categoryTermsById = new Map(
      categoryTerms.map((category) => [
        category.id,
        {
          ...category,
          name: decodeHtmlEntities(category.name),
        },
      ])
    );

    const formattedProducts = await Promise.all(products.map(async (product) => {
      let colors: string[] = [];
      let sizes: string[] = [];

      if (product.attributes) {
        const colorAttr = product.attributes.find((attribute) =>
          attribute.name.toLowerCase().includes('color')
        );
        const sizeAttr = product.attributes.find(
          (attribute) =>
            attribute.name.toLowerCase().includes('taglia') ||
            attribute.name.toLowerCase().includes('size')
        );
        if (colorAttr) colors = colorAttr.options;
        if (sizeAttr) sizes = sizeAttr.options;
      }

      if (colors.length === 0) {
        colors = ['Unico'];
      }

      const uniqueImages = Array.from(
        new Set(product.images.map((image) => image.src).filter(Boolean))
      );

      const resolvedCategories = product.categories.map((category) => {
        const categoryMeta = categoryTermsById.get(category.id);
        const resolvedName = decodeHtmlEntities(categoryMeta?.name || category.name);
        const parentId = categoryMeta?.parent || 0;
        const parentName = parentId
          ? categoryTermsById.get(parentId)?.name || null
          : null;
        const lineageIds: number[] = [category.id];
        let topLevelParentId = category.id;
        let topLevelParentName = resolvedName;
        let level = 0;
        let currentParentId = parentId;

        while (currentParentId) {
          lineageIds.push(currentParentId);
          level += 1;

          const parentCategory = categoryTermsById.get(currentParentId);

          if (!parentCategory) {
            break;
          }

          topLevelParentId = parentCategory.parent ? topLevelParentId : parentCategory.id;
          topLevelParentName = parentCategory.parent ? topLevelParentName : parentCategory.name;
          currentParentId = parentCategory.parent;
        }

        if (parentId && level >= 1) {
          let walkerId = parentId;

          while (walkerId) {
            const walkerCategory = categoryTermsById.get(walkerId);

            if (!walkerCategory) {
              break;
            }

            topLevelParentId = walkerCategory.id;
            topLevelParentName = walkerCategory.name;

            if (!walkerCategory.parent) {
              break;
            }

            walkerId = walkerCategory.parent;
          }
        }

        return {
          id: category.id,
          name: resolvedName,
          slug: categoryMeta?.slug || category.slug || '',
          parentId,
          parentName,
          topLevelParentId,
          topLevelParentName,
          level,
          lineageIds,
        };
      });

      const acfFields = await getAcfFieldsForProduct({
        postType: 'product',
        categories: resolvedCategories,
      });
      const acfValues = buildAcfValues(product.meta_data || [], acfFields);

      return {
        id: product.id,
        name: product.name,
        images: uniqueImages,
        image: uniqueImages[0] || '',
        colors: colors,
        sizes: sizes,
        sku: product.sku,
        description: product.description || product.short_description || '',
        frontendUrl: product.permalink || '',
        backendUrl: `${cleanUrl}/wp-admin/post.php?post=${product.id}&action=edit`,
        categories: resolvedCategories,
        acfFields,
        acfValues,
      };
    }));

    return NextResponse.json(formattedProducts);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Errore sconosciuto';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function buildAcfValues(
  metaData: NonNullable<WooCommerceProduct['meta_data']>,
  fields: AcfFieldDefinition[]
) {
  const metaMap = new Map(
    metaData
      .filter((meta) => meta.key && !String(meta.key).startsWith('_'))
      .map((meta) => [String(meta.key), meta.value])
  );

  return Object.fromEntries(
    fields
      .map((field) => {
        const normalizedValue = normalizeAcfValue(field, metaMap.get(field.name));
        return normalizedValue === null ? null : [field.name, normalizedValue];
      })
      .filter(
        (entry): entry is [string, string | string[]] =>
          Boolean(entry)
      )
  );
}
