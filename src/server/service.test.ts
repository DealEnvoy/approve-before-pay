import { beforeEach, describe, expect, it } from "vitest";

import { SAMPLES } from "@/lib/samples";
import type { KnownPayee } from "@/lib/types";
import type { Agent } from "./llm";
import { createMockPayPal } from "./paypal";
import { MemoryStore } from "./store";
import { assertCaptureAllowed, createService, type Service } from "./service";
import { GateError } from "./errors";

const KNOWN: KnownPayee[] = [
  { name: "Harbour Plumbing", email: "accounts@harbourplumbing.example" },
  { name: "Northline Electric", email: "billing@northline.example" },
];

const PLUMBER = SAMPLES[0].text;

function setup() {
  const paypal = createMockPayPal();
  const service = createService({
    store: new MemoryStore(),
    paypal,
    knownPayees: KNOWN,
    agent: undefined,
  });
  return { service, paypal };
}

describe("approval gate", () => {
  let service: Service;
  let paypal: ReturnType<typeof createMockPayPal>;

  beforeEach(() => {
    const next = setup();
    service = next.service;
    paypal = next.paypal;
  });

  it("prepares an order and refuses capture until a person approves", async () => {
    const created = await service.createFromText(PLUMBER);
    expect(created.record.status).toBe("proposed");
    expect(created.record.proposal.amount).toBe("150.00");
    expect(created.record.proposal.currency).toBe("GBP");
    expect(created.record.proposal.payeeName).toBe("Plumber");
    expect(created.record.proposal.when).toBe("next Tuesday");
    expect(created.record.paypal.intent).toBe("CAPTURE");
    expect(created.record.paypal.orderId?.startsWith("MOCK")).toBe(true);
    expect(created.record.paypal.captureId).toBeNull();
    expect(paypal.calls).toEqual(["create", "get"]);
    expect(created.record.evidence.find((item) => item.field === "amount")?.verified).toBe(true);
    expect(created.record.risks.map((flag) => flag.code)).toEqual(
      expect.arrayContaining(["NEW_PAYEE", "MISSING_PAYEE_EMAIL"]),
    );

    await expect(service.capture(created.record.id, "")).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
      status: 403,
    });
    expect(paypal.calls).toEqual(["create", "get"]);
    const refused = service.get(created.record.id);
    expect(refused.record.status).toBe("proposed");
    expect(refused.audits.some((event) => event.type === "capture_refused")).toBe(true);
    expect(refused.audits.find((event) => event.type === "capture_refused")?.message).toContain("not called");

    expect(() =>
      service.approve(created.record.id, {
        reviewerName: "Isaac Adekunle",
        note: "Checked the amount and the quoted words.",
        acknowledgedRiskCodes: [],
      }),
    ).toThrow(expect.objectContaining({ code: "RISKS_NOT_ACKNOWLEDGED", status: 400 }));
    expect(service.get(created.record.id).record.status).toBe("proposed");

    const approved = service.approve(created.record.id, {
      reviewerName: "Isaac Adekunle",
      note: "Checked the amount and the quoted words.",
      acknowledgedRiskCodes: ["NEW_PAYEE", "MISSING_PAYEE_EMAIL"],
    });
    expect(approved.record.status).toBe("approved");
    expect(paypal.calls.filter((call) => call === "capture")).toHaveLength(0);

    const captured = await service.capture(created.record.id, "Isaac Adekunle");
    expect(captured.record.status).toBe("captured");
    expect(captured.record.paypal.captureId?.startsWith("MOCKCAP")).toBe(true);
    expect(captured.record.paypal.captureStatus).toBe("COMPLETED");
    expect(captured.audits.some((event) => event.type === "paypal_capture_completed" && event.message.includes("No live PayPal charge"))).toBe(true);
    expect(paypal.calls.filter((call) => call === "capture")).toHaveLength(1);

    await expect(service.capture(created.record.id, "Isaac Adekunle")).rejects.toMatchObject({
      code: "ALREADY_CAPTURED",
    });
    expect(paypal.calls.filter((call) => call === "capture")).toHaveLength(1);
  });

  it("refuses capture after rejection and after an edit clears approval", async () => {
    const created = await service.createFromText(PLUMBER);
    const approved = service.approve(created.record.id, {
      reviewerName: "Isaac Adekunle",
      note: "Checked the amount and the quoted words.",
      acknowledgedRiskCodes: ["NEW_PAYEE", "MISSING_PAYEE_EMAIL"],
    });
    expect(approved.record.status).toBe("approved");

    const edited = await service.edit(created.record.id, {
      reviewerName: "Isaac Adekunle",
      payeeName: "Harbour Plumbing",
      payeeEmail: "accounts@harbourplumbing.example",
      amount: "150.00",
      currency: "GBP",
      purpose: "Deposit to book a boiler service",
      when: "next Tuesday",
    });
    expect(edited.record.status).toBe("proposed");
    expect(edited.record.version).toBe(2);
    expect(edited.record.approval).toBeNull();
    expect(edited.record.paypal.previousOrderIds).toHaveLength(1);
    await expect(service.capture(created.record.id, "Isaac Adekunle")).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
    });
    expect(paypal.calls.filter((call) => call === "capture")).toHaveLength(0);

    service.approve(created.record.id, {
      reviewerName: "Isaac Adekunle",
      note: "Payee now matches the known list.",
      acknowledgedRiskCodes: edited.record.risks.filter((flag) => flag.severity !== "info").map((flag) => flag.code),
    });
    const rejected = service.reject(created.record.id, {
      reviewerName: "Isaac Adekunle",
      reason: "The customer asked to hold the booking.",
    });
    expect(rejected.record.status).toBe("rejected");
    await expect(service.capture(created.record.id, "Isaac Adekunle")).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
    });
    expect(paypal.calls.filter((call) => call === "capture")).toHaveLength(0);
  });

  it("flags a second amount and does not create an order when no amount is present", async () => {
    const mixed = await service.createFromText(SAMPLES[1].text);
    expect(mixed.record.proposal.amount).toBe("800.00");
    expect(mixed.record.risks.some((flag) => flag.code === "MULTIPLE_AMOUNTS")).toBe(true);
    expect(mixed.record.risks.some((flag) => flag.code === "AMOUNT_MISMATCH")).toBe(false);

    const known = await service.createFromText(SAMPLES[2].text);
    expect(known.record.proposal.payeeName).toBe("Harbour Plumbing");
    expect(known.record.risks.map((flag) => flag.code)).not.toEqual(expect.arrayContaining(["NEW_PAYEE", "MISSING_PAYEE_EMAIL"]));

    const large = await service.createFromText(SAMPLES[3].text);
    expect(large.record.proposal).toMatchObject({ amount: "2500.00", currency: "EUR", payeeName: "QuickCash Ltd" });
    expect(large.record.risks.some((flag) => flag.code === "LARGE_AMOUNT")).toBe(true);

    const callsBefore = paypal.calls.length;
    await expect(service.createFromText("Please call the plumber tomorrow")).rejects.toMatchObject({
      code: "NO_AMOUNT",
      status: 422,
    });
    expect(paypal.calls.length).toBe(callsBefore);
  });

  it("does not trust a model quote that is not in the request", async () => {
    const paypalLocal = createMockPayPal();
    const agent: Agent = {
      describe() {
        return { provider: "openai", model: "gpt-4o-mini", note: "injected" };
      },
      async extract() {
        return {
          proposal: {
            payeeName: "Plumber",
            payeeEmail: null,
            amount: "1500.00",
            currency: "GBP",
            purpose: "Deposit for a boiler service visit",
            when: "next Tuesday",
          },
          quotes: {
            payeeName: "Plumber",
            payeeEmail: "",
            amount: "£1500",
            currency: "GBP",
            purpose: "not in the text",
            when: "next Tuesday",
          },
          ai: { provider: "openai", model: "gpt-4o-mini", note: "injected tool call" },
        };
      },
    };
    const local = createService({ store: new MemoryStore(), paypal: paypalLocal, knownPayees: KNOWN, agent });
    const created = await local.createFromText(PLUMBER);
    expect(created.record.risks.map((flag) => flag.code)).toEqual(
      expect.arrayContaining(["AMOUNT_MISMATCH", "UNVERIFIED_SOURCE"]),
    );
    expect(assertCaptureAllowedSafe(created.record)).toBe("APPROVAL_REQUIRED");
    expect(paypalLocal.calls).toEqual(["create", "get"]);
  });
});

function assertCaptureAllowedSafe(record: Parameters<typeof assertCaptureAllowed>[0]): string | null {
  try {
    assertCaptureAllowed(record);
    return null;
  } catch (error) {
    if (error instanceof GateError) return error.code;
    throw error;
  }
}
