import { detectAmounts } from "./money";
import type { FieldEvidence, KnownPayee, Proposal, RiskFlag } from "./types";

export const LARGE_AMOUNT = 1000;

export function assessRisk(input: {
  text: string;
  proposal: Proposal;
  evidence: FieldEvidence[];
  knownPayees: KnownPayee[];
}): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const hits = detectAmounts(input.text);
  const currencies = new Set(
    hits.map((hit) => hit.currency).filter((currency): currency is NonNullable<typeof currency> => Boolean(currency)),
  );

  if (currencies.size > 1) {
    flags.push({
      code: "CURRENCY_AMBIGUOUS",
      severity: "warning",
      message: `The request mentions more than one currency: ${Array.from(currencies).join(", ")}.`,
    });
  }

  if (hits.length > 1) {
    const listed = hits.map((hit) => hit.raw.trim()).join(", ");
    flags.push({
      code: "MULTIPLE_AMOUNTS",
      severity: "warning",
      message: `The request contains more than one amount (${listed}). The proposal uses ${input.proposal.currency} ${input.proposal.amount}.`,
    });
  }

  const amountMatches = hits.some(
    (hit) => hit.value === input.proposal.amount && (hit.currency === null || hit.currency === input.proposal.currency),
  );
  if (!amountMatches) {
    flags.push({
      code: "AMOUNT_MISMATCH",
      severity: "block",
      message: `The proposed amount ${input.proposal.currency} ${input.proposal.amount} does not match a figure written in the request.`,
    });
  }

  if (Number(input.proposal.amount) >= LARGE_AMOUNT) {
    flags.push({
      code: "LARGE_AMOUNT",
      severity: "warning",
      message: `The amount is ${input.proposal.amount}, which is at or above ${LARGE_AMOUNT} in major units.`,
    });
  }

  const known = input.knownPayees.find(
    (payee) => payee.name.trim().toLowerCase() === input.proposal.payeeName.trim().toLowerCase(),
  );
  if (!known) {
    flags.push({
      code: "NEW_PAYEE",
      severity: "warning",
      message: `${input.proposal.payeeName} is not on the local known payee list.`,
    });
  }

  if (!input.proposal.payeeEmail) {
    flags.push({
      code: "MISSING_PAYEE_EMAIL",
      severity: "warning",
      message: "The request does not include a payee email.",
    });
  } else if (known && known.email.toLowerCase() !== input.proposal.payeeEmail.toLowerCase()) {
    flags.push({
      code: "PAYEE_EMAIL_MISMATCH",
      severity: "warning",
      message: `The email ${input.proposal.payeeEmail} does not match the known email for ${known.name} (${known.email}).`,
    });
  }

  const unverified = input.evidence.filter((item) => item.origin === "agent" && item.value && !item.verified);
  if (unverified.length > 0) {
    flags.push({
      code: "UNVERIFIED_SOURCE",
      severity: "block",
      message: `These fields are not backed by an exact quote in the request: ${unverified.map((item) => item.field).join(", ")}.`,
    });
  }

  const overrides = input.evidence.filter((item) => item.origin === "reviewer" && item.value && !item.verified);
  if (overrides.length > 0) {
    flags.push({
      code: "REVIEWER_OVERRIDE",
      severity: "info",
      message: `A reviewer set ${overrides.map((item) => item.field).join(", ")} to a value that is not in the original text.`,
    });
  }

  const purpose = input.proposal.purpose.trim();
  if (purpose.length < 12 || purpose === "Payment requested in the message") {
    flags.push({
      code: "VAGUE_PURPOSE",
      severity: "warning",
      message: "The purpose is short, or it was not found as a phrase in the request.",
    });
  }

  return flags;
}

export function requiredAcknowledgements(flags: RiskFlag[]): string[] {
  return flags.filter((flag) => flag.severity === "warning" || flag.severity === "block").map((flag) => flag.code);
}
