import { NextResponse } from "next/server";

import { asRecord, asString, gateResponse, readJson } from "@/server/http";
import { getService } from "@/server/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(getService().list());
  } catch (error) {
    return gateResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = asRecord(await readJson(request));
    const result = await getService().createFromText(asString(body.text));
    return NextResponse.json(result);
  } catch (error) {
    return gateResponse(error);
  }
}

export async function DELETE() {
  try {
    return NextResponse.json(getService().clear());
  } catch (error) {
    return gateResponse(error);
  }
}
