import { NextResponse } from 'next/server';
import { readDecisions } from '@/lib/server/reconcile-store';
import { buildTargetName } from '@/lib/reconcile-naming';

export const runtime = 'nodejs';

// Confirmed manifest for the rename step: each decision + its (base, pre-suffix) target name.
export async function GET() {
  const decisions = Object.values(await readDecisions());
  const rows = decisions.map((d) => ({
    ...d,
    targetName:
      d.status === 'confirmed'
        ? buildTargetName({ productName: d.productName, colorway: d.colorway, view: d.view })
        : null,
  }));
  const body = JSON.stringify({ generatedAt: new Date().toISOString(), count: rows.length, decisions: rows }, null, 2);
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="confirmed-manifest.json"',
    },
  });
}
