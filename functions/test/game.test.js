import test from "node:test";
import assert from "node:assert/strict";
import * as G from "../lib/game.js";

test("hand dates and opening times", () => {
  assert.equal(G.handDate("2026-11-01", 1), "2026-11-01");
  assert.equal(G.handDate("2026-11-01", 31), "2026-12-01");
  assert.equal(G.handDate("2026-12-31", 2), "2027-01-01");
  // opens 14 hours before UTC midnight (local midnight in UTC+14)
  assert.equal(new Date(G.opensAtMs("2026-11-01", 1)).toISOString(), "2026-10-31T10:00:00.000Z");
});

test("ranking", () => {
  assert.ok(G.checkRanking([2, 0, 4, 1, 3]));
  assert.ok(!G.checkRanking([2, 0, 4, 1]));
  assert.ok(!G.checkRanking([2, 0, 4, 1, 1]));
  assert.ok(!G.checkRanking([2, 0, 4, 1, 5]));
  assert.ok(!G.checkRanking("01234"));
  // strongest first; play weakest first; fifth skipped
  assert.deepEqual(G.playOrder([2, 0, 4, 1, 3]), { order: [1, 4, 0, 2], skipped: 3 });
});

test("next round", () => {
  assert.equal(G.nextRoundKey({ rounds: {} }), "0");
  assert.equal(G.nextRoundKey({ rounds: { 0: {}, 1: {} } }), "2");
  assert.equal(G.nextRoundKey({ rounds: { 0: {}, 1: {}, 2: {}, 3: {} } }), null);
  assert.equal(G.nextRoundKey({ rounds: { 0: {}, 1: {}, 2: {}, 3: {} } }, true), "bonus");
  assert.equal(G.nextRoundKey({ rounds: { 0: {} } }, true), null);
  assert.equal(G.nextRoundKey({ rounds: { 0: {}, 1: {}, 2: {}, 3: {} }, bonus: {} }, true), null);
});

test("shuffle is a permutation", () => {
  for (let i = 0; i < 200; i++) assert.deepEqual(G.shuffledPerm().slice().sort(), [0, 1, 2, 3, 4, 5]);
});

test("marking", () => {
  const perm = [3, 0, 5, 1, 4, 2];   // shuffled position j shows true answer perm[j]
  // perfect: prompt i must pick the position j where perm[j] === i
  const perfect = [0, 1, 2, 3, 4, 5].map(i => perm.indexOf(i));
  assert.deepEqual(G.markRound(perm, perfect), { chosen: [0, 1, 2, 3, 4, 5], marks: Array(6).fill(true), correct: 6 });
  const some = [perm.indexOf(0), null, perm.indexOf(1), null, perm.indexOf(4), null];
  const r = G.markRound(perm, some);
  assert.equal(r.correct, 2);
  assert.deepEqual(r.marks, [true, false, false, false, true, false]);
  assert.deepEqual(r.chosen, [0, null, 1, null, 4, null]);
  assert.equal(G.markRound(perm, perfect, true).correct, 0, "late rounds score nothing");
  assert.ok(G.checkPicks([0, 1, null, 3, null, 5]));
  assert.ok(!G.checkPicks([0, 0, null, 3, null, 5]), "no answer used twice");
  assert.ok(!G.checkPicks([0, 1, 2, 3, 4]), "six picks");
  assert.ok(!G.checkPicks([0, 1, 2, 3, 4, 6]));
});

test("scoring matches the prototype", () => {
  assert.deepEqual(G.finalScore([6, 6, 6, 6]), { score: 60, best: 60, aware: 100 });
  assert.deepEqual(G.finalScore([0, 0, 0, 0]), { score: 0, best: 0, aware: 100 });
  // weakest-first rounds: 6 on ×1, 2 on ×4 → best would put 6 on ×4
  assert.deepEqual(G.finalScore([6, 4, 3, 2]), { score: 6 + 8 + 9 + 8, best: 2 + 6 + 12 + 24, aware: Math.round(31 / 44 * 100) });
  assert.equal(G.MAX_SCORE, 60);
});

test("streaks", () => {
  assert.equal(G.nextStreak(undefined, 5), 1);
  assert.equal(G.nextStreak({ lastHand: 4, streak: 3 }, 5), 4);
  assert.equal(G.nextStreak({ lastHand: 2, streak: 3 }, 5), 1);
});

test("names and codes", () => {
  assert.equal(G.cleanName("  Jack   H "), "Jack H");
  assert.equal(G.cleanName("Zoë_99"), "Zoë_99");
  assert.equal(G.cleanName("a"), null);
  assert.equal(G.cleanName("x".repeat(21)), null);
  assert.equal(G.cleanName("<script>"), null);
  assert.match(G.defaultName(), /^Player \d{4}$/);
  assert.match(G.groupCode(), /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(G.cleanGroupName(" Pub quiz "), "Pub quiz");
  assert.equal(G.cleanGroupName("x"), null);
});
