// Loads the live home page in Chromium and times it. Blocks the getMe function so no visitor profile is created.
import { chromium } from "playwright";
const URL = "https://strongsuitgame.com/";
const out = [];
const say = s => { out.push(s); console.log(s); };
const browser = await chromium.launch();
async function load(ctx, label, detail) {
  const page = await ctx.newPage();
  await page.route(/cloudfunctions\.net\/getMe|\/getMe$/, r => r.abort());
  const reqs = []; const t0 = Date.now();
  page.on("requestfinished", async r => { const t = r.timing(); reqs.push({ url: r.url(), method: r.method(), start: t.startTime - t0, end: Date.now() - t0 }); });
  page.on("requestfailed", r => reqs.push({ url: r.url(), method: r.method(), end: Date.now() - t0, failed: true }));
  await page.goto(URL, { waitUntil: "commit" });
  try {
    await page.waitForFunction(() => { const h = document.getElementById("home"); const t = document.getElementById("homeTitle"); return h && !h.hidden && t && /Hand #|Coming/.test(t.textContent); }, null, { timeout: 30000 });
    say(`${label}: home ready after ${Date.now() - t0} ms, ${reqs.length} requests so far`);
  } catch { say(`${label}: home not ready after 30s`); }
  if (detail) {
    const short = u => u.replace(/^https:\/\//, "").replace(/\?.*$/, "").slice(0, 90);
    reqs.sort((a, b) => a.end - b.end).forEach(r => say(`   ${String(Math.round(r.end)).padStart(5)} ms  ${r.method.padEnd(7)} ${r.failed ? "(blocked) " : ""}${short(r.url)}`));
  }
  await page.close();
}
for (let i = 1; i <= 3; i++) { const ctx = await browser.newContext(); await load(ctx, `First visit #${i}`, i === 3); await ctx.close(); }
const ctx = await browser.newContext();
await load(ctx, "Seed", false);
for (let i = 1; i <= 2; i++) await load(ctx, `Return visit #${i}`, i === 2);
await browser.close();
const fs = await import("node:fs"); fs.writeFileSync("boot.txt", out.join("\n"));
