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
    else assert.deepEqual(r.final, { score: 6 + 6 + 15 + 8, best: 2 + 6 + 15 + 24, aware: Math.round(35 / 47 * 100), time: 68000 });
  }
  await code(h.startRound({ hand: 1 }, "u1"), "failed-precondition");
  const play = db.store.get("players/u1/plays/1");
  assert.equal(play.status, "done");
  assert.equal(play.time, 4 * 17000, "server time: 20s after the deal, minus the 3s countdown, per round");
  assert.equal(db.store.get("leaderboards/1/entries/u1").time, 68000);
  const gf = db.store.get("stats/families").families;
  assert.equal(gf["Geography"].dealt, 1);
  assert.equal(Object.values(gf).reduce((t, f) => t + (f.skipped || 0), 0), 1);
  assert.equal(Object.values(gf).reduce((t, f) => t + (f.rounds || 0), 0), 4);
  assert.equal(play.score, 35);
  assert.equal(play.current, undefined);
  const pl = db.store.get("players/u1");
  assert.equal(pl.stats.played, 1);
  assert.equal(pl.stats.streak, 1);
  assert.equal(pl.stats.families.Music.rounds, 1);
  assert.equal(pl.stats.families.Music.correct, 6);
  assert.equal(pl.stats.families.Geography.skipped, 1, "slot 2 was skipped");
  assert.equal(pl.stats.families.Geography.dealt, 1);
  assert.equal(pl.stats.families.Geography.rounds, undefined);
  assert.equal(pl.stats.families.Music.skipped, undefined);
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


async function playHand(h, uid, ranking, want, bonus) {
  await h.startHand({ hand: 1, ranking }, uid);
  for (let k = 0; k < 4; k++) {
    const d = await h.startRound({ hand: 1 }, uid);
    await h.submitRound({ hand: 1, key: d.key, picks: picksFor(d, want[k]), timeMs: 1000 }, uid);
  }
  if (bonus !== undefined) {
    const d = await h.startRound({ hand: 1, bonus: true }, uid);
    await h.submitRound({ hand: 1, key: "bonus", picks: picksFor(d, bonus), timeMs: 1000 }, uid);
  }
}

test("group pages: day table, picks only after you've played, month and all-time stats", async () => {
  const { db, h } = setup();
  db.store.get("hands/1").date = "2026-11-01";
  const g = await h.createGroup({ name: "Pub quiz" }, "a");
  await h.joinGroup({ code: g.code }, "b");
  await code(h.groupDay({ groupId: g.groupId, hand: 1 }, "outsider"), "permission-denied");
  await code(h.groupMonth({ groupId: g.groupId, month: "2026-13" }, "a"), "invalid-argument");
  await code(h.groupDay({ groupId: g.groupId, hand: 2 }, "a"), "not-found");   // not open yet

  await playHand(h, "b", [0, 1, 2, 3, 4], [6, 6, 6, 6], 3);   // b skips slot 4, then plays it as the bonus
  let d = await h.groupDay({ groupId: g.groupId, hand: 1 }, "a");
  assert.equal(d.canSee, false);
  assert.equal(d.rounds, undefined, "no picks before you've played");
  const rb = d.members.find(m => m.uid === "b");
  assert.equal(rb.score, 60);
  assert.equal(rb.ranking, undefined);

  await playHand(h, "a", [4, 3, 2, 1, 0], [1, 2, 3, 4]);   // a skips slot 0
  d = await h.groupDay({ groupId: g.groupId, hand: 1 }, "a");
  assert.equal(d.canSee, true);
  assert.deepEqual(d.rounds[0], { slot: 0, locked: true }, "your skipped round stays hidden until your bonus");
  const r4 = d.rounds[4];
  assert.equal(r4.answers[0], "A4.0");
  assert.equal(r4.picks.b.mult, 0);          // b played it as the bonus
  assert.equal(r4.picks.b.correct, 3);
  assert.equal(r4.picks.a.mult, 4);          // a's strongest: played last, ×4
  assert.equal(r4.picks.a.chosen.length, 6);
  assert.deepEqual(d.members.find(m => m.uid === "b").ranking, [0, 1, 2, 3, 4]);
  // the bonus unlocks it
  const bd = await h.startRound({ hand: 1, bonus: true }, "a");
  await h.submitRound({ hand: 1, key: "bonus", picks: picksFor(bd, 2), timeMs: 1000 }, "a");
  d = await h.groupDay({ groupId: g.groupId, hand: 1 }, "a");
  assert.equal(d.rounds[0].picks.a.mult, 0);
  assert.equal(d.rounds[0].picks.b.mult, 4);

  const m = await h.groupMonth({ groupId: g.groupId, month: "2026-11" }, "b");
  const ma = m.members.find(x => x.uid === "a"), mb = m.members.find(x => x.uid === "b");
  assert.equal(mb.played, 1); assert.equal(mb.total, 60); assert.equal(mb.best, 60);
  assert.equal(ma.total, 1 + 4 + 9 + 16);
  assert.deepEqual(mb.families["Language"], { dealt: 1, skipped: 1, rounds: 0, correct: 0 });   // slot 4 is Language
  assert.deepEqual(ma.families["Language"], { dealt: 1, skipped: 0, rounds: 1, correct: 4 });
  const all = await h.groupMonth({ groupId: g.groupId, month: "all" }, "a");
  assert.equal(all.members.find(x => x.uid === "b").total, 60);
  const empty = await h.groupMonth({ groupId: g.groupId, month: "2026-10" }, "a");
  assert.equal(empty.members[0].played, 0);

  await h.deleteAccount({}, "b");
  assert.equal(db.store.get("players/b/months/2026-11"), undefined);
});

