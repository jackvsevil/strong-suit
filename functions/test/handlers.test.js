import test from "node:test";
import assert from "node:assert/strict";
import { makeDb, FieldValue, Timestamp, HttpsError } from "./fakedb.js";
import { makeHandlers } from "../lib/handlers.js";

const FAMS = ["Film & TV", "Music", "Geography", "Food & Drink", "Language"];
function setup() {
  let t = Date.UTC(2026, 10, 1, 12);
  const clock = () => t;
  const db = makeDb(clock);
  const deleted = [];
  const h = makeHandlers({ db, FieldValue, Timestamp, HttpsError, auth: { deleteUser: async u => deleted.push(u) }, now: clock });
  db.store.set("hands/1", {
    number: 1, opensAt: Timestamp.fromMillis(t - 3600e3),
    categories: FAMS.map((f, slot) => ({ slot, categoryId: "CAT-" + slot, themeId: "", label: "Cat " + slot, family: f })),
  });
  db.store.set("hands/2", { number: 2, opensAt: Timestamp.fromMillis(t + 3600e3), categories: [] });
  db.store.set("handKeys/1", {
    rounds: FAMS.map((_, slot) => ({
      prompts: [0, 1, 2, 3, 4, 5].map(i => `P${slot}.${i}`), answers: [0, 1, 2, 3, 4, 5].map(i => `A${slot}.${i}`),
      fact: "Fact " + slot, src: "https://example.com/" + slot,
    })),
  });
  return { db, h, tick: ms => (t += ms), deleted };
}
// play a dealt round getting `n` right: pick the true answer's shuffled position for the first n prompts
const picksFor = (dealt, n) => dealt.prompts.map((p, i) => (i < n ? dealt.answers.indexOf(p.replace("P", "A")) : null));
const code = async (p, c) => assert.rejects(p, e => e.code === c);

test("a full hand: ranking, four rounds, scoring, stats, bonus", async () => {
  const { db, h, tick } = setup();
  await code(h.startHand({ hand: 2, ranking: [0, 1, 2, 3, 4] }, "u1"), "failed-precondition");   // not open yet
  await code(h.startHand({ hand: 1, ranking: [0, 1, 2, 3] }, "u1"), "invalid-argument");
  const s = await h.startHand({ hand: 1, ranking: [3, 0, 4, 1, 2] }, "u1");
  assert.deepEqual(s, { order: [1, 4, 0, 3], skipped: 2 });
  assert.match(db.store.get("players/u1").name, /^Player \d{4}$/);
  await code(h.startHand({ hand: 1, ranking: [0, 1, 2, 3, 4] }, "u1"), "already-exists");
  await code(h.startRound({ hand: 1, bonus: true }, "u1"), "failed-precondition");

  const want = [6, 3, 5, 2];   // correct per round, ×1..×4
  for (let k = 0; k < 4; k++) {
    const d = await h.startRound({ hand: 1 }, "u1");
    assert.equal(d.key, String(k));
    assert.equal(d.slot, s.order[k]);
    assert.equal(d.mult, k + 1);
    assert.equal(d.answers.length, 6);
    assert.ok(!("perm" in d), "never send the key");
    assert.deepEqual(d.answers.slice().sort(), d.prompts.map(p => p.replace("P", "A")).sort());
    const again = await h.startRound({ hand: 1 }, "u1");   // a refresh resumes the same deal
    assert.deepEqual(again.answers, d.answers);
    tick(20e3);
    const r = await h.submitRound({ hand: 1, key: d.key, picks: picksFor(d, want[k]), timeMs: 20000 }, "u1");
    assert.equal(r.result.correct, want[k]);
    assert.equal(r.result.review.fact, "Fact " + d.slot);
    if (k < 3) assert.equal(r.final, undefined);
    else assert.deepEqual(r.final, { score: 6 + 6 + 15 + 8, best: 2 + 6 + 15 + 24, aware: Math.round(35 / 47 * 100) });
  }
  await code(h.startRound({ hand: 1 }, "u1"), "failed-precondition");
  const play = db.store.get("players/u1/plays/1");
  assert.equal(play.status, "done");
  assert.equal(play.score, 35);
  assert.equal(play.current, undefined);
  const pl = db.store.get("players/u1");
  assert.equal(pl.stats.played, 1);
  assert.equal(pl.stats.streak, 1);
  assert.equal(pl.stats.families.Music.rounds, 1);
  assert.equal(pl.stats.families.Music.correct, 6);
  const lb = db.store.get("leaderboards/1");
  assert.deepEqual([lb.players, lb.totalScore, lb.tally["35"]], [1, 35, 1]);
  assert.equal(db.store.get("leaderboards/1/entries/u1").score, 35);
  assert.equal(db.store.get("categoryStats/CAT-2").skipped, 1);
  assert.equal(db.store.get("categoryStats/CAT-1").correct, 6);
  assert.equal([...db.store.keys()].filter(k => k.startsWith("playSecrets/")).length, 0, "secrets cleaned up");

  const b = await h.startRound({ hand: 1, bonus: true }, "u1");
  assert.equal(b.key, "bonus");
  assert.equal(b.slot, 2);
  const br = await h.submitRound({ hand: 1, key: "bonus", picks: picksFor(b, 4) }, "u1");
  assert.equal(br.result.correct, 4);
  assert.equal(db.store.get("players/u1/plays/1").score, 35, "bonus never counts");
  assert.equal(db.store.get("leaderboards/1").totalScore, 35);
  assert.equal(db.store.get("categoryStats/CAT-2").bonusCorrect, 4);
  await code(h.startRound({ hand: 1, bonus: true }, "u1"), "failed-precondition");
});

