import { NextResponse } from 'next/server';
import {
  buildFarwayErpLegendsCsv,
  buildFarwayErpLegendsPack,
  saveFarwayErpLegendDecision,
} from '@/lib/server/farway-erp-legends-review';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const pack = await buildFarwayErpLegendsPack();

    if (url.searchParams.get('format') === 'csv') {
      return new Response(await buildFarwayErpLegendsCsv(pack), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="farway-erp-legends-decisions.csv"',
        },
      });
    }

    return NextResponse.json(pack);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Errore sconosciuto';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const decision = await saveFarwayErpLegendDecision(body);
    return NextResponse.json({ success: true, decision });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Errore sconosciuto';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
