import { NextResponse } from "next/server";

import { asRecord, asString, gateResponse, readJson } from "@/server/http";
import { getService } from "@/server/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    return NextResponse.json(getService().get(id));
  } catch (error) {
    return gateResponse(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const body = asRecord(await readJson(request));
    const result = await getService().edit(id, {
      reviewerName: asString(body.reviewerName),
      payeeName: asString(body.payeeName),
      payeeEmail: asString(body.payeeEmail),
      amount: asString(body.amount),
      currency: asString(body.currency),
      purpose: asString(body.purpose),
      when: asString(body.when),
    });
    return NextResponse.json(result);
  } catch (error) {
    return gateResponse(error);
  }
}
