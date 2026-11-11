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

  it("selects OpenAI or Cloudflare when those credentials exist", () => {
    expect(resolveAiConfig({ OPENAI_API_KEY: "test", OPENAI_MODEL: "gpt-4o-mini" })).toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini",
      url: "https://api.openai.com/v1/chat/completions",
    });
    expect(
      resolveAiConfig({
        CLOUDFLARE_ACCOUNT_ID: "acc",
        CLOUDFLARE_API_TOKEN: "tok",
        CLOUDFLARE_AI_MODEL: "@cf/meta/llama-3.1-8b-instruct",
      }),
    ).toMatchObject({
      provider: "cloudflare",
      model: "@cf/meta/llama-3.1-8b-instruct",
    });
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
