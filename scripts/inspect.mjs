// Read-only look at the live database, run from the "Inspect" GitHub workflow. Nothing is ever written.
// Run it from the Actions tab, or push a one-line inspect-request.txt (e.g. "hand 3") to the inspect branch.
//
// ACTION:
//   hand    TARGET = hand number. The hand's categories, its admin stats (roundStats), its leaderboard totals,
//           and every player's play of it: ranking, each round's multiplier, marks and picks, times.
//   player  TARGET = player ID. Their profile (name, source, stats) and a line per hand played.
//   doc     TARGET = a document path (e.g. roundStats/3) prints it; a collection path (e.g. players) lists its IDs.
//
// The repo is public, so run pages are too. To keep answers off them, the answer key (handKeys) and dealt rounds
// (playSecrets) can't be read, and answer text and fun facts are left out of plays. Picks are shown by prompt
// instead: "Volvo → Kia" means the player gave Volvo the answer that belongs to Kia.
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

// From the Run workflow form, or (on a push to the inspect branch) a one-line request file: "<action> <target>".
let ACTION = (process.env.ACTION || "").trim(), TARGET = (process.env.TARGET || "").trim();
if (process.env.REQUEST_FILE) {
  const fs = await import("node:fs");
  [ACTION = "", TARGET = ""] = fs.readFileSync(process.env.REQUEST_FILE, "utf8").trim().split(/\s+/, 2);
}
TARGET = TARGET.replace(/^\/+|\/+$/g, "");
const BLOCKED = ["handKeys", "playSecrets"];

const out = [];
const say = (s = "") => { out.push(s); console.log(s); };
const stop = msg => { console.log("::error::" + msg.replace(/%/g, "%25")); process.exit(1); };
process.on("unhandledRejection", e => stop(String((e && e.message) || e)));
if (!TARGET) stop("Fill in the target.");

initializeApp({ projectId: "strong-suit" });
const db = getFirestore();

// Timestamps as readable UTC times; answer text and facts removed.
function clean(v, key = "") {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(x => clean(x));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (key === "review" && (k === "answers" || k === "fact")) continue;
      o[k] = clean(x, k);
    }
    return o;
  }
  return v;
}
const iso = t => (t instanceof Timestamp ? t.toDate().toISOString().replace(".000Z", "Z") : "–");
const secs = ms => (Number.isFinite(ms) ? (ms / 1000).toFixed(1) + "s" : "–");

function roundLine(name, x) {
  const picks = x.review && x.review.prompts && x.review.chosen
    ? x.review.prompts.map((p, i) => {
        const c = x.review.chosen[i];
        return x.marks && x.marks[i] ? `${p} ✓` : `${p} → ${c === null || c === undefined ? "no answer" : x.review.prompts[c]}`;
      }).join(" · ")
    : `marks ${JSON.stringify(x.marks)}`;
  return `  ${name}: slot ${x.slot} "${x.label}" ×${x.mult} · ${x.correct}/6 · server ${secs(x.serverMs)}, phone ${secs(x.timeMs)}${x.late ? " · LATE" : ""}\n      ${picks}`;
}

