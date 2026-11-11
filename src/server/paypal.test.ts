import { describe, expect, it, vi } from "vitest";

import { buildCaptureBody, buildCreateOrderBody } from "@/lib/paypal-order";
import { createSandboxPayPal } from "./paypal";

describe("PayPal Orders v2 client", () => {
  it("builds a CAPTURE order and does not capture in the create body", () => {
    const body = buildCreateOrderBody({
      caseId: "abp_123",
      version: 1,
      currency: "GBP",
      value: "150.00",
      description: "Plumber: Deposit to book a boiler service",
      requestId: "req_1",
    });
    expect(body.intent).toBe("CAPTURE");
    expect(body.purchase_units[0].amount).toEqual({ currency_code: "GBP", value: "150.00" });
    expect(JSON.stringify(body)).not.toContain("payment_source");
    expect(buildCaptureBody({})).toEqual({});
  });

  it("creates with POST /v2/checkout/orders and captures only when captureOrder is called", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method ?? "GET"} ${url}`);
      if (String(url).endsWith("/v1/oauth2/token")) {
        return json({ access_token: "tok_test", expires_in: 300 });
      }
      if (init?.method === "POST" && String(url).endsWith("/v2/checkout/orders")) {
        const body = JSON.parse(String(init.body));
        expect(body.intent).toBe("CAPTURE");
        return json({
          id: "ORDER123",
          status: "CREATED",
          intent: "CAPTURE",
          links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER123" }],
        });
      }
      if (String(url).endsWith("/v2/checkout/orders/ORDER123") && (init?.method ?? "GET") === "GET") {
        return json({ id: "ORDER123", status: "CREATED", intent: "CAPTURE" });
      }
      if (String(url).endsWith("/v2/checkout/orders/ORDER123/capture")) {
        return json({
          id: "ORDER123",
          status: "COMPLETED",
          purchase_units: [{ payments: { captures: [{ id: "CAP123", status: "COMPLETED" }] } }],
        });
      }
      throw new Error(`Unexpected ${init?.method} ${url}`);
    });

    const client = createSandboxPayPal(
      { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com" },
      fetchImpl as unknown as typeof fetch,
    );
    const created = await client.createOrder({
      caseId: "abp_123",
      version: 1,
      currency: "GBP",
      value: "150.00",
      description: "Plumber: Deposit",
      requestId: "req_1",
    });
    expect(created).toMatchObject({ id: "ORDER123", status: "CREATED", intent: "CAPTURE" });
    expect(urls.some((entry) => entry.includes("/v2/checkout/orders/") && entry.includes("/capture"))).toBe(false);

    const captured = await client.captureOrder("ORDER123", "req_2");
    expect(captured.captureId).toBe("CAP123");
    expect(urls.some((entry) => entry === "POST https://api-m.sandbox.paypal.com/v2/checkout/orders")).toBe(true);
    expect(urls.some((entry) => entry === "POST https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER123/capture")).toBe(true);
  });
});

function json(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}
