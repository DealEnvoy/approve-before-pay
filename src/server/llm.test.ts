import { describe, expect, it, vi } from "vitest";

import { createAgent, parseToolArguments, resolveAiConfig } from "./llm";

const TOOL_ARGS = {
  payeeName: "Plumber",
  payeeEmail: null,
  amount: "150.00",
  currency: "GBP",
  purpose: "Deposit to book a boiler service",
  when: "next Tuesday",
  payeeNameQuote: "Plumber",
  payeeEmailQuote: "",
  amountQuote: "£150",
  currencyQuote: "£",
  purposeQuote: "deposit to book a boiler service",
  whenQuote: "next Tuesday",
};

describe("AI provider selection", () => {
  it("uses the offline extractor when no model key is set", async () => {
    const config = resolveAiConfig({});
    expect(config.kind).toBe("offline");
    const agent = createAgent({});
    expect(agent.describe().provider).toBe("offline_fallback");
    expect(agent.describe().model).toBe("offline-rules-v1");
    const extracted = await agent.extract("Plumber needs a £150 deposit to book a boiler service next Tuesday");
    expect(extracted.proposal.amount).toBe("150.00");
    expect(extracted.ai.provider).toBe("offline_fallback");
    expect(extracted.ai.note.toLowerCase()).toContain("not by a language model");
  });

  it("prefers Workers AI, then OpenAI, and honours CF_AI_MODEL", () => {
    expect(resolveAiConfig({ OPENAI_API_KEY: "test", OPENAI_MODEL: "gpt-4o-mini" })).toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini",
      url: "https://api.openai.com/v1/chat/completions",
    });
    expect(
      resolveAiConfig({
        OPENAI_API_KEY: "test",
        CLOUDFLARE_ACCOUNT_ID: "acc",
        CLOUDFLARE_API_TOKEN: "tok",
      }),
    ).toMatchObject({
      provider: "cloudflare",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      url: "https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    });
    const overridden = resolveAiConfig({
      CLOUDFLARE_ACCOUNT_ID: "acc",
      CLOUDFLARE_API_TOKEN: "tok",
      CF_AI_MODEL: "@cf/meta/llama-3.1-8b-instruct",
    });
    expect(overridden.kind).toBe("cloudflare");
    if (overridden.kind === "cloudflare") expect(overridden.model).toBe("@cf/meta/llama-3.1-8b-instruct");
  });

  it("calls Workers AI function calling and records that model name", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      );
      const body = JSON.parse(String(init?.body));
      expect(body.tools[0].name).toBe("propose_payment");
      expect(body.tools[0].function).toBeUndefined();
      expect(body.max_tokens).toBe(500);
      expect(String((init?.headers as Record<string, string>).Authorization)).toBe("Bearer cf-token");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { response: "", tool_calls: [{ name: "propose_payment", arguments: TOOL_ARGS }] },
        }),
      };
    });
    const agent = createAgent(
      { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "cf-token", AI_MAX_CALLS: "1" },
      fetchImpl as unknown as typeof fetch,
    );
    const extracted = await agent.extract("Plumber needs a £150 deposit to book a boiler service next Tuesday");
    expect(extracted.ai.provider).toBe("cloudflare");
    expect(extracted.ai.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(extracted.ai.note).toContain("function calling");
    expect(extracted.proposal.amount).toBe("150.00");

    const blocked = await agent.extract("Plumber needs a £150 deposit to book a boiler service next Tuesday");
    expect(blocked.ai.provider).toBe("offline_fallback");
    expect(blocked.ai.model).toBe("offline-rules-v1");
    expect(blocked.ai.note).toContain("did not call the model");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses strict JSON for a Workers AI model without function calling", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools).toBeUndefined();
      expect(body.messages[0].content).toContain("JSON");
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { response: "```json\n" + JSON.stringify(TOOL_ARGS) + "\n```" } }),
      };
    });
    const agent = createAgent(
      {
        CLOUDFLARE_ACCOUNT_ID: "acc",
        CLOUDFLARE_API_TOKEN: "cf-token",
        CF_AI_MODEL: "@cf/baai/bge-base-en-v1.5",
      },
      fetchImpl as unknown as typeof fetch,
    );
    const extracted = await agent.extract("Plumber needs a £150 deposit to book a boiler service next Tuesday");
    expect(extracted.ai.provider).toBe("cloudflare");
    expect(extracted.ai.model).toBe("@cf/baai/bge-base-en-v1.5");
    expect(extracted.ai.note).toContain("strict JSON");
    expect(extracted.proposal.payeeName).toBe("Plumber");
  });

  it("accepts JSON text when a function calling model does not return a tool call", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { response: JSON.stringify(TOOL_ARGS), tool_calls: [] } }),
    }));
    const agent = createAgent(
      { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "cf-token" },
      fetchImpl as unknown as typeof fetch,
    );
    const extracted = await agent.extract("Plumber needs a £150 deposit to book a boiler service next Tuesday");
    expect(extracted.ai.note).toContain("strict JSON");
    expect(extracted.ai.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });

  it("calls OpenAI chat completions with strict tool calling and records the returned model", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.max_completion_tokens).toBe(500);
      expect(body.parallel_tool_calls).toBe(false);
      expect(body.tool_choice).toEqual({ type: "function", function: { name: "propose_payment" } });
      expect(body.tools[0].function.strict).toBe(true);
      expect(body.tools[0].function.parameters.additionalProperties).toBe(false);
      expect(body.tools[0].function.parameters.required).toContain("payeeEmail");
      expect(String(init?.headers && (init.headers as Record<string, string>).Authorization)).toBe("Bearer sk-test");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: "gpt-4o-mini-2024-07-18",
          choices: [{ message: { tool_calls: [{ function: { name: "propose_payment", arguments: JSON.stringify(TOOL_ARGS) } }] } }],
        }),
      };
    });
    const agent = createAgent(
      { OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "gpt-4o-mini", OPENAI_MAX_CALLS: "1" },
      fetchImpl as unknown as typeof fetch,
    );
    const extracted = await agent.extract("Plumber needs a £150 deposit to book a boiler service next Tuesday");
    expect(extracted.ai.provider).toBe("openai");
    expect(extracted.ai.model).toBe("gpt-4o-mini-2024-07-18");
    expect(extracted.ai.note).toContain("gpt-4o-mini-2024-07-18");
    expect(extracted.proposal.amount).toBe("150.00");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const blocked = await agent.extract("Plumber needs a £150 deposit to book a boiler service next Tuesday");
    expect(blocked.ai.provider).toBe("offline_fallback");
    expect(blocked.ai.model).toBe("offline-rules-v1");
    expect(blocked.ai.note).toContain("did not call the model");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("parses a propose_payment tool call", () => {
    const parsed = parseToolArguments(
      JSON.stringify({
        payeeName: "Plumber",
        payeeEmail: "",
        amount: "150",
        currency: "GBP",
        purpose: "Deposit to book a boiler service",
        when: "next Tuesday",
        amountQuote: "£150",
        payeeNameQuote: "Plumber",
        currencyQuote: "£",
        purposeQuote: "deposit to book a boiler service",
        whenQuote: "next Tuesday",
        payeeEmailQuote: "",
      }),
    );
    expect(parsed.payeeName).toBe("Plumber");
    expect(parsed.amount).toBe("150");
  });
});