async function hand() {
  const n = Number(TARGET);
  if (!Number.isInteger(n) || n < 1) stop("Target must be a hand number.");
  const [h, rs, lb] = await Promise.all([db.doc(`hands/${n}`).get(), db.doc(`roundStats/${n}`).get(), db.doc(`leaderboards/${n}`).get()]);
  if (!h.exists) stop(`Hand ${n} doesn't exist.`);
  const cats = h.get("categories") || [];
  say(`Hand ${n} · ${h.get("date")} · opens ${iso(h.get("opensAt"))}`);
  cats.forEach(c => say(`  slot ${c.slot}: ${c.categoryId} "${c.label}" (${c.family})`));
  say();
  say("roundStats (what the admin page shows):");
  say(rs.exists ? JSON.stringify(clean(rs.data()), null, 1) : "  none");
  say();
  say("Leaderboard: " + (lb.exists ? `${lb.get("players") || 0} listed, total ${lb.get("totalScore") || 0}` : "none"));
  say();

  // every player's play of this hand (no collection-group index needed)
  const refs = await db.collection("players").listDocuments();
  const plays = [];
  for (let i = 0; i < refs.length; i += 300) {
    const chunk = refs.slice(i, i + 300);
    const snaps = await db.getAll(...chunk.map(r => r.collection("plays").doc(String(n))));
    snaps.forEach((s, k) => s.exists && plays.push({ uid: chunk[k].id, p: s.data() }));
  }
  say(`Plays: ${plays.length} (of ${refs.length} player profiles)`);
  const names = await Promise.all(plays.map(x => db.doc(`players/${x.uid}`).get().then(s => (s.exists ? s.get("name") : "?"))));
  plays.forEach(({ uid, p }, i) => {
    const pc = p.categories || cats;
    const lbl = s => (pc[s] ? `${s} "${pc[s].label}"` : String(s));
    say();
    say(`Player ${uid} "${names[i]}" · ${p.status} · started ${iso(p.startedAt)} · finished ${iso(p.finishedAt)}`);
    say(`  ranking (strongest first): ${(p.ranking || []).map(lbl).join(", ")}`);
    say(`  play order: ${(p.order || []).map(lbl).join(", ")} · skipped ${lbl(p.skipped)}`);
    if (p.status === "done") say(`  score ${p.score} · best ${p.best} · aware ${p.aware}% · time ${secs(p.time)}`);
    if (JSON.stringify((p.categories || []).map(c => c.categoryId)) !== JSON.stringify(cats.map(c => c.categoryId)))
      say("  ⚠ this play's category order differs from the hand's current order");
    Object.keys(p.rounds || {}).sort().forEach(k => say(roundLine("round " + k, p.rounds[k])));
    if (p.bonus) say(roundLine("bonus", p.bonus));
    if (p.current) say(`  in play now: round ${p.current.key}, slot ${p.current.slot}`);
  });
}

async function player() {
  const s = await db.doc(`players/${TARGET}`).get();
  if (!s.exists) stop(`No player with ID ${TARGET}.`);
  const p = s.data();
  say(`Player ${TARGET} "${p.name}" · joined ${iso(p.createdAt)} · groups ${(p.groupIds || []).length} · listed ${!!p.listed}`);
  say("source: " + JSON.stringify(clean(p.source || null)));
  say("stats: " + JSON.stringify(clean(p.stats || {}), null, 1));
  const plays = await s.ref.collection("plays").get();
  say();
  say(`Hands played: ${plays.size}`);
  plays.docs.sort((a, b) => Number(a.id) - Number(b.id)).forEach(d => {
    const x = d.data();
    const rounds = Object.keys(x.rounds || {}).sort().map(k => `${x.rounds[k].correct}×${x.rounds[k].mult}`).join(" ");
    say(`  Hand ${d.id}: ${x.status} · score ${x.score ?? "–"} · rounds ${rounds || "–"}${x.bonus ? ` · bonus ${x.bonus.correct}/6` : ""}`);
  });
}

async function doc() {
  if (BLOCKED.includes(TARGET.split("/")[0])) stop(`${TARGET.split("/")[0]} holds answers, so it isn't shown on this public page.`);
  const parts = TARGET.split("/");
  if (parts.length % 2 === 0) {
    const s = await db.doc(TARGET).get();
    if (!s.exists) stop(`${TARGET} doesn't exist.`);
    say(JSON.stringify(clean(s.data()), null, 1));
    const subs = await s.ref.listCollections();
    if (subs.length) say("subcollections: " + subs.map(c => c.id).join(", "));
  } else {
    const refs = await db.collection(TARGET).listDocuments();
    say(`${TARGET}: ${refs.length} documents`);
    refs.slice(0, 200).forEach(r => say("  " + r.id));
    if (refs.length > 200) say("  …");
  }
}

const run = { hand, player, doc }[ACTION];
if (!run) stop(`Unknown action "${ACTION}".`);
await run();

if (process.env.GITHUB_STEP_SUMMARY) {
  const fs = await import("node:fs");
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Inspect: ${ACTION} ${TARGET}\n\n\`\`\`text\n${out.join("\n")}\n\`\`\`\n`);
}
