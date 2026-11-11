import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { buildEvidence, quotesForReviewerEdit } from "@/lib/evidence";
import { normalizeAmountInput } from "@/lib/money";
import { orderDescription } from "@/lib/paypal-order";
import { assessRisk, requiredAcknowledgements } from "@/lib/risk";
import {
  toSummary,
  type AiInfo,
  type AuditEvent,
  type CaseSummary,
  type Currency,
  type KnownPayee,
  type PaymentCase,
  type Proposal,
} from "@/lib/types";
import { GateError, PayPalRequestError } from "./errors";
import { createAgent, type Agent } from "./llm";
import { createPayPalClient, type PayPalClient } from "./paypal";
import { FileStore, type Store } from "./store";

export type CaseView = {
  record: PaymentCase;
  audits: AuditEvent[];
};

export type DeskMeta = {
  paypal: { mode: "mock" | "sandbox"; label: string };
  ai: AiInfo;
  knownPayees: KnownPayee[];
  largeAmount: number;
};

type EditInput = {
  reviewerName: string;
  payeeName: string;
  payeeEmail: string;
  amount: string;
  currency: string;
  purpose: string;
  when: string;
};

type ApproveInput = {
  reviewerName: string;
  note: string;
  acknowledgedRiskCodes: string[];
};

const CURRENCIES = new Set<Currency>(["GBP", "USD", "EUR"]);

export function assertCaptureAllowed(record: PaymentCase): void {
  if (record.status !== "approved" || !record.approval) {
    throw new GateError(
      "APPROVAL_REQUIRED",
      403,
      "Capture refused. A person has not approved this proposal.",
    );
  }
  if (record.approval.proposalVersion !== record.version) {
    throw new GateError(
      "APPROVAL_STALE",
      403,
      "Capture refused. The proposal changed after approval.",
    );
  }
  if (!record.paypal.orderId) {
    throw new GateError("NO_ORDER", 409, "Capture refused. There is no PayPal order on this proposal.");
  }
}

export class Service {
  constructor(
    private store: Store,
    private paypal: PayPalClient,
    private agent: Agent,
    private knownPayees: KnownPayee[],
    private now: () => Date = () => new Date(),
    private newId: (prefix: string) => string = defaultId,
  ) {}

  meta(): DeskMeta {
    const mode = this.paypal.mode;
    return {
      paypal: {
        mode,
        label:
          mode === "mock"
            ? "PayPal mock mode. No sandbox credentials are set, so no live PayPal call is made."
            : "PayPal sandbox. Create and capture call Orders v2 on the live sandbox API.",
      },
      ai: this.agent.describe(),
      knownPayees: this.knownPayees,
      largeAmount: 1000,
    };
  }

  list(): { records: CaseSummary[]; audits: AuditEvent[] } {
    return {
      records: this.store.listCases().map(toSummary),
      audits: this.store.listAudits(),
    };
  }

  get(id: string): CaseView {
    return { record: this.must(id), audits: this.store.listAudits(id) };
  }

  clear(): { records: CaseSummary[]; audits: AuditEvent[] } {
    this.store.replace({ cases: [], audits: [] });
    return this.list();
  }

