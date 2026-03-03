import { NextResponse } from 'next/server';
import {
  getResolvedWooCommerceSettings,
  writeWooCommerceSettings,
  type WooCommerceSettings,
} from '@/lib/server/woocommerce-settings';

export async function GET() {
  try {
    const settings = await getResolvedWooCommerceSettings();

    if (!settings) {
      return NextResponse.json(
        { error: 'Configurazione WooCommerce non trovata.' },
        { status: 404 }
      );
    }

    return NextResponse.json(settings);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Errore sconosciuto';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<WooCommerceSettings>;
    const storeUrl = body.storeUrl?.trim();
    const consumerKey = body.consumerKey?.trim();
    const consumerSecret = body.consumerSecret?.trim();

    if (!storeUrl || !consumerKey || !consumerSecret) {
      return NextResponse.json(
        { error: 'Store URL, consumer key e consumer secret sono obbligatori.' },
        { status: 400 }
      );
    }

    await writeWooCommerceSettings({
      storeUrl,
      consumerKey,
      consumerSecret,
    });

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Errore sconosciuto';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
