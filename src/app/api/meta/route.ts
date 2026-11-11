import { NextResponse } from "next/server";

import { gateResponse } from "@/server/http";
import { getService } from "@/server/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(getService().meta());
  } catch (error) {
    return gateResponse(error);
  }
}
