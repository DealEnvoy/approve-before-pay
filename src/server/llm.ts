import { z } from "zod";

import { normalizeAmountInput } from "@/lib/money";
import { OFFLINE_NO_KEY_NOTE, offlineExtract, type OfflineExtraction } from "@/lib/offline-agent";
import type { AiInfo, Currency } from "@/lib/types";
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
const DEFAULT_WORKERS_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DEFAULT_MAX_CALLS = 20;
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
  "when is the timing phrase, or null.",
].join(" ");

const JSON_SYSTEM_PROMPT = [
  "You prepare one payment proposal from a plain language request.",
  "Reply with one JSON object and no markdown.",
  "Fields: payeeName, payeeEmail, amount, currency, purpose, when, payeeNameQuote, payeeEmailQuote, amountQuote, currencyQuote, purposeQuote, whenQuote.",
  "currency is GBP, USD, or EUR. amount uses two decimal places.",
  "Quotes are exact copies from the request. Use an empty string when a quote is absent.",
  "payeeEmail and when are null when the request does not contain them.",
  "If several amounts appear, choose the deposit or the up front figure.",
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
  if (hasCloudflare) return cloudflareConfig(env);
  if (hasOpenAI) return openAIConfig(env);
  return { kind: "offline", note: OFFLINE_NO_KEY_NOTE };
}

export function readMaxCalls(env: Record<string, string | undefined>): number {
  const raw = env.AI_MAX_CALLS ?? env.OPENAI_MAX_CALLS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_CALLS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_CALLS;
  return Math.floor(parsed);
}

export function readOpenAIMaxCalls(env: Record<string, string | undefined>): number {
  return readMaxCalls(env);
}

export function workersModelName(env: Record<string, string | undefined>): string {
  return env.CF_AI_MODEL?.trim() || env.CLOUDFLARE_AI_MODEL?.trim() || DEFAULT_WORKERS_MODEL;
}

export function modelSupportsFunctionCalling(model: string): boolean {
  const name = model.toLowerCase();
  if (name.includes("llama-3") && name.includes("instruct")) return true;
  if (name.includes("hermes-2-pro")) return true;
  return false;
}

