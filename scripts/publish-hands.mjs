// Publishes hands from the "Strong Suit category bank" Sheet to Firestore.
// Runs in GitHub Actions ("Publish hands"), signed in as the deploy service account,
// which needs Viewer access to the Sheet. Answers go only to server-only documents.
//
// Env: SHEET_ID (required), STATUSES (default "Checked"), LAUNCH_DATE (YYYY-MM-DD, overrides the Sheet),
//      FORCE=1 to republish hands that are already open, DRY_RUN=1 to check without writing.
import { GoogleAuth } from "google-auth-library";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { handDate, opensAtMs } from "../functions/lib/game.js";

const SHEET_ID = process.env.SHEET_ID;
const STATUSES = (process.env.STATUSES || "Checked").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const FORCE = process.env.FORCE === "1";
const DRY = process.env.DRY_RUN === "1";
if (!SHEET_ID) throw new Error("SHEET_ID is not set");

process.on("unhandledRejection", e => { console.log("::error::" + String(e && e.message || e).replace(/%/g, "%25")); process.exit(1); });
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
const client = await auth.getClient();
async function values(range, render = "FORMATTED_VALUE") {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueRenderOption=${render}&dateTimeRenderOption=SERIAL_NUMBER`;
  const r = await client.request({ url });
  return r.data.values || [];
}

// Launch date: the override, or Summary!B10 (a date cell).
let launch = process.env.LAUNCH_DATE || "";
if (!launch) {
  const v = (await values("Summary!B10", "UNFORMATTED_VALUE"))[0]?.[0];
  if (typeof v === "number") launch = new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) launch = v;
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(launch)) throw new Error("No launch date: fill in Summary!B10 or pass LAUNCH_DATE");

const rows = await values("Hands!A2:Z");
const hands = new Map();
for (const r of rows) {
  const [hand, , cat, theme, label, family] = r;
  const status = (r[21] || "").trim().toLowerCase();
  if (!hand || !cat || !STATUSES.includes(status)) continue;
  const n = Number(hand);
  if (!Number.isInteger(n) || n < 1) continue;
  const prompts = [6, 8, 10, 12, 14, 16].map(i => (r[i] || "").trim());
  const answers = [7, 9, 11, 13, 15, 17].map(i => (r[i] || "").trim());
  const warnings = (r[25] || "").trim();
  if (!hands.has(n)) hands.set(n, []);
  hands.get(n).push({ categoryId: cat, themeId: theme || "", label, family, prompts, answers, fact: (r[18] || "").trim(), src: (r[19] || "").trim(), warnings });
}

const problems = [];
function check(n, rounds) {
  if (rounds.length !== 5) return `has ${rounds.length} rounds marked ${STATUSES.join("/")}`;
  if (new Set(rounds.map(x => x.family)).size !== 5) return "repeats a family";
  for (const x of rounds) {
    if (!x.label || !x.family) return `${x.categoryId} has no label or family`;
    if (x.prompts.some(p => !p) || x.answers.some(a => !a)) return `${x.label} needs six prompts and six answers`;
    if (new Set(x.answers).size !== 6) return `${x.label} repeats an answer`;
    if (!x.fact) return `${x.label} has no fact`;
    if (x.warnings) return `${x.label}: ${x.warnings}`;
  }
  return null;
}

initializeApp({ projectId: "strong-suit" });
const db = getFirestore();
let published = 0, skipped = 0;
const now = Date.now();
for (const [n, rounds] of [...hands.entries()].sort((a, b) => a[0] - b[0])) {
  const why = check(n, rounds);
  if (why) { problems.push(`Hand ${n}: ${why}`); continue; }
  const opensAt = opensAtMs(launch, n);
  const ref = db.doc(`hands/${n}`);
  if (!FORCE && opensAt <= now) {
    const cur = await ref.get();
    if (cur.exists) { skipped++; continue; }   // never change a hand people may be playing
  }
  if (DRY) { published++; continue; }
  const b = db.batch();
  b.set(ref, {
    number: n, date: handDate(launch, n), opensAt: Timestamp.fromMillis(opensAt),
    categories: rounds.map((x, slot) => ({ slot, categoryId: x.categoryId, themeId: x.themeId, label: x.label, family: x.family })),
  });
  b.set(db.doc(`handKeys/${n}`), { rounds: rounds.map(x => ({ prompts: x.prompts, answers: x.answers, fact: x.fact, src: x.src })) });
  await b.commit();
  published++;
}
if (!DRY) await db.doc("config/app").set({ launchDate: launch, updatedAt: Timestamp.now() }, { merge: true });

console.log(`Launch date ${launch}. ${DRY ? "Would publish" : "Published"} ${published} hands; left ${skipped} open hands unchanged.`);
if (problems.length) console.log("Not published:\n  " + problems.join("\n  "));
if (process.env.GITHUB_ACTIONS) {   // annotations show on the run page
  console.log(`::notice::Launch date ${launch}. ${DRY ? "Would publish" : "Published"} ${published} hands; ${skipped} open hands left unchanged.`);
  problems.forEach(p => console.log("::warning::" + p.replace(/%/g, "%25")));
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const fs = await import("node:fs");
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Publish hands\nLaunch date **${launch}** · ${DRY ? "would publish" : "published"} **${published}** · unchanged (already open) **${skipped}**\n` +
    (problems.length ? "\n**Not published**\n" + problems.map(p => `- ${p}`).join("\n") + "\n" : ""));
}