  async createFromText(rawText: string): Promise<CaseView> {
    const text = rawText.trim();
    if (!text) throw new GateError("EMPTY", 400, "Enter a payment request.");
    if (text.length > 2000) throw new GateError("TOO_LONG", 400, "The request is longer than 2000 characters.");

    let extraction;
    try {
      extraction = await this.agent.extract(text);
    } catch (error) {
      if (error instanceof GateError) throw error;
      const message = error instanceof Error ? error.message : "The agent could not read that request.";
      throw new GateError("NO_AMOUNT", 422, message);
    }

    if (Number(extraction.proposal.amount) <= 0) {
      throw new GateError("NO_AMOUNT", 422, "No usable amount was found. No PayPal order was created.");
    }

    const evidence = buildEvidence(text, extraction.proposal, extraction.quotes, "agent");
    const risks = assessRisk({
      text,
      proposal: extraction.proposal,
      evidence,
      knownPayees: this.knownPayees,
    });
    const description = orderDescription(extraction.proposal);
    const id = this.newId("abp");
    const createdAt = this.now().toISOString();
    const order = await this.openOrder(id, 1, extraction.proposal, description);
    const record: PaymentCase = {
      id,
      createdAt,
      updatedAt: createdAt,
      rawText: text,
      status: "proposed",
      version: 1,
      ai: extraction.ai,
      proposal: extraction.proposal,
      evidence,
      risks,
      paypal: {
        mode: this.paypal.mode,
        intent: "CAPTURE",
        orderId: order.orderId,
        orderStatus: order.orderStatus,
        captureId: null,
        captureStatus: null,
        approveUrl: order.approveUrl,
        description,
        previousOrderIds: [],
        lastError: order.readError,
      },
      approval: null,
      rejection: null,
    };

    this.store.apply((draft) => {
      draft.cases.push(record);
      const at = createdAt;
      pushAudit(draft, this.newId, {
        at,
        caseId: id,
        type: "request_received",
        actor: "reviewer",
        message: `Request received (${text.length} characters).`,
        data: { text },
      });
      pushAudit(draft, this.newId, {
        at,
        caseId: id,
        type: "agent_extracted",
        actor: "agent",
        message: `Extracted a proposal with ${extraction.ai.provider} (${extraction.ai.model}). ${extraction.ai.note}`,
        data: { proposal: extraction.proposal, quotes: extraction.quotes, ai: extraction.ai },
      });
      const filled = evidence.filter((item) => item.value);
      const verified = filled.filter((item) => item.verified).length;
      pushAudit(draft, this.newId, {
        at,
        caseId: id,
        type: "evidence_checked",
        actor: "system",
        message: `Checked source quotes against the request. ${verified} of ${filled.length} filled fields are present in the text.`,
        data: { evidence },
      });
      pushAudit(draft, this.newId, {
        at,
        caseId: id,
        type: "risk_assessed",
        actor: "system",
        message:
          risks.length === 0
            ? "No risk flags on this version."
            : `Risk flags: ${risks.map((flag) => `${flag.code} (${flag.severity})`).join(", ")}.`,
        data: { risks },
      });
      pushAudit(draft, this.newId, {
        at,
        caseId: id,
        type: "paypal_order_created",
        actor: "paypal",
        message: order.createMessage,
        data: {
          mode: this.paypal.mode,
          endpoint: "POST /v2/checkout/orders",
          intent: "CAPTURE",
          orderId: order.orderId,
          orderStatus: order.createdStatus,
          description,
          amount: extraction.proposal.amount,
          currency: extraction.proposal.currency,
        },
      });
      pushAudit(draft, this.newId, {
        at,
        caseId: id,
        type: order.readError ? "paypal_order_read_failed" : "paypal_order_read",
        actor: "paypal",
        message: order.readMessage,
        data: { endpoint: `GET /v2/checkout/orders/${order.orderId}`, orderStatus: order.orderStatus, error: order.readError },
      });
      pushAudit(draft, this.newId, {
        at,
        caseId: id,
        type: "proposal_ready",
        actor: "system",
        message: `The proposal is waiting for a person. PayPal order ${order.orderId} is ${order.orderStatus} and has not been captured.`,
      });
    });

    return this.get(id);
  }

  async edit(id: string, input: EditInput): Promise<CaseView> {
    const current = this.must(id);
    if (current.status === "captured") {
      throw new GateError("ALREADY_CAPTURED", 409, "This payment is already captured, so it cannot be edited.");
    }
    const reviewerName = cleanName(input.reviewerName);
    const proposal = cleanProposal(input);
    const quotes = quotesForReviewerEdit(current.rawText, proposal, current.evidence);
    const evidence = buildEvidence(current.rawText, proposal, quotes, "reviewer", current.evidence);
    const risks = assessRisk({
      text: current.rawText,
      proposal,
      evidence,
      knownPayees: this.knownPayees,
    });
    const version = current.version + 1;
    const description = orderDescription(proposal);
    const order = await this.openOrder(id, version, proposal, description);
    const at = this.now().toISOString();
    const previousOrderId = current.paypal.orderId;

    this.store.apply((draft) => {
      const item = draft.cases.find((entry) => entry.id === id);
      if (!item) return;
      item.updatedAt = at;
      item.status = "proposed";
      item.version = version;
      item.proposal = proposal;
      item.evidence = evidence;
      item.risks = risks;
      item.approval = null;
      item.rejection = null;
      item.paypal = {
        mode: this.paypal.mode,
        intent: "CAPTURE",
        orderId: order.orderId,
        orderStatus: order.orderStatus,
        captureId: null,
        captureStatus: null,
        approveUrl: order.approveUrl,
        description,
        previousOrderIds: previousOrderId ? [...item.paypal.previousOrderIds, previousOrderId] : item.paypal.previousOrderIds,
        lastError: order.readError,
      };
      pushAudit(draft, this.newId, {
        at,
        caseId: id,
        type: "human_edited",
        actor: "reviewer",
        message: `${reviewerName} edited the proposal. Approval was cleared. Version ${version} needs a new approval.${previousOrderId ? ` Previous order ${previousOrderId} was left uncaptured.` : ""}`,
        data: { reviewerName, proposal, version, previousOrderId },
      });
      pushAudit(draft, this.newId, {
        at,
        caseId: id,
        type: "risk_assessed",
        actor: "system",
        message:
          risks.length === 0
            ? "No risk flags on this version."
            : `Risk flags: ${risks.map((flag) => `${flag.code} (${flag.severity})`).join(", ")}.`,
        data: { risks },
      });
      pushAudit(draft, this.newId, {
        at,
        caseId: id,
        type: "paypal_order_created",
        actor: "paypal",
        message: order.createMessage,
        data: {
          mode: this.paypal.mode,
          endpoint: "POST /v2/checkout/orders",
          intent: "CAPTURE",
          orderId: order.orderId,
          previousOrderId,
        },
      });
    });

    return this.get(id);
  }

