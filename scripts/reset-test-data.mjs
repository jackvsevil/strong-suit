// Clears test play before launch: plays, scores, leaderboards, groups, profiles and stats.
// Keeps hands, answer keys, settings and the launch waitlist.
// Env: CONFIRM must be "RESET"; DRY_RUN=1 counts without deleting.
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const DRY = process.env.DRY_RUN === "1";
if (!DRY && process.env.CONFIRM !== "RESET") {
  console.log("::error::Type RESET in the confirm box to delete test data.");
  process.exit(1);
}
initializeApp({ projectId: "strong-suit" });
const db = getFirestore();
const CLEAR = ["players", "playSecrets", "leaderboards", "groups", "groupCodes", "categoryStats", "stats"];

const summary = [];
for (const name of CLEAR) {
  const col = db.collection(name);
  const top = (await col.count().get()).data().count;
  if (!DRY && top) await db.recursiveDelete(col);   // includes sub-collections (plays, entries, members)
  summary.push(`${name}: ${top}`);
}
const kept = [];
for (const name of ["hands", "handKeys", "config", "waitlist"]) kept.push(`${name}: ${(await db.collection(name).count().get()).data().count}`);

const msg = `${DRY ? "Would delete" : "Deleted"} (top-level documents, with everything inside them): ${summary.join(", ")}. Kept: ${kept.join(", ")}.`;
console.log(msg);
if (process.env.GITHUB_ACTIONS) console.log("::notice title=Reset test data::" + msg);
