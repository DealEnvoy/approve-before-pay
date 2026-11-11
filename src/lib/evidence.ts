import { detectAmounts, CURRENCY_SYMBOL } from "./money";
import {
  FIELD_NAMES,
  proposalValue,
  type Currency,
  type FieldEvidence,
  type FieldName,
  type Proposal,
} from "./types";

export function locateQuote(text: string, quote: string): { start: number; end: number } | null {
  const trimmed = quote.trim();
  if (!trimmed) return null;
  const start = text.indexOf(trimmed);
  if (start < 0) return null;
  return { start, end: start + trimmed.length };
}

export function buildEvidence(
  text: string,
  proposal: Proposal,
  quotes: Partial<Record<FieldName, string>>,
  origin: "agent" | "reviewer",
  previous?: FieldEvidence[],
): FieldEvidence[] {
  return FIELD_NAMES.map((field) => {
    const value = proposalValue(proposal, field);
    const prior = previous?.find((item) => item.field === field);
    if (origin === "reviewer" && prior && prior.value === value) {
      return prior;
    }
    const quote = (quotes[field] ?? "").trim();
    const located = locateQuote(text, quote);
    return {
      field,
      value,
      sourceQuote: located ? quote : quote,
      start: located?.start ?? null,
      end: located?.end ?? null,
      verified: Boolean(located),
      origin,
    };
  });
}

export function quotesForReviewerEdit(
  text: string,
  proposal: Proposal,
  previous: FieldEvidence[],
): Partial<Record<FieldName, string>> {
  const quotes: Partial<Record<FieldName, string>> = {};
  for (const field of FIELD_NAMES) {
    const value = proposalValue(proposal, field);
    const prior = previous.find((item) => item.field === field);
    if (prior && prior.value === value) {
      quotes[field] = prior.sourceQuote;
      continue;
    }
    quotes[field] = findEditedQuote(text, field, value);
  }
  return quotes;
}

function findEditedQuote(text: string, field: FieldName, value: string): string {
  if (!value) return "";
  if (field === "amount") {
    return detectAmounts(text).find((hit) => hit.value === value)?.raw ?? "";
  }
  if (field === "currency") {
    const symbol = CURRENCY_SYMBOL[value as Currency];
    if (symbol && text.includes(symbol)) return symbol;
    if (text.toUpperCase().includes(value.toUpperCase())) return value;
    return "";
  }
  if (text.includes(value)) return value;
  return "";
}
