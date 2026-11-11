import { NextResponse } from "next/server";

import { asRecord, asString, asStringList, gateResponse, readJson } from "@/server/http";
import { getService } from "@/server/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const body = asRecord(await readJson(request));
    const result = getService().approve(id, {
      reviewerName: asString(body.reviewerName),
      note: asString(body.note),
      acknowledgedRiskCodes: asStringList(body.acknowledgedRiskCodes),
    });
    return NextResponse.json(result);
  } catch (error) {
    return gateResponse(error);
  }
}
