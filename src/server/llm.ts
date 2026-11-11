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
  payeeEmail: z.string().nullable(),
  amount: z.string().min(1),
  currency: z.enum(["GBP", "USD", "EUR"]),
  purpose: z.string().min(1),
  when: z.string().nullable(),
  payeeNameQuote: z.string(),
  payeeEmailQuote: z.string(),
  amountQuote: z.string(),
  currencyQuote: z.string(),
  purposeQuote: z.string(),
  whenQuote: z.string(),
});

const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_OPENAI_MAX_CALLS = 20;
const MAX_COMPLETION_TOKENS = 500;

const TOOL = {
  type: "function" as const,
  function: {
    name: "propose_payment",
    description:
      "Record one payment proposal. Every quote must be an exact contiguous copy from the request. Use an empty string when a quote is absent. Use null when payeeEmail or when is absent.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        payeeName: { type: "string" },
        payeeEmail: { type: ["string", "null"] },
        amount: { type: "string", description: "Decimal amount such as 150.00" },
        currency: { type: "string", enum: ["GBP", "USD", "EUR"] },
        purpose: { type: "string" },
        when: { type: ["string", "null"] },
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
  "Copy each source quote character for character from the request. Use an empty string when a quote is absent.",
  "Do not invent an email. payeeEmail and when are null when the request does not contain them.",
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

export function readOpenAIMaxCalls(env: Record<string, string | undefined>): number {
  const raw = env.OPENAI_MAX_CALLS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_OPENAI_MAX_CALLS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_OPENAI_MAX_CALLS;
  return Math.floor(parsed);
}

function openAIConfig(env: Record<string, string | undefined>): RemoteConfig {
  const model = env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
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
    note: `Configured for OpenAI chat completions. Requested model ${model}. A model id is recorded only after OpenAI answers.`,
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
    note: `Configured for Cloudflare Workers AI model ${model}. A model id is recorded only after that API answers.`,
  };
}

export function buildChatCompletionBody(config: RemoteConfig) {
  return {
    model: config.model,
    temperature: 0,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    parallel_tool_calls: false,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "" },
    ],
    tools: [TOOL],
    tool_choice: { type: "function", function: { name: "propose_payment" } },
  };
}

export function createAgent(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Agent {
  const config = resolveAiConfig(env);
  let openAICalls = 0;
  const openAIMaxCalls = readOpenAIMaxCalls(env);
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
        if (config.kind === "openai") {
          if (openAICalls >= openAIMaxCalls) {
            throw new Error(
              `OpenAI call cap of ${openAIMaxCalls} is reached. This request did not call the model.`,
            );
          }
          openAICalls += 1;
        }
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
  const body = buildChatCompletionBody(config);
  body.messages[1] = { role: "user", content: text };
  const response = await fetchImpl(config.url, {
    method: "POST",
    headers: config.headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const errBody = (await response.json()) as { error?: { message?: string } };
      if (errBody?.error?.message) detail = `: ${String(errBody.error.message).slice(0, 240)}`;
    } catch {
      detail = "";
    }
    throw new Error(`${config.provider} returned HTTP ${response.status}${detail}`);
  }

  const payload = (await response.json()) as {
    model?: string;
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
  const reportedModel = payload.model?.trim() || config.model;
  const providerName = config.provider === "openai" ? "OpenAI" : "Cloudflare Workers AI";
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
      model: reportedModel,
      note: `${providerName} returned model ${reportedModel} from one chat completions call with tool propose_payment. Requested model was ${config.model}.`,
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
