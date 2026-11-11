import { randomBytes } from "node:crypto";

import { buildCaptureBody, buildCreateOrderBody, type CreateOrderInput } from "@/lib/paypal-order";
import type { PayPalMode } from "@/lib/types";
import { GateError, PayPalRequestError } from "./errors";

export type CreatedOrder = {
  id: string;
  status: string;
  intent: "CAPTURE";
  approveUrl: string | null;
};

export type CapturedOrder = {
  orderId: string;
  orderStatus: string;
  captureId: string;
  captureStatus: string;
};

export interface PayPalClient {
  mode: PayPalMode;
  createOrder(input: CreateOrderInput): Promise<CreatedOrder>;
  getOrder(orderId: string): Promise<{ id: string; status: string; intent: string }>;
  captureOrder(orderId: string, requestId: string): Promise<CapturedOrder>;
}

type OrderJson = {
  id?: string;
  status?: string;
  intent?: string;
  links?: { rel?: string; href?: string }[];
  message?: string;
  name?: string;
  purchase_units?: {
    payments?: { captures?: { id?: string; status?: string }[] };
  }[];
};

export function resolvePayPalMode(env: Record<string, string | undefined>): PayPalMode {
  const forced = (env.PAYPAL_MODE || "auto").toLowerCase();
  const hasCredentials = Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
  if (forced === "mock") return "mock";
  if (forced === "sandbox") {
    if (!hasCredentials) {
      throw new GateError(
        "PAYPAL_NOT_CONFIGURED",
        500,
        "PAYPAL_MODE=sandbox but PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is missing.",
      );
    }
    return "sandbox";
  }
  return hasCredentials ? "sandbox" : "mock";
}

export function createPayPalClient(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): PayPalClient {
  const mode = resolvePayPalMode(env);
  if (mode === "mock") return createMockPayPal();
  return createSandboxPayPal(env, fetchImpl);
}

export function createMockPayPal(): PayPalClient & { calls: string[] } {
  const orders = new Map<string, { status: string; captureId?: string; captureStatus?: string }>();
  const calls: string[] = [];
  return {
    mode: "mock",
    calls,
    async createOrder() {
      calls.push("create");
      const id = `MOCK${randomBytes(4).toString("hex").toUpperCase()}`;
      orders.set(id, { status: "CREATED" });
      return { id, status: "CREATED", intent: "CAPTURE", approveUrl: null };
    },
    async getOrder(orderId: string) {
      calls.push("get");
      const order = orders.get(orderId);
      if (!order) throw new Error(`Unknown mock order ${orderId}`);
      return { id: orderId, status: order.status, intent: "CAPTURE" };
    },
    async captureOrder(orderId: string) {
      calls.push("capture");
      const order = orders.get(orderId);
      if (!order) throw new Error(`Unknown mock order ${orderId}`);
      if (!order.captureId) {
        order.status = "COMPLETED";
        order.captureId = `MOCKCAP${randomBytes(3).toString("hex").toUpperCase()}`;
        order.captureStatus = "COMPLETED";
      }
      return {
        orderId,
        orderStatus: order.status,
        captureId: order.captureId,
        captureStatus: order.captureStatus ?? "COMPLETED",
      };
    },
  };
}

export function createSandboxPayPal(env: Record<string, string | undefined>, fetchImpl: typeof fetch): PayPalClient {
  const base = (env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com").replace(/\/$/, "");
  let cached: { token: string; exp: number } | null = null;

  async function accessToken(): Promise<string> {
    if (cached && cached.exp > Date.now() + 5000) return cached.token;
    const id = env.PAYPAL_CLIENT_ID ?? "";
    const secret = env.PAYPAL_CLIENT_SECRET ?? "";
    const basic = Buffer.from(`${id}:${secret}`).toString("base64");
    const response = await fetchImpl(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const json = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!response.ok || !json.access_token) {
      throw new PayPalRequestError(response.status, json.error || "AUTH_FAILED", json.error_description || "PayPal did not return an access token.");
    }
    cached = { token: json.access_token, exp: Date.now() + (json.expires_in ?? 300) * 1000 };
    return json.access_token;
  }

  async function call(path: string, init: { method: string; body?: unknown; requestId?: string }): Promise<OrderJson> {
    const token = await accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (init.requestId) headers["PayPal-Request-Id"] = init.requestId;
    const response = await fetchImpl(`${base}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const json = (await response.json().catch(() => ({}))) as OrderJson;
    if (!response.ok) {
      throw new PayPalRequestError(response.status, json.name || "PAYPAL_ERROR", json.message || `PayPal returned HTTP ${response.status}.`);
    }
    return json;
  }

  return {
    mode: "sandbox",
    async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
      const json = await call("/v2/checkout/orders", {
        method: "POST",
        body: buildCreateOrderBody(input),
        requestId: input.requestId,
      });
      const approve = json.links?.find((link) => link.rel === "approve" || link.rel === "payer-action");
      return {
        id: json.id || "",
        status: json.status || "CREATED",
        intent: "CAPTURE",
        approveUrl: approve?.href ?? null,
      };
    },
    async getOrder(orderId: string) {
      const json = await call(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: "GET" });
      return { id: json.id || orderId, status: json.status || "UNKNOWN", intent: json.intent || "CAPTURE" };
    },
    async captureOrder(orderId: string, requestId: string): Promise<CapturedOrder> {
      const json = await call(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
        method: "POST",
        body: buildCaptureBody(env),
        requestId,
      });
      const capture = json.purchase_units?.[0]?.payments?.captures?.[0];
      return {
        orderId: json.id || orderId,
        orderStatus: json.status || "UNKNOWN",
        captureId: capture?.id || "",
        captureStatus: capture?.status || json.status || "UNKNOWN",
      };
    },
  };
}
