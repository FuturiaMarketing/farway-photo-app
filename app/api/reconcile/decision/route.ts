import { NextResponse } from 'next/server';
import { readDecisions, upsertDecision, removeDecision, type Decision } from '@/lib/server/reconcile-store';

export const runtime = 'nodejs';

function counts(decisions: Record<string, Decision>) {
  const dec = Object.values(decisions);
  return {
    decided: dec.length,
    confirmed: dec.filter((d) => d.status === 'confirmed').length,
    bucket: dec.filter((d) => d.status === 'bucket').length,
    multi: dec.filter((d) => d.status === 'multi').length,
    skip: dec.filter((d) => d.status === 'skip').length,
  };
}

export async function GET() {
  try {
    const decisions = await readDecisions();
    return NextResponse.json({ decisions, counts: counts(decisions) });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Errore' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<Decision>;
    const file = String(body.file || '').trim();
    const status = String(body.status || '').trim() as Decision['status'];
    if (!file) return NextResponse.json({ error: 'file obbligatorio' }, { status: 400 });
    if (!['confirmed', 'bucket', 'multi', 'skip'].includes(status)) {
      return NextResponse.json({ error: 'status non valido' }, { status: 400 });
    }
    const decision: Decision = {
      file,
      status,
      productId: typeof body.productId === 'number' ? body.productId : null,
      productName: String(body.productName || '').trim(),
      sku: body.sku ? String(body.sku) : undefined,
      colorway: body.colorway ? String(body.colorway) : null,
      view: String(body.view || '').trim(),
      note: body.note ? String(body.note) : undefined,
      updatedAt: new Date().toISOString(),
    };
    const decisions = await upsertDecision(decision);
    return NextResponse.json({ success: true, decisions, counts: counts(decisions) });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Errore' }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const file = String(searchParams.get('file') || '').trim();
    if (!file) return NextResponse.json({ error: 'file obbligatorio' }, { status: 400 });
    const decisions = await removeDecision(file);
    return NextResponse.json({ success: true, decisions, counts: counts(decisions) });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Errore' }, { status: 500 });
  }
}
