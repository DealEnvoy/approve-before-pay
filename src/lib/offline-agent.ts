import { chooseAmount, detectAmounts } from "./money";
import type { AiInfo, Currency, FieldName, Proposal } from "./types";

const WEEKDAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const WHEN_PATTERN = new RegExp(
  `\\b(?:next|this|on|before)\\s+(?:${WEEKDAYS})\\b|\\btomorrow\\b|\\btoday\\b`,
  "i",
);
const PAYEE_PATTERN =
  /^([A-Z][A-Za-z0-9&'.]*(?:\s+[A-Z][A-Za-z0-9&'.]*){0,5})\s+(needs|wants|asks|requires|quoted)\b/;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export type OfflineExtraction = {
  proposal: Proposal;
  quotes: Partial<Record<FieldName, string>>;
  ai: AiInfo;
};

export function offlineExtract(text: string, note: string): OfflineExtraction {
  const hits = detectAmounts(text);
  if (hits.length === 0) {
    throw new OfflineAmountError("No amount was found in the request. No PayPal order was created.");
  }
  const chosen = chooseAmount(text, hits);
  const currency: Currency = chosen.currency ?? "GBP";
  const payeeMatch = PAYEE_PATTERN.exec(text.trim());
  const payeeName = payeeMatch?.[1] ?? "Unknown payee";
  const payeeQuote = payeeMatch?.[1] ?? "";
  const emailMatch = EMAIL_PATTERN.exec(text);
  const whenMatch = WHEN_PATTERN.exec(text);
  const whenQuote = whenMatch?.[0] ?? "";
  const purpose = findPurpose(text, whenQuote);
  const currencyQuote = currencyQuoteFrom(text, chosen.raw, currency);

  const proposal: Proposal = {
    payeeName,
    payeeEmail: emailMatch?.[0] ?? null,
    amount: chosen.value,
    currency,
    purpose: purpose.value,
    when: whenQuote || null,
  };

  return {
    proposal,
    quotes: {
      payeeName: payeeQuote,
      payeeEmail: emailMatch?.[0] ?? "",
      amount: chosen.raw,
      currency: currencyQuote,
      purpose: purpose.quote,
      when: whenQuote,
    },
    ai: {
      provider: "offline_fallback",
      model: "offline-rules-v1",
      note,
    },
  };
}

export class OfflineAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineAmountError";
  }
}

function findPurpose(text: string, whenQuote: string): { value: string; quote: string } {
  const patterns = [/deposit to [^.,\n]+/i, /deposit for [^.,\n]+/i, /up front[^.,\n]+/i, /up front/i];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    let quote = match[0].trim();
    if (whenQuote && quote.toLowerCase().endsWith(whenQuote.toLowerCase())) {
      quote = quote.slice(0, quote.length - whenQuote.length).trim();
    }
    if (!quote || !text.includes(quote)) continue;
    return { quote, value: quote.charAt(0).toUpperCase() + quote.slice(1) };
  }
  return { value: "Payment requested in the message", quote: "" };
}

function currencyQuoteFrom(text: string, raw: string, currency: Currency): string {
  if (raw.includes("£") || raw.includes("$") || raw.includes("€")) return raw;
  const word = raw.match(/pounds?|euros?|dollars?|GBP|USD|EUR/i)?.[0];
  if (word && text.includes(word)) return word;
  return currency;
}

export const OFFLINE_NO_KEY_NOTE =
  "No OPENAI_API_KEY or Cloudflare Workers AI credentials are set. This proposal was built by the offline rules extractor, not by a language model.";
