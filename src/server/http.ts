import { NextResponse } from "next/server";

import { GateError } from "./errors";

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new GateError("BAD_JSON", 400, "The request body is not JSON.");
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function gateResponse(error: unknown) {
  if (error instanceof GateError) {
    return NextResponse.json(
      {
        error: { code: error.code, message: error.message },
        ...(error.extra ?? {}),
      },
      { status: error.status },
    );
  }
  console.error(error);
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "The server could not finish that step." } },
    { status: 500 },
  );
}
