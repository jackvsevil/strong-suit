// One-off: rebuild the bonus-round figures the admin page uses, from players' saved plays.
// Before 19 Oct 2026 the server kept only a total per bonus round, not which pairs were right, its time,
// or a per-subject total. This recount fills those in for every hand so far. It writes absolute values
// (not additions), so it's safe to run more than once. Run it after the server change is live.
// Plays deleted with an account aren't there to count, so a hand's bonus total can drop slightly.
// DRY_RUN=1 reports what would change without changing it.
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { bonusTally, countsInStats } from "../functions/lib/game.js";

const DRY = process.env.DRY_RUN === "1";
const stop = msg => { console.log("::error::" + String(msg).replace(/%/g, "%25")); process.exit(1); };
process.on("unhandledRejection", e => stop((e && e.message) || e));

initializeApp({ projectId: "strong-suit" });
const db = getFirestore();
const add = n => n;   // plain numbers here; the live server uses increments

const plays = await db.collectionGroup("plays").get();
const hands = {}, families = {};
let counted = 0;
for (const d of plays.docs) {
  const x = d.get("bonus");
  const hand = Number(d.id);
  if (!x || !Number.isInteger(hand) || !Number.isInteger(x.slot)) continue;
  counted++;
  const h = (hands[hand] ||= { bonusPlayed: 0, rounds: {} });
  h.bonusPlayed++;
  const r = (h.rounds[x.slot] ||= { bonusPlayed: 0, bonusCorrect: 0, bonusTime: 0, bonusPairs: {} });
  const t = bonusTally(x, add);
  r.bonusPlayed += t.bonusPlayed; r.bonusCorrect += t.bonusCorrect; r.bonusTime += t.bonusTime;
  for (const [i, v] of Object.entries(t.bonusPairs)) r.bonusPairs[i] = (r.bonusPairs[i] || 0) + v;
  if (countsInStats(x.family)) {
    const f = (families[x.family] ||= { bonusRounds: 0, bonusCorrect: 0 });
    f.bonusRounds++; f.bonusCorrect += x.correct;
  }
}

const lines = [`Bonus rounds found: ${counted} across ${Object.keys(hands).length} hands.`, "", "| Hand | Bonus plays | Was | Rounds |", "|---|---|---|---|"];
for (const [hand, h] of Object.entries(hands).sort((a, b) => a[0] - b[0])) {
  const was = (await db.doc(`roundStats/${hand}`).get()).get("bonusPlayed") ?? 0;
  const rounds = Object.entries(h.rounds).map(([s, r]) => `slot ${s}: ${r.bonusPlayed} played, ${r.bonusCorrect} right`).join("; ");
  lines.push(`| #${hand} | ${h.bonusPlayed} | ${was} | ${rounds} |`);
}
lines.push("", "| Subject | Bonus rounds | Pairs right |", "|---|---|---|");
for (const [f, v] of Object.entries(families).sort()) lines.push(`| ${f} | ${v.bonusRounds} | ${v.bonusCorrect} |`);
lines.push("", DRY ? "Dry run: nothing was changed." : "Written.");

if (!DRY) {
  const b = db.batch();
  for (const [hand, h] of Object.entries(hands)) b.set(db.doc(`roundStats/${hand}`), h, { merge: true });
  b.set(db.doc("stats/families"), { families }, { merge: true });
  await b.commit();
}
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) (await import("node:fs")).appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
