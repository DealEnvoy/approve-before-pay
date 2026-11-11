import { z } from "zod";

import { normalizeAmountInput } from "@/lib/money";
import { OFFLINE_NO_KEY_NOTE, offlineExtract, type OfflineExtraction } from "@/lib/offline-agent";
import type { AiInfo, Currency, FieldName } from "@/lib/types";
import { GateError } from "./errors";

export type Extraction = OfflineExtraction;

export interface Agent {
  describe(): AiInfo;
  extract(text: string): Promise<Extraction>;
}

type RemoteConfig = {
  kind: "openai" | "cloudflare";
  provider: "openai" | "cloudflare";
  model: string;
  url: string;
  headers: Record<string, string>;
  note: string;
};

const ProposeSchema = z.object({
  payeeName: z.string().min(1),
  payeeEmail: z.string().optional().nullable(),
  amount: z.string().min(1),
  currency: z.enum(["GBP", "USD", "EUR"]),
  purpose: z.string().min(1),
  when: z.string().optional().nullable(),
  payeeNameQuote: z.string().optional().default(""),
  payeeEmailQuote: z.string().optional().default(""),
  amountQuote: z.string().optional().default(""),
  currencyQuote: z.string().optional().default(""),
  purposeQuote: z.string().optional().default(""),
  whenQuote: z.string().optional().default(""),
});

const TOOL = {
  type: "function",
  function: {
    name: "propose_payment",
    description:
      "Record one payment proposal. Every quote must be an exact contiguous copy from the request. Use an empty string when a value is absent.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        payeeName: { type: "string" },
        payeeEmail: { type: "string" },
        amount: { type: "string", description: "Decimal amount such as 150.00" },
        currency: { type: "string", enum: ["GBP", "USD", "EUR"] },
        purpose: { type: "string" },
        when: { type: "string" },
        payeeNameQuote: { type: "string" },
        payeeEmailQuote: { type: "string" },
        amountQuote: { type: "string" },
        currencyQuote: { type: "string" },
        purposeQuote: { type: "string" },
        whenQuote: { type: "string" },
      },
      required: [
        "payeeName",
        "payeeEmail",
        "amount",
        "currency",
        "purpose",
        "when",
        "payeeNameQuote",
        "payeeEmailQuote",
        "amountQuote",
        "currencyQuote",
        "purposeQuote",
        "whenQuote",
      ],
    },
  },
};

const SYSTEM_PROMPT = [
  "You prepare one payment proposal from a plain language request.",
  "Call the propose_payment tool once.",
  "Copy each source quote character for character from the request.",
  "Do not invent an email. Use an empty string when a value is absent.",
  "amount uses two decimal places. currency is GBP, USD, or EUR.",
  "If several amounts appear, choose the deposit or the up front figure and quote that figure only.",
  "purpose is a short description of what the payment is for.",
  "when is the timing phrase, or an empty string.",
].join(" ");

export function resolveAiConfig(env: Record<string, string | undefined>): RemoteConfig | { kind: "offline"; note: string } {
  const forced = (env.AI_PROVIDER || "auto").toLowerCase();
  const hasOpenAI = Boolean(env.OPENAI_API_KEY);
  const hasCloudflare = Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN);

  if (forced === "offline") {
    return { kind: "offline", note: "AI_PROVIDER=offline. The offline rules extractor is active." };
  }
  if (forced === "openai") {
    if (!hasOpenAI) {
      throw new GateError("AI_NOT_CONFIGURED", 500, "AI_PROVIDER=openai but OPENAI_API_KEY is missing.");
    }
    return openAIConfig(env);
  }
  if (forced === "cloudflare") {
    if (!hasCloudflare) {
      throw new GateError(
        "AI_NOT_CONFIGURED",
        500,
        "AI_PROVIDER=cloudflare but CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN is missing.",
      );
    }
    return cloudflareConfig(env);
  }
  if (hasOpenAI) return openAIConfig(env);
  if (hasCloudflare) return cloudflareConfig(env);
  return { kind: "offline", note: OFFLINE_NO_KEY_NOTE };
}

function openAIConfig(env: Record<string, string | undefined>): RemoteConfig {
  const model = env.OPENAI_MODEL || "gpt-4o-mini";
  const base = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  return {
    kind: "openai",
    provider: "openai",
    model,
    url: `${base}/chat/completions`,
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    note: `Called ${model} through chat completions with the propose_payment tool.`,
  };
}

function cloudflareConfig(env: Record<string, string | undefined>): RemoteConfig {
  const model = env.CLOUDFLARE_AI_MODEL || "@cf/meta/llama-3.1-8b-instruct";
  return {
    kind: "cloudflare",
    provider: "cloudflare",
    model,
    url: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`,
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    note: `Called Cloudflare Workers AI model ${model} with the propose_payment tool.`,
  };
}

export function createAgent(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Agent {
  const config = resolveAiConfig(env);
  return {
    describe(): AiInfo {
      if (config.kind === "offline") {
        return { provider: "offline_fallback", model: "offline-rules-v1", note: config.note };
      }
      return { provider: config.provider, model: config.model, note: config.note };
    },
    async extract(text: string): Promise<Extraction> {
      if (config.kind === "offline") {
        return offlineExtract(text, config.note);
      }
      try {
        return await llmExtract(text, config, fetchImpl);
      } catch (error) {
        if (error instanceof GateError) throw error;
        const reason = error instanceof Error ? error.message : "model call failed";
        return offlineExtract(
          text,
          `The model call failed (${reason}). Used the offline rules extractor instead. This request did not keep a model result.`,
        );
      }
    },
  };
}

export async function llmExtract(text: string, config: RemoteConfig, fetchImpl: typeof fetch): Promise<Extraction> {
  const response = await fetchImpl(config.url, {
    method: "POST",
    headers: config.headers,
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      tools: [TOOL],
      tool_choice: { type: "function", function: { name: "propose_payment" } },
    }),
    signal: AbortSignal.timeout(25000),
  });

  if (!response.ok) {
    throw new Error(`${config.provider} returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
      };
    }>;
  };
  const toolCall = payload.choices?.[0]?.message?.tool_calls?.find((call) => call.function?.name === "propose_payment");
  if (!toolCall?.function) {
    throw new Error(`${config.provider} returned no propose_payment tool call`);
  }
  const parsed = parseToolArguments(toolCall.function.arguments);
  const amount = normalizeAmountInput(parsed.amount);
  if (!amount || Number(amount) <= 0) {
    throw new Error("the tool call did not include a usable amount");
  }
  const email = cleanOptional(parsed.payeeEmail);
  const when = cleanOptional(parsed.when);
  const quotes: Partial<Record<FieldName, string>> = {
    payeeName: parsed.payeeNameQuote,
    payeeEmail: parsed.payeeEmailQuote,
    amount: parsed.amountQuote,
    currency: parsed.currencyQuote,
    purpose: parsed.purposeQuote,
    when: parsed.whenQuote,
  };
  return {
    proposal: {
      payeeName: parsed.payeeName.trim(),
      payeeEmail: email,
      amount,
      currency: parsed.currency as Currency,
      purpose: parsed.purpose.trim(),
      when,
    },
    quotes,
    ai: {
      provider: config.provider,
      model: config.model,
      note: config.note,
    },
  };
}

export function parseToolArguments(raw: unknown): z.infer<typeof ProposeSchema> {
  let value = raw;
  if (typeof raw === "string") {
    value = JSON.parse(raw);
  }
  return ProposeSchema.parse(value);
}

function cleanOptional(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}
