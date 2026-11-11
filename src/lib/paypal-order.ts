import type { Currency, Proposal } from "./types";

export type CreateOrderInput = {
  caseId: string;
  version: number;
  currency: Currency;
  value: string;
  description: string;
  requestId: string;
};

export function orderDescription(proposal: Proposal): string {
  const raw = `${proposal.payeeName}: ${proposal.purpose}`;
  return raw.length <= 127 ? raw : raw.slice(0, 127);
}

export function buildCreateOrderBody(input: CreateOrderInput) {
  const invoice = `${input.caseId}v${input.version}`.replace(/[^A-Za-z0-9]/g, "").slice(0, 127);
  return {
    intent: "CAPTURE" as const,
    purchase_units: [
      {
        reference_id: "default",
        description: input.description,
        custom_id: input.caseId.slice(0, 127),
        invoice_id: invoice,
        soft_descriptor: "APPROVEBEFOREPAY",
        amount: {
          currency_code: input.currency,
          value: input.value,
        },
      },
    ],
  };
}

export function buildCaptureBody(env: Record<string, string | undefined>): Record<string, unknown> {
  if (env.PAYPAL_CAPTURE_WITH_TEST_CARD !== "true") return {};
  const number = env.PAYPAL_TEST_CARD_NUMBER?.trim();
  if (!number) {
    throw new Error("PAYPAL_CAPTURE_WITH_TEST_CARD is true but PAYPAL_TEST_CARD_NUMBER is empty.");
  }
  return {
    payment_source: {
      card: {
        number,
        expiry: env.PAYPAL_TEST_CARD_EXPIRY || "2030-12",
        security_code: env.PAYPAL_TEST_CARD_CVV || "123",
        name: env.PAYPAL_TEST_CARD_NAME || "Test Buyer",
        billing_address: {
          address_line_1: "10 High Street",
          admin_area_2: "London",
          postal_code: "SW1A 1AA",
          country_code: "GB",
        },
      },
    },
  };
}