  approve(id: string, input: ApproveInput): CaseView {
    const current = this.must(id);
    if (current.status === "captured") {
      throw new GateError("ALREADY_CAPTURED", 409, "This payment is already captured.");
    }
    if (current.status === "rejected") {
      throw new GateError("REJECTED", 409, "This proposal was rejected. Edit it to make a new version before approval.");
    }
    if (current.status !== "proposed") {
      throw new GateError("NOT_PROPOSED", 409, "Only a proposal that is waiting can be approved.");
    }
    const reviewerName = cleanName(input.reviewerName);
    const note = cleanNote(input.note, "Add a note about what you checked.");
    const required = requiredAcknowledgements(current.risks);
    const provided = new Set(input.acknowledgedRiskCodes ?? []);
    const missing = required.filter((code) => !provided.has(code));
    if (missing.length > 0) {
      throw new GateError(
        "RISKS_NOT_ACKNOWLEDGED",
        400,
        `Acknowledge these flags before approval: ${missing.join(", ")}.`,
      );
    }
    const at = this.now().toISOString();
    this.store.apply((draft) => {
      const item = draft.cases.find((entry) => entry.id === id);
      if (!item) return;
      item.status = "approved";
      item.updatedAt = at;
      item.approval = {
        at,
        reviewerName,
        note,
        acknowledgedRiskCodes: required,
        proposalVersion: item.version,
      };
      item.rejection = null;
      pushAudit(draft, this.newId, {
        at,
        caseId: id,
        type: "human_approved",
        actor: "reviewer",
        message: `${reviewerName} approved version ${item.version}. Capture is now allowed for order ${item.paypal.orderId}. Note: ${note}`,
        data: { reviewerName, note, version: item.version, acknowledgedRiskCodes: required },
      });
    });
    return this.get(id);
  }

  reject(id: string, input: { reviewerName: string; reason: string }): CaseView {
    const current = this.must(id);
    if (current.status === "captured") {
      throw new GateError("ALREADY_CAPTURED", 409, "This payment is already captured, so it cannot be rejected.");
    }
    if (current.status === "rejected") {
      throw new GateError("ALREADY_REJECTED", 409, "This proposal is already rejected.");
    }
    const reviewerName = cleanName(input.reviewerName);
    const reason = cleanNote(input.reason, "Add a reason for the rejection.");
    const at = this.now().toISOString();
    this.store.apply((draft) => {
      const item = draft.cases.find((entry) => entry.id === id);
      if (!item) return;
      item.status = "rejected";
      item.updatedAt = at;
      item.approval = null;
      item.rejection = { at, reviewerName, reason };
      pushAudit(draft, this.newId, {
        at,
        caseId: id,
        type: "human_rejected",
        actor: "reviewer",
        message: `${reviewerName} rejected version ${item.version}. Capture stays closed. Reason: ${reason}`,
        data: { reviewerName, reason, version: item.version },
      });
    });
    return this.get(id);
  }

