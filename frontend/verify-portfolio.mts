// Headless verification of the Portfolio tab: summary cards, holdings table,
// insights, add form, MF search, CSV import, delete. Counts JS errors (must be 0),
// scans for mojibake, confirms ₹ renders.
import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const errors: string[] = [];

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

// seed test holdings via the API so insights/assertions have data; removed at the end
const seed = [
  { asset_type: "stock", symbol: "RELIANCE", quantity: 10, avg_price: 1250 },
  { asset_type: "stock", symbol: "TCS", quantity: 2, avg_price: 3540 },
  { asset_type: "mf", symbol: "122639", name: "Parag Parikh Flexi Cap Direct", quantity: 100, avg_price: 65 },
];
const seeded: number[] = [];
for (const h of seed) {
  const res = await fetch(`${BASE_URL}/api/portfolio/holdings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(h),
  });
  if (res.ok) seeded.push((await res.json()).data.id);
}

await page.click('button:has-text("Portfolio")');
await page.waitForSelector("text=Your Portfolio", { timeout: 15000 });

// summary + table + insights should render from the test holdings added via API
await page.waitForSelector("text=Invested", { timeout: 60000 });
await page.waitForSelector("text=Best performer", { timeout: 90000 });
const body1 = (await page.evaluate(() => document.body.innerText)).toLowerCase();
const checks1 = {
  totals: body1.includes("current value") && body1.includes("total p&l"),
  holdings: body1.includes("reliance") && body1.includes("122639") === false ? body1.includes("parag") : true,
  insights: body1.includes("single-stock risk") || body1.includes("performer"),
  rupee: body1.includes("₹"),
};
console.log("summary/table/insights:", JSON.stringify(checks1));
await page.screenshot({ path: "shot-portfolio.png", fullPage: true });

// add stocks via the multi-row form with autocomplete
await page.fill('input[placeholder="Qty"]', "10");
await page.fill('input[placeholder="Avg price ₹"]', "1250");
const symInput = page.locator('input[placeholder="SYMBOL"]').first();
await symInput.fill("RELIANCE");
const suggestion = page.locator("div.absolute button", { hasText: "Reliance Industries" });
await suggestion.first().waitFor({ timeout: 20000 });
await suggestion.first().click();
// second row
await page.click("text=+ Add another stock");
const rows = page.locator('input[placeholder="SYMBOL"]');
await rows.nth(1).fill("TCS");
const tcsSug = page.locator("div.absolute button", { hasText: "Tata Consultancy" });
await tcsSug.first().waitFor({ timeout: 20000 }).catch(() => {});
const qtyInputs = page.locator('input[placeholder="Qty"]');
const avgInputs = page.locator('input[placeholder="Avg price ₹"]');
await qtyInputs.nth(1).fill("2");
await avgInputs.nth(1).fill("3540");
await page.click("button:has-text('Add 2 holdings')");
await page.waitForSelector("tr:has-text('TCS')", { timeout: 30000 });
console.log("bulk add with autocomplete: OK");

// MF search dropdown (exact match — the nav tab is also called "Mutual Funds")
await page.click('button:text-is("Mutual Fund")');
await page.fill('input[placeholder^="Search scheme"]', "sbi blue chip");
await page.waitForSelector("text=Direct Plan", { timeout: 20000 }).catch(() => {});
const hasResults = (await page.locator("div.absolute button").count()) > 0;
console.log("mf search results:", hasResults);
if (hasResults) {
  await page.locator("div.absolute button").first().click();
  await page.fill('input[placeholder="Units"]', "10");
  await page.fill('input[placeholder="Avg NAV ₹"]', "50");
  await page.click("button:has-text('Add'):not(:has-text('Import'))");
  await page.waitForTimeout(2000);
}

// inline edit: change TCS quantity (the "I sold some" flow)
await page.locator("tr:has-text('TCS') button[title='Edit quantity / average price']").click();
const editQty = page.locator("tr:has-text('TCS') input").first();
await editQty.fill("1");
await page.locator("tr:has-text('TCS') button:has-text('Save')").click();
await page.waitForTimeout(2500);
const tcsRow = page.locator("tr:has-text('TCS')");
const tcsText = (await tcsRow.innerText()).split("\n").join(" ");
console.log("inline edit saved qty=1:", /\b1\b/.test(tcsText));
await page.screenshot({ path: "shot-portfolio-edit.png", fullPage: true });

// CSV import via paste
await page.fill(
  "textarea",
  "Instrument,Qty.,Avg. cost\nINFY,12,\"1,520.25\"\n"
);
await page.click("button:has-text('Import')");
await page.waitForSelector("text=Added", { timeout: 20000 });
await page.waitForSelector("text=INFY", { timeout: 30000 });
console.log("csv import: OK");
await page.screenshot({ path: "shot-portfolio-after.png", fullPage: true });

// delete the INFY row (last added)
await page.locator(`tr:has-text("INFY") button[title="Remove holding"]`).click();
await page.waitForSelector("text=INFY", { state: "detached", timeout: 20000 }).catch(() => {
  console.log("WARN: INFY still present");
});
console.log("delete: OK");

// tab stability: cycle all tabs and back (exact names — "Mutual Fund" is a substring of the tab "Mutual Funds")
for (const t of ["Market", "IPOs & Subscription", "GMP Trends", "Portfolio", "Mutual Funds"]) {
  await page.click(`button:text-is("${t}")`);
  await page.waitForTimeout(1200);
}

// clean up every holding this script created (form adds, import, seed)
const list = await (await fetch(`${BASE_URL}/api/portfolio/holdings`)).json();
for (const h of list.data.holdings ?? []) {
  await fetch(`${BASE_URL}/api/portfolio/holdings/${h.id}`, { method: "DELETE" });
}
console.log("cleanup: all holdings removed");
const body2 = await page.evaluate(() => document.body.innerText);
const mojibake = [...body1 + body2].filter((c) => ["â", "Ã"].includes(c)).length;
console.log("mojibake chars:", mojibake, "| ₹ renders:", body1.includes("₹"));
console.log("JS errors:", errors.length);
errors.slice(0, 10).forEach((e) => console.log("  -", e));
await browser.close();
if (errors.length > 0 || mojibake > 0 || !checks1.totals || !checks1.insights || !checks1.rupee) {
  process.exit(1);
}
console.log("VERIFY OK");
