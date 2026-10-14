// Moderation, run from the "Moderate" GitHub workflow. Every change is reported on the run page.
//
// ACTION:
//   find          TARGET = a nickname, group name or group code. Lists matching players (with their IDs) and groups.
//   rename-player TARGET = player ID (from find). VALUE = new name, or blank for a fresh "Player 1234".
//   rename-group  TARGET = group code. VALUE = new name, or blank for "Group <code>".
//   remove-score  TARGET = player ID, VALUE = hand number. Takes that score off the leaderboards (the play itself stays).
// DRY_RUN=1 reports what would change without changing it.
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { cleanName, cleanGroupName, defaultName } from "../functions/lib/game.js";

const ACTION = (process.env.ACTION || "").trim();
const TARGET = (process.env.TARGET || "").trim();
const VALUE = (process.env.VALUE || "").trim();
const DRY = process.env.DRY_RUN === "1";

const out = [];
const say = s => { out.push(s); console.log(s); };
const stop = msg => { console.log("::error::" + msg.replace(/%/g, "%25")); process.exit(1); };
process.on("unhandledRejection", e => stop(String((e && e.message) || e)));
if (!TARGET) stop("Fill in the target.");

initializeApp({ projectId: "strong-suit" });
const db = getFirestore();

async function find() {
  const code = TARGET.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const [players, groups, byCode] = await Promise.all([
    db.collection("players").where("name", "==", TARGET).limit(20).get(),
    db.collection("groups").where("name", "==", TARGET).limit(20).get(),
    code.length === 6 ? db.doc(`groupCodes/${code}`).get() : null,
  ]);
  players.docs.forEach(d => say(`Player "${d.get("name")}" · ID ${d.id} · ${(d.get("stats") || {}).played || 0} hands · ${(d.get("groupIds") || []).length} groups`));
  const gs = groups.docs.slice();
  if (byCode && byCode.exists) { const g = await db.doc(`groups/${byCode.get("groupId")}`).get(); if (g.exists && !gs.find(x => x.id === g.id)) gs.push(g); }
  gs.forEach(g => say(`Group "${g.get("name")}" · code ${g.get("code")} · ${g.get("memberCount")} members · owner ${g.get("ownerUid")}`));
  if (!players.size && !gs.length) say(`Nothing found for "${TARGET}". Names must match exactly, including capitals.`);
}

async function renamePlayer() {
  const pref = db.doc(`players/${TARGET}`);
  const p = await pref.get();
  if (!p.exists) stop(`No player with ID ${TARGET}. Use find first.`);
  const name = VALUE ? cleanName(VALUE) : defaultName();
  if (!name) stop("New names are 2–20 letters or numbers.");
  const plays = await pref.collection("plays").select().get();
  const refs = [
    ...(p.get("groupIds") || []).map(g => db.doc(`groups/${g}/members/${TARGET}`)),
    ...plays.docs.map(d => db.doc(`leaderboards/${d.id}/entries/${TARGET}`)),
  ];
  const existing = (await Promise.all(refs.map(r => r.get()))).filter(s => s.exists);
  say(`Rename player "${p.get("name")}" to "${name}": profile, ${existing.length} group memberships and leaderboard entries.`);
  if (DRY) return;
  const all = [pref, ...existing.map(s => s.ref)];
  for (let i = 0; i < all.length; i += 400) {
    const b = db.batch(); all.slice(i, i + 400).forEach(r => b.update(r, { name })); await b.commit();
  }
}

async function renameGroup() {
  const code = TARGET.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const c = await db.doc(`groupCodes/${code}`).get();
  if (!c.exists) stop(`No group has the code ${code}.`);
  const gref = db.doc(`groups/${c.get("groupId")}`);
  const g = await gref.get();
  const name = VALUE ? cleanGroupName(VALUE) : "Group " + code;
  if (!name) stop("Group names are 2–30 characters.");
  say(`Rename group "${g.get("name")}" (${code}) to "${name}".`);
  if (!DRY) await gref.update({ name });
}

async function removeScore() {
  const hand = Number(VALUE);
  if (!Number.isInteger(hand) || hand < 1) stop("Put the hand number in the value box.");
  const eref = db.doc(`leaderboards/${hand}/entries/${TARGET}`);
  const e = await eref.get();
  if (!e.exists) stop(`Player ${TARGET} has no score on Hand #${hand}.`);
  const score = e.get("score");
  say(`Remove "${e.get("name")}"'s score of ${score} from Hand #${hand}'s leaderboard.`);
  if (DRY) return;
  const b = db.batch();
  b.delete(eref);
  b.set(db.doc(`leaderboards/${hand}`), { players: FieldValue.increment(-1), totalScore: FieldValue.increment(-score), tally: { [score]: FieldValue.increment(-1) } }, { merge: true });
  b.set(db.doc(`players/${TARGET}/plays/${hand}`), { removedFromLeaderboard: true }, { merge: true });
  await b.commit();
}

const actions = { find, "rename-player": renamePlayer, "rename-group": renameGroup, "remove-score": removeScore };
if (!actions[ACTION]) stop("Unknown action: " + ACTION);
await actions[ACTION]();
const head = (DRY && ACTION !== "find" ? "DRY RUN, nothing changed. " : "") + (ACTION === "find" ? "Found:" : "Done:");
if (process.env.GITHUB_ACTIONS) console.log("::notice title=" + ACTION + "::" + (head + "%0A" + out.join("%0A")).replace(/\r?\n/g, "%0A"));
if (process.env.GITHUB_STEP_SUMMARY) {
  const fs = await import("node:fs");
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Moderate: ${ACTION}\n${head}\n\n` + out.map(s => "- " + s).join("\n") + "\n");
}