test("late rounds score nothing; bad picks are refused", async () => {
  const { h, tick } = setup();
  await h.startHand({ hand: 1, ranking: [0, 1, 2, 3, 4] }, "u2");
  const d = await h.startRound({ hand: 1 }, "u2");
  await code(h.submitRound({ hand: 1, key: d.key, picks: [0, 0, 1, 2, 3, 4] }, "u2"), "invalid-argument");
  await code(h.submitRound({ hand: 1, key: "2", picks: picksFor(d, 6) }, "u2"), "failed-precondition");
  tick((3 + 45 + 9) * 1000);
  const r = await h.submitRound({ hand: 1, key: d.key, picks: picksFor(d, 6) }, "u2");
  assert.equal(r.result.correct, 0);
  assert.equal(r.result.late, true);
});

test("within the grace period still counts", async () => {
  const { h, tick } = setup();
  await h.startHand({ hand: 1, ranking: [0, 1, 2, 3, 4] }, "u3");
  const d = await h.startRound({ hand: 1 }, "u3");
  tick((3 + 45 + 5) * 1000);
  const r = await h.submitRound({ hand: 1, key: d.key, picks: picksFor(d, 6) }, "u3");
  assert.equal(r.result.correct, 6);
});

test("groups: create, join, cap, rename, leave, delete account", async () => {
  const { db, h, deleted } = setup();
  await code(h.createGroup({ name: "x" }, "a"), "invalid-argument");
  const g = await h.createGroup({ name: "Pub quiz" }, "a");
  assert.match(g.code, /^[A-Z2-9]{6}$/);
  assert.deepEqual(db.store.get("players/a").groupIds, [g.groupId]);
  await code(h.joinGroup({ code: "ZZZZZZ" }, "b"), "not-found");
  const j = await h.joinGroup({ code: g.code.toLowerCase() }, "b");
  assert.equal(j.groupId, g.groupId);
  await h.joinGroup({ code: g.code }, "b");   // joining twice is harmless
  assert.equal(db.store.get(`groups/${g.groupId}`).memberCount, 2);
  for (let i = 0; i < 8; i++) await h.joinGroup({ code: g.code }, "m" + i);
  await code(h.joinGroup({ code: g.code }, "late"), "resource-exhausted");   // free groups hold 10
  await h.setName({ name: "Jack" }, "b");
  assert.equal(db.store.get(`groups/${g.groupId}/members/b`).name, "Jack");
  await code(h.setName({ name: "<b>" }, "b"), "invalid-argument");
  await h.leaveGroup({ groupId: g.groupId }, "a");   // owner leaves: ownership passes on
  const grp = db.store.get(`groups/${g.groupId}`);
  assert.equal(grp.memberCount, 9);
  assert.notEqual(grp.ownerUid, "a");
  assert.deepEqual(db.store.get("players/a").groupIds, []);
  // account deletion removes plays, entries and memberships
  await h.startHand({ hand: 1, ranking: [0, 1, 2, 3, 4] }, "b");
  await h.deleteAccount({}, "b");
  assert.equal(db.store.get("players/b"), undefined);
  assert.equal(db.store.get("players/b/plays/1"), undefined);
  assert.equal(db.store.get(`groups/${g.groupId}/members/b`), undefined);
  assert.equal(db.store.get(`groups/${g.groupId}`).memberCount, 8);
  assert.deepEqual(deleted, ["b"]);
});

test("last member leaving removes the group and its code", async () => {
  const { db, h } = setup();
  const g = await h.createGroup({ name: "Solo" }, "s");
  await h.leaveGroup({ groupId: g.groupId }, "s");
  assert.equal(db.store.get(`groups/${g.groupId}`), undefined);
  assert.equal(db.store.get(`groupCodes/${g.code}`), undefined);
});
