import type { Currency } from "./types";

export type AmountHit = {
  raw: string;
  value: string;
  currency: Currency | null;
  start: number;
  end: number;
};

const MONEY_SOURCE =
  "(?:(?<sym>£|\\$|€)\\s?(?<num>\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(?<dec>\\d{1,2}))?)|(?:(?<num2>\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(?<dec2>\\d{1,2}))?\\s?(?<word>GBP|USD|EUR|pounds?|euros?|dollars?))";

export function formatAmount(major: string, minor?: string): string {
  const whole = major.replace(/,/g, "");
  if (!/^\d+$/.test(whole)) {
    throw new Error("Amount is not a number");
  }
  const cents = (minor ?? "").replace(/\D/g, "");
  const fixed = (cents + "00").slice(0, 2);
  return `${String(Number(whole))}.${fixed}`;
}

export function normalizeAmountInput(input: string): string | null {
  const trimmed = input.trim().replace(/[£$€\s]/g, "").replace(/,/g, "");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;
  return formatAmount(match[1], match[2]);
}

function currencyFrom(sym?: string, word?: string): Currency | null {
  if (sym === "£") return "GBP";
  if (sym === "$") return "USD";
  if (sym === "€") return "EUR";
  if (!word) return null;
  const lower = word.toLowerCase();
  if (lower === "gbp" || lower.startsWith("pound")) return "GBP";
  if (lower === "usd" || lower.startsWith("dollar")) return "USD";
  if (lower === "eur" || lower.startsWith("euro")) return "EUR";
  return null;
}

export function detectAmounts(text: string): AmountHit[] {
  const expression = new RegExp(MONEY_SOURCE, "gi");
  const hits: AmountHit[] = [];
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text))) {
    const groups = match.groups ?? {};
    const num = groups.num ?? groups.num2;
    if (!num) continue;
    const dec = groups.dec ?? groups.dec2;
    hits.push({
      raw: match[0],
      value: formatAmount(num, dec),
      currency: currencyFrom(groups.sym, groups.word),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return hits;
}

export function chooseAmount(text: string, hits: AmountHit[]): AmountHit {
  const lower = text.toLowerCase();
  let anchor = -1;
  for (const word of ["deposit", "up front", "upfront"]) {
    const at = lower.indexOf(word);
    if (at >= 0) {
      anchor = at;
      break;
    }
  }
  if (anchor < 0) return hits[0];
  let best = hits[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const hit of hits) {
    const distance = Math.min(Math.abs(hit.start - anchor), Math.abs(hit.end - anchor));
    if (distance < bestDistance) {
      best = hit;
      bestDistance = distance;
    }
  }
  return best;
}

export function formatMoney(currency: string, amount: string): string {
  const symbols: Record<string, string> = { GBP: "£", USD: "$", EUR: "€" };
  return `${symbols[currency] ?? ""}${amount}`;
}

export const CURRENCY_SYMBOL: Record<Currency, string> = {
  GBP: "£",
  USD: "$",
  EUR: "€",
};