  async capture(id: string, reviewerNameInput: string): Promise<CaseView> {
    const current = this.must(id);
    if (current.status === "captured") {
      throw new GateError("ALREADY_CAPTURED", 409, "Capture refused. This order is already captured.");
    }
    if (current.paypal.mode !== this.paypal.mode) {
      throw new GateError(
        "MODE_MISMATCH",
        409,
        `Capture refused. The order was created in ${current.paypal.mode} mode and the server is in ${this.paypal.mode} mode.`,
      );
    }
    try {
      assertCaptureAllowed(current);
    } catch (error) {
      if (error instanceof GateError) {
        const actor = reviewerNameInput.trim() || "Reviewer";
        this.recordRefusal(current.id, actor, error);
        const view = this.get(id);
        throw new GateError(error.code, error.status, error.message, { record: view.record, audits: view.audits });
      }
      throw error;
    }
    const reviewerName = cleanName(reviewerNameInput);

    const orderId = current.paypal.orderId as string;
    let result;
    try {
      result = await this.paypal.captureOrder(orderId, this.newId("req"));
    } catch (error) {
      const message = paypalMessage(error);
      const at = this.now().toISOString();
      this.store.apply((draft) => {
        const item = draft.cases.find((entry) => entry.id === id);
        if (!item) return;
        item.updatedAt = at;
        item.paypal.lastError = message;
        pushAudit(draft, this.newId, {
          at,
          caseId: id,
          type: "paypal_capture_failed",
          actor: "paypal",
          message: `PayPal capture failed. ${message} The approval still stands. The case was not marked captured.`,
          data: { orderId, endpoint: `POST /v2/checkout/orders/${orderId}/capture` },
        });
      });
      const view = this.get(id);
      throw new GateError("PAYPAL_CAPTURE_FAILED", 502, message, { record: view.record, audits: view.audits });
    }

    if (result.orderStatus !== "COMPLETED") {
      const at = this.now().toISOString();
      const message = `PayPal returned order status ${result.orderStatus}. Capture was not completed.`;
      this.store.apply((draft) => {
        const item = draft.cases.find((entry) => entry.id === id);
        if (!item) return;
        item.updatedAt = at;
        item.paypal.orderStatus = result.orderStatus;
        item.paypal.captureId = result.captureId || null;
        item.paypal.captureStatus = result.captureStatus || null;
        item.paypal.lastError = message;
        pushAudit(draft, this.newId, {
          at,
          caseId: id,
          type: "paypal_capture_failed",
          actor: "paypal",
          message,
          data: { result, endpoint: `POST /v2/checkout/orders/${orderId}/capture` },
        });
      });
      const view = this.get(id);
      throw new GateError("PAYPAL_CAPTURE_FAILED", 502, message, { record: view.record, audits: view.audits });
    }

    const at = this.now().toISOString();
    const simulated = this.paypal.mode === "mock";
    this.store.apply((draft) => {
      const item = draft.cases.find((entry) => entry.id === id);
      if (!item) return;
      item.status = "captured";
      item.updatedAt = at;
      item.paypal.orderStatus = result.orderStatus;
      item.paypal.captureId = result.captureId;
      item.paypal.captureStatus = result.captureStatus;
      item.paypal.lastError = null;
      pushAudit(draft, this.newId, {
        at,
        caseId: id,
        type: "paypal_capture_completed",
        actor: "paypal",
        message: simulated
          ? `PayPal mock capture completed for order ${orderId}. Capture ${result.captureId} is COMPLETED. This is a simulated result. No live PayPal charge was made.`
          : `PayPal sandbox capture completed for order ${orderId}. Capture ${result.captureId} is ${result.captureStatus}.`,
        data: {
          mode: this.paypal.mode,
          endpoint: `POST /v2/checkout/orders/${orderId}/capture`,
          reviewerName,
          result,
          simulated,
        },
      });
    });
    return this.get(id);
  }

  private recordRefusal(caseId: string, reviewerName: string, error: GateError): void {
    const at = this.now().toISOString();
    this.store.apply((draft) => {
      pushAudit(draft, this.newId, {
        at,
        caseId,
        type: "capture_refused",
        actor: "system",
        message: `${error.message} Requested by ${reviewerName}. PayPal capture was not called.`,
        data: { code: error.code, reviewerName },
      });
    });
  }

