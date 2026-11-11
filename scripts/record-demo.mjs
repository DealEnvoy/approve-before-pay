import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = process.env.DEMO_BASE || "http://127.0.0.1:4317";
const outDir = path.resolve("demo");
const rawDir = path.join(outDir, "raw");
fs.mkdirSync(rawDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: rawDir, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
const video = page.video();

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.getByRole("heading", { name: "Approve before Pay" }).waitFor();
const banner = await page.getByTestId("mode-banner").innerText();
fs.writeFileSync(path.join(outDir, "mode.json"), JSON.stringify({ banner, base, at: new Date().toISOString() }, null, 2));
await page.waitForTimeout(12000);

await page.getByTestId("sample-plumber").click();
await page.getByTestId("sheet").waitFor();
await page.waitForFunction(() => document.querySelector('[data-testid="status-stamp"]')?.textContent?.includes("Waiting"));
await page.waitForTimeout(16000);
await page.screenshot({ path: path.join(outDir, "01-proposal.png") });

await page.getByTestId("capture-attempt").click();
await page.getByTestId("capture-result").waitFor();
await page.locator(".sheet-wrap").evaluate((element) => {
  element.scrollTop = 0;
});
await page.locator(".log").evaluate((element) => {
  element.scrollTop = element.scrollHeight;
});
await page.waitForTimeout(12000);
await page.screenshot({ path: path.join(outDir, "02-capture-refused.png") });

await page.getByTestId("approve-name").fill("Isaac Adekunle");
await page.waitForTimeout(1200);
await page.getByTestId("approve-note").fill("I checked the payee, the £150 amount, and the words in the request.");
await page.waitForTimeout(1200);
const boxes = page.getByRole("checkbox");
const count = await boxes.count();
for (let index = 0; index < count; index += 1) {
  await boxes.nth(index).check();
  await page.waitForTimeout(700);
}
await page.waitForTimeout(1500);
await page.getByTestId("approve-submit").click();
await page.waitForFunction(() => document.querySelector('[data-testid="status-stamp"]')?.textContent?.includes("Approved"));
await page.locator(".sheet-wrap").evaluate((element) => {
  element.scrollTop = 0;
});
await page.waitForTimeout(8000);

await page.getByTestId("capture-submit").click();
await page.waitForFunction(() => document.querySelector('[data-testid="status-stamp"]')?.textContent?.includes("Captured"));
await page.locator(".sheet-wrap").evaluate((element) => {
  element.scrollTop = 0;
});
await page.locator(".log").evaluate((element) => {
  element.scrollTop = element.scrollHeight;
});
await page.waitForTimeout(12000);
await page.screenshot({ path: path.join(outDir, "03-captured.png") });
await page.waitForTimeout(4000);

await context.close();
await browser.close();
if (video) {
  const recorded = await video.path();
  fs.copyFileSync(recorded, path.join(rawDir, "demo.webm"));
}
console.log(JSON.stringify({ banner, screenshots: ["demo/01-proposal.png", "demo/02-capture-refused.png", "demo/03-captured.png"] }));