export function workersRunUrl(accountId: string, model: string): string {
  if (!/^[@a-zA-Z0-9_./-]+$/.test(model)) {
    throw new GateError("BAD_MODEL", 500, "CF_AI_MODEL contains characters that are not allowed in a Workers AI model name.");
  }
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
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
  const model = workersModelName(env);
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  const mode = modelSupportsFunctionCalling(model) ? "function calling" : "strict JSON";
  return {
    kind: "cloudflare",
    provider: "cloudflare",
    model,
    url: workersRunUrl(accountId, model),
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    note: `Configured for Cloudflare Workers AI model ${model} (${mode}). The audit names this model only after Workers AI answers.`,
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
  let remoteCalls = 0;
  const maxCalls = readMaxCalls(env);
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
        if (remoteCalls >= maxCalls) {
          const who = config.kind === "openai" ? "OpenAI" : "Workers AI";
          throw new Error(`${who} call cap of ${maxCalls} is reached. This request did not call the model.`);
        }
        remoteCalls += 1;
        if (config.kind === "openai") return await llmExtract(text, config, fetchImpl);
        return await workersExtract(text, config, fetchImpl);
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
  const reportedModel = payload.model?.trim() || config.model;
  return extractionFromParsed(parsed, {
    provider: "openai",
    model: reportedModel,
    note: `OpenAI returned model ${reportedModel} from one chat completions call with tool propose_payment. Requested model was ${config.model}.`,
  });
}

export function buildWorkersRunBody(model: string, text: string) {
  const messages = [
    { role: "system", content: modelSupportsFunctionCalling(model) ? SYSTEM_PROMPT : JSON_SYSTEM_PROMPT },
    { role: "user", content: text },
  ];
  if (!modelSupportsFunctionCalling(model)) {
    return { messages, max_tokens: MAX_COMPLETION_TOKENS };
  }
  return {
    messages,
    max_tokens: MAX_COMPLETION_TOKENS,
    tools: [
      {
        name: "propose_payment",
        description: TOOL.function.description,
        parameters: TOOL.function.parameters,
      },
    ],
  };
}

type WorkersToolCall = { name?: string; arguments?: unknown };
type WorkersResult = { response?: string; tool_calls?: WorkersToolCall[]; model?: string };

export function readWorkersResult(payload: unknown): WorkersResult {
  if (!payload || typeof payload !== "object") return {};
  const record = payload as { success?: boolean; errors?: Array<{ message?: string }>; result?: unknown };
  if (record.success === false) {
    const message = record.errors?.map((item) => item.message).filter(Boolean).join(" ") || "Workers AI reported failure";
    throw new Error(message);
  }
  const inner = record.result && typeof record.result === "object" && !Array.isArray(record.result) ? record.result : payload;
  const result = inner as WorkersResult & { tool_calls?: WorkersToolCall[] };
  const model = typeof (result as { model?: unknown }).model === "string" ? (result as { model: string }).model : undefined;
  return { response: typeof result.response === "string" ? result.response : undefined, tool_calls: result.tool_calls, model };
}

export async function workersExtract(text: string, config: RemoteConfig, fetchImpl: typeof fetch): Promise<Extraction> {
  const useTools = modelSupportsFunctionCalling(config.model);
  const response = await fetchImpl(config.url, {
    method: "POST",
    headers: config.headers,
    body: JSON.stringify(buildWorkersRunBody(config.model, text)),
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const errBody = (await response.json()) as { errors?: Array<{ message?: string }> };
      const message = errBody.errors?.map((item) => item.message).filter(Boolean).join(" ");
      if (message) detail = `: ${message.slice(0, 240)}`;
    } catch {
      detail = "";
    }
    throw new Error(`cloudflare returned HTTP ${response.status}${detail}`);
  }
  const payload = await response.json();
  const result = readWorkersResult(payload);
  const toolCall = result.tool_calls?.find((call) => call.name === "propose_payment") ?? result.tool_calls?.[0];
  let parsed: z.infer<typeof ProposeSchema>;
  let how: "function calling" | "strict JSON";
  if (useTools && toolCall?.arguments !== undefined) {
    parsed = parseToolArguments(toolCall.arguments);
    how = "function calling";
  } else if (result.response) {
    parsed = parseModelJson(result.response);
    how = "strict JSON";
  } else {
    throw new Error("Workers AI returned neither a propose_payment tool call nor JSON");
  }
  const reportedModel = result.model?.trim() || config.model;
  const requestedNote =
    reportedModel === config.model
      ? `One POST to /accounts/{account_id}/ai/run/${config.model}.`
      : `Requested model was ${config.model}. One POST to /accounts/{account_id}/ai/run/${config.model}.`;
  const extraction = extractionFromParsed(parsed, {
    provider: "cloudflare",
    model: reportedModel,
    note: `Cloudflare Workers AI ran ${reportedModel} with ${how}. ${requestedNote}`,
  });
  return extraction;
}

export function parseModelJson(text: string): z.infer<typeof ProposeSchema> {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Workers AI response was not JSON");
  return parseToolArguments(raw.slice(start, end + 1));
}

function extractionFromParsed(
  parsed: z.infer<typeof ProposeSchema>,
  ai: { provider: "openai" | "cloudflare"; model: string; note: string },
): Extraction {
  const amount = normalizeAmountInput(parsed.amount);
  if (!amount || Number(amount) <= 0) {
    throw new Error("the tool call did not include a usable amount");
  }
  return {
    proposal: {
      payeeName: parsed.payeeName.trim(),
      payeeEmail: cleanOptional(parsed.payeeEmail),
      amount,
      currency: parsed.currency as Currency,
      purpose: parsed.purpose.trim(),
      when: cleanOptional(parsed.when),
    },
    quotes: {
      payeeName: parsed.payeeNameQuote,
      payeeEmail: parsed.payeeEmailQuote,
      amount: parsed.amountQuote,
      currency: parsed.currencyQuote,
      purpose: parsed.purposeQuote,
      when: parsed.whenQuote,
    },
    ai,
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