test("offensive or official-looking names are refused; ordinary ones pass", async () => {
  const { db, h } = setup();
  for (const bad of ["fuck", "f u c k", "B1tch", "Bell End", "Admin", "Strong Suit", "H1tler"])
    await code(h.setName({ name: bad }, "u1"), "invalid-argument");
  await code(h.createGroup({ name: "Wankers United" }, "u1"), "invalid-argument");
  for (const ok of ["Scunthorpe", "Dickens", "Cockburn", "Arsenal fan", "Penistone", "Zoë"]) {
    const r = await h.setName({ name: ok }, "u1");
    assert.equal(r.name, ok);
  }
  assert.equal(db.store.get("players/u1").name, "Zoë");
  const g = await h.createGroup({ name: "Sussex Quizzers" }, "u1");
  assert.ok(g.groupId);
});

test("admin stats: per-hand starts and finishes, per-round skips and per-pair results", async () => {
  const { db, h } = setup();
  db.store.set("config/app", { launchDate: "2026-11-01" });
  await playHand(h, "a", [0, 1, 2, 3, 4], [6, 6, 6, 6], 2);   // skips slot 4, bonus 2/6
  await playHand(h, "b", [4, 3, 2, 1, 0], [1, 2, 3, 4]);      // skips slot 0
  await h.startHand({ hand: 1, ranking: [0, 1, 2, 3, 4] }, "c");   // starts, never finishes
  const s = await h.adminStats();
  assert.equal(s.totals.players, 3);
  assert.equal(s.newPlayers.length, 30);
  assert.equal(s.newPlayers.at(-1).n, 3, "all three created today");
  const h1 = s.hands.find(x => x.hand === 1);
  assert.equal(h1.started, 3);
  assert.equal(h1.finished, 2);
  assert.equal(h1.bonusPlayed, 1);
  assert.equal(h1.rounds[4].skipped, 1);
  assert.equal(h1.rounds[0].skipped, 1);
  assert.equal(h1.rounds[0].strongest, 1);
  assert.equal(h1.rounds[4].played, 1);                  // only b played slot 4
  assert.equal(h1.rounds[4].bonusPlayed, 1);
  assert.equal(h1.rounds[4].bonusCorrect, 2);
  assert.equal(h1.rounds[1].pairs.length, 6);
  assert.equal(h1.rounds[1].pairs[0].answer, "A1.0");
  assert.equal(h1.rounds[1].pairs.reduce((t, p) => t + p.correct, 0), h1.rounds[1].correct);
  assert.equal(s.hands.find(x => x.hand === 2).rounds.length, 0, "hand 2 has no categories in the fixture");
});

test("group creator: symbol, rename, remove a member, new invite code", async () => {
  const { db, h } = setup();
  const g = await h.createGroup({ name: "Pub quiz", symbol: "owl" }, "a");
  assert.equal(db.store.get(`groups/${g.groupId}`).symbol, "owl");
  const g2 = await h.createGroup({ name: "Other", symbol: "nonsense" }, "a");
  assert.equal(db.store.get(`groups/${g2.groupId}`).symbol, "club", "unknown symbols fall back to clubs");
  await h.joinGroup({ code: g.code }, "b");
  await h.joinGroup({ code: g.code }, "c");
  // only the creator
  await code(h.updateGroup({ groupId: g.groupId, name: "Mine now" }, "b"), "permission-denied");
  await code(h.removeMember({ groupId: g.groupId, memberUid: "c" }, "b"), "permission-denied");
  await code(h.newGroupCode({ groupId: g.groupId }, "b"), "permission-denied");
  // rename and re-symbol
  await code(h.updateGroup({ groupId: g.groupId, name: "Tossers" }, "a"), "invalid-argument");
  await code(h.updateGroup({ groupId: g.groupId, symbol: "skull" }, "a"), "invalid-argument");
  await h.updateGroup({ groupId: g.groupId, name: "Quiz Night", symbol: "heart" }, "a");
  assert.equal(db.store.get(`groups/${g.groupId}`).name, "Quiz Night");
  assert.equal(db.store.get(`groups/${g.groupId}`).symbol, "heart");
  // remove a member
  await code(h.removeMember({ groupId: g.groupId, memberUid: "a" }, "a"), "invalid-argument");
  await h.removeMember({ groupId: g.groupId, memberUid: "c" }, "a");
  assert.equal(db.store.get(`groups/${g.groupId}/members/c`), undefined);
  assert.equal(db.store.get(`groups/${g.groupId}`).memberCount, 2);
  assert.deepEqual(db.store.get("players/c").groupIds, []);
  // new code: the old one stops working
  const { code: fresh } = await h.newGroupCode({ groupId: g.groupId }, "a");
  assert.notEqual(fresh, g.code);
  await code(h.joinGroup({ code: g.code }, "c"), "not-found");
  const j = await h.joinGroup({ code: fresh }, "d");
  assert.equal(j.groupId, g.groupId);
});
