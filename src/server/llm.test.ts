import { describe, expect, it } from "vitest";

import { createAgent, parseToolArguments, resolveAiConfig } from "./llm";

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
