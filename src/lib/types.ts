export const FIELD_NAMES = [
  "payeeName",
  "payeeEmail",
  "amount",
  "currency",
  "purpose",
  "when",
] as const;

export type FieldName = (typeof FIELD_NAMES)[number];

export type Currency = "GBP" | "USD" | "EUR";

export type Proposal = {
  payeeName: string;
  payeeEmail: string | null;
  amount: string;
  currency: Currency;
  purpose: string;
  when: string | null;
};

export type FieldEvidence = {
  field: FieldName;
  value: string;
  sourceQuote: string;
  start: number | null;
  end: number | null;
  verified: boolean;
  origin: "agent" | "reviewer";
};

export type RiskSeverity = "info" | "warning" | "block";

export type RiskCode =
  | "AMOUNT_MISMATCH"
  | "MULTIPLE_AMOUNTS"
  | "LARGE_AMOUNT"
  | "NEW_PAYEE"
  | "MISSING_PAYEE_EMAIL"
  | "PAYEE_EMAIL_MISMATCH"
  | "UNVERIFIED_SOURCE"
  | "VAGUE_PURPOSE"
  | "CURRENCY_AMBIGUOUS"
  | "REVIEWER_OVERRIDE";

export type RiskFlag = {
  code: RiskCode;
  severity: RiskSeverity;
  message: string;
};

export type CaseStatus = "proposed" | "approved" | "rejected" | "captured";

export type AiProvider = "openai" | "cloudflare" | "offline_fallback";

export type AiInfo = {
  provider: AiProvider;
  model: string;
  note: string;
};

export type PayPalMode = "mock" | "sandbox";

export type PayPalRecord = {
  mode: PayPalMode;
  intent: "CAPTURE";
  orderId: string | null;
  orderStatus: string | null;
  captureId: string | null;
  captureStatus: string | null;
  approveUrl: string | null;
  description: string | null;
  previousOrderIds: string[];
  lastError: string | null;
};

export type Approval = {
  at: string;
  reviewerName: string;
  note: string;
  acknowledgedRiskCodes: string[];
  proposalVersion: number;
};

export type Rejection = {
  at: string;
  reviewerName: string;
  reason: string;
};

export type PaymentCase = {
  id: string;
  createdAt: string;
  updatedAt: string;
  rawText: string;
  status: CaseStatus;
  version: number;
  ai: AiInfo;
  proposal: Proposal;
  evidence: FieldEvidence[];
  risks: RiskFlag[];
  paypal: PayPalRecord;
  approval: Approval | null;
  rejection: Rejection | null;
};

export type AuditEvent = {
  id: string;
  seq: number;
  at: string;
  caseId: string;
  type: string;
  actor: "system" | "agent" | "reviewer" | "paypal";
  message: string;
  data?: unknown;
};

export type KnownPayee = {
  name: string;
  email: string;
};

export type CaseSummary = {
  id: string;
  status: CaseStatus;
  payeeName: string;
  amount: string;
  currency: Currency;
  purpose: string;
  createdAt: string;
  version: number;
};

export const FIELD_LABELS: Record<FieldName, string> = {
  payeeName: "Payee",
  payeeEmail: "Payee email",
  amount: "Amount",
  currency: "Currency",
  purpose: "Purpose",
  when: "When",
};

export function proposalValue(proposal: Proposal, field: FieldName): string {
  switch (field) {
    case "payeeName":
      return proposal.payeeName;
    case "payeeEmail":
      return proposal.payeeEmail ?? "";
    case "amount":
      return proposal.amount;
    case "currency":
      return proposal.currency;
    case "purpose":
      return proposal.purpose;
    case "when":
      return proposal.when ?? "";
  }
}

export function toSummary(record: PaymentCase): CaseSummary {
  return {
    id: record.id,
    status: record.status,
    payeeName: record.proposal.payeeName,
    amount: record.proposal.amount,
    currency: record.proposal.currency,
    purpose: record.proposal.purpose,
    createdAt: record.createdAt,
    version: record.version,
  };
}
