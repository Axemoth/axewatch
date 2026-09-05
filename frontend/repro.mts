import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost";

const browser = await chromium.launch();
const page = await browser.newPage();

const errors: string[] = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`[console.error] ${msg.text().slice(0, 800)}`);
});
page.on("pageerror", (err) => {
  errors.push(`[pageerror] ${err.message}\n${err.stack?.split("\n").slice(0, 8).join("\n")}`);
});

await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });

for (const label of ["IPOs & Subscription", "GMP Trends", "Market"]) {
  try {
    const btn = page.getByRole("button", { name: label });
    await btn.click({ timeout: 5000 });
    await page.waitForTimeout(3500);
    const len = await page.evaluate(() => document.getElementById("root")?.innerHTML.length ?? 0);
    console.log(`clicked "${label}" ok, root length=${len}`);
  } catch (e) {
    console.log(`FAILED clicking "${label}": ${(e as Error).message.split("\n")[0]}`);
    break;
  }
}

await page.screenshot({ path: "shot-final.png" });
console.log("errors captured:", errors.length);
for (const e of errors.slice(0, 8)) console.log("===\n" + e);

await browser.close();
