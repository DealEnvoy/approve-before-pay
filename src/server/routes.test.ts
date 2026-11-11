import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "abp-")), "store.json");
process.env.DATA_FILE = dataFile;
process.env.PAYPAL_MODE = "mock";
process.env.AI_PROVIDER = "offline";
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;
delete process.env.OPENAI_API_KEY;
delete process.env.CLOUDFLARE_ACCOUNT_ID;
delete process.env.CLOUDFLARE_API_TOKEN;

import { POST as createCase } from "@/app/api/cases/route";
import { POST as approveCase } from "@/app/api/cases/[id]/approve/route";
import { POST as captureCase } from "@/app/api/cases/[id]/capture/route";
import { resetService } from "@/server/service";

beforeAll(() => {
  resetService();
});

describe("HTTP approval gate", () => {
  it("returns 403 for capture before approval and 200 only after approval", async () => {
    const createdResponse = await createCase(jsonRequest("http://desk.local/api/cases", {
      text: "Plumber needs a £150 deposit to book a boiler service next Tuesday",
    }));
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json();
    expect(created.record.paypal.captureId).toBeNull();
    expect(created.record.status).toBe("proposed");

    const refusedResponse = await captureCase(
      jsonRequest(`http://desk.local/api/cases/${created.record.id}/capture`, { reviewerName: "Isaac Adekunle" }),
      { params: Promise.resolve({ id: created.record.id }) },
    );
    expect(refusedResponse.status).toBe(403);
    const refused = await refusedResponse.json();
    expect(refused.error.code).toBe("APPROVAL_REQUIRED");
    expect(refused.record.status).toBe("proposed");
    expect(refused.record.paypal.captureId).toBeNull();
    expect(refused.audits.some((event: { type: string }) => event.type === "capture_refused")).toBe(true);

    const approvedResponse = await approveCase(
      jsonRequest(`http://desk.local/api/cases/${created.record.id}/approve`, {
        reviewerName: "Isaac Adekunle",
        note: "Checked the amount and the quoted words.",
        acknowledgedRiskCodes: ["NEW_PAYEE", "MISSING_PAYEE_EMAIL"],
      }),
      { params: Promise.resolve({ id: created.record.id }) },
    );
    expect(approvedResponse.status).toBe(200);

    const capturedResponse = await captureCase(
      jsonRequest(`http://desk.local/api/cases/${created.record.id}/capture`, { reviewerName: "Isaac Adekunle" }),
      { params: Promise.resolve({ id: created.record.id }) },
    );
    expect(capturedResponse.status).toBe(200);
    const captured = await capturedResponse.json();
    expect(captured.record.status).toBe("captured");
    expect(captured.record.paypal.captureId.startsWith("MOCKCAP")).toBe(true);
  });
});

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