  private async openOrder(caseId: string, version: number, proposal: Proposal, description: string) {
    const requestId = this.newId("req");
    let created;
    try {
      created = await this.paypal.createOrder({
        caseId,
        version,
        currency: proposal.currency,
        value: proposal.amount,
        description,
        requestId,
      });
    } catch (error) {
      throw new GateError("PAYPAL_CREATE_FAILED", 502, paypalMessage(error));
    }
    let orderStatus = created.status;
    let readError: string | null = null;
    try {
      const view = await this.paypal.getOrder(created.id);
      orderStatus = view.status;
    } catch (error) {
      readError = paypalMessage(error);
    }
    const modeLabel = this.paypal.mode === "mock" ? "mock (no live call)" : "sandbox (live call)";
    return {
      orderId: created.id,
      createdStatus: created.status,
      orderStatus,
      approveUrl: created.approveUrl,
      readError,
      createMessage: `Created PayPal order ${created.id} with intent CAPTURE by POST /v2/checkout/orders. Mode: ${modeLabel}. Returned status ${created.status}. Capture was not called.`,
      readMessage: readError
        ? `GET /v2/checkout/orders/${created.id} failed. ${readError}`
        : `Read the order back with GET /v2/checkout/orders/${created.id}. Status ${orderStatus}.`,
    };
  }

  private must(id: string): PaymentCase {
    const record = this.store.getCase(id);
    if (!record) throw new GateError("NOT_FOUND", 404, "That payment request is not on this desk.");
    return record;
  }
}

function pushAudit(
  draft: { audits: AuditEvent[] },
  newId: (prefix: string) => string,
  event: Omit<AuditEvent, "id" | "seq">,
): void {
  const seq = draft.audits.reduce((max, item) => Math.max(max, item.seq), 0) + 1;
  draft.audits.push({ ...event, seq, id: newId("aud") });
}

function defaultId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

function cleanName(value: string): string {
  const name = (value ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) {
    throw new GateError("BAD_NAME", 400, "Enter the reviewer name (2 to 80 characters).");
  }
  return name;
}

function cleanNote(value: string, hint: string): string {
  const note = (value ?? "").trim();
  if (note.length < 8 || note.length > 500) {
    throw new GateError("BAD_NOTE", 400, `${hint} Use 8 to 500 characters.`);
  }
  return note;
}

function cleanProposal(input: EditInput): Proposal {
  const payeeName = input.payeeName.trim().replace(/\s+/g, " ");
  if (payeeName.length < 2 || payeeName.length > 80) {
    throw new GateError("BAD_PAYEE", 400, "Enter a payee name (2 to 80 characters).");
  }
  const email = input.payeeEmail.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new GateError("BAD_EMAIL", 400, "The payee email does not look like an email address.");
  }
  const amount = normalizeAmountInput(input.amount);
  if (!amount || Number(amount) <= 0 || Number(amount) > 999999.99) {
    throw new GateError("BAD_AMOUNT", 400, "Enter an amount greater than 0, with up to two decimal places.");
  }
  const currency = input.currency.trim().toUpperCase();
  if (!CURRENCIES.has(currency as Currency)) {
    throw new GateError("BAD_CURRENCY", 400, "Currency must be GBP, USD, or EUR.");
  }
  const purpose = input.purpose.trim();
  if (purpose.length < 3 || purpose.length > 140) {
    throw new GateError("BAD_PURPOSE", 400, "Enter a purpose (3 to 140 characters).");
  }
  const when = input.when.trim();
  if (when.length > 80) {
    throw new GateError("BAD_WHEN", 400, "The timing phrase is longer than 80 characters.");
  }
  return {
    payeeName,
    payeeEmail: email || null,
    amount,
    currency: currency as Currency,
    purpose,
    when: when || null,
  };
}

function paypalMessage(error: unknown): string {
  if (error instanceof PayPalRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return "PayPal request failed.";
}

export function loadKnownPayees(file = path.join(process.cwd(), "data", "known-payees.json")): KnownPayee[] {
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw) as KnownPayee[];
}

const globalStore = globalThis as unknown as { __approveBeforePay?: Service };

export function createService(overrides?: {
  store?: Store;
  paypal?: PayPalClient;
  agent?: Agent;
  knownPayees?: KnownPayee[];
  now?: () => Date;
  id?: (prefix: string) => string;
}): Service {
  return new Service(
    overrides?.store ?? new FileStore(process.env.DATA_FILE || path.join(process.cwd(), "data", "store.json")),
    overrides?.paypal ?? createPayPalClient(),
    overrides?.agent ?? createAgent(),
    overrides?.knownPayees ?? loadKnownPayees(),
    overrides?.now,
    overrides?.id,
  );
}

export function getService(): Service {
  if (!globalStore.__approveBeforePay) {
    globalStore.__approveBeforePay = createService();
  }
  return globalStore.__approveBeforePay;
}

export function resetService(): void {
  globalStore.__approveBeforePay = undefined;
}
