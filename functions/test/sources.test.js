import test from "node:test";
import assert from "node:assert/strict";
import { makeDb, FieldValue, Timestamp, HttpsError } from "./fakedb.js";
import { makeHandlers } from "../lib/handlers.js";
import { cleanSource, refHost, hostTag } from "../lib/sources.js";

const DAY = 86400000;
function setup() {
  const t = Date.UTC(2026, 10, 20, 12);   // 20 Nov 2026
  const clock = () => t;
  const db = makeDb(clock);
  const h = makeHandlers({ db, FieldValue, Timestamp, HttpsError, auth: { deleteUser: async () => {} }, now: clock });
  return { db, h, t };
}

test("source: a ?ref= tag wins, then the referring site, then direct", () => {
  assert.deepEqual(cleanSource({ ref: "Reddit", referrer: "https://www.reddit.com/r/WebGames/comments/x" }), { tag: "reddit", via: "ref", host: "reddit.com" });
  assert.deepEqual(cleanSource({ ref: "", referrer: "https://www.dailydle.org/games/strong-suit" }), { tag: "dailydle", via: "referrer", host: "dailydle.org" });
  assert.deepEqual(cleanSource({ referrer: "https://dles.gg/" }), { tag: "dlesgg", via: "referrer", host: "dles.gg" });
  assert.deepEqual(cleanSource({}), { tag: "direct", via: "direct" });
  assert.deepEqual(cleanSource(undefined), { tag: "direct", via: "direct" });
});

test("source: subdomains, search engines and unknown sites", () => {
  assert.equal(hostTag("old.reddit.com"), "reddit");
  assert.equal(hostTag("l.instagram.com"), "instagram");
  assert.equal(hostTag("google.co.uk"), "google");
  assert.equal(hostTag("google.com"), "google");
  assert.equal(hostTag("someblog.com"), "someblog.com", "an unknown site is kept by name, not lost");
  assert.equal(cleanSource({ referrer: "https://someblog.com/post/1?utm=x" }).host, "someblog.com", "only the site name, never the path");
});

test("source: our own sites and sign-in pages are ignored", () => {
  for (const r of ["https://strongsuitgame.com/", "https://www.strongsuitgame.com/x", "https://strong-suit.web.app/", "https://strong-suit.firebaseapp.com/__/auth/handler", "https://accounts.google.com/o/oauth2"])
    assert.equal(refHost(r), null, r);
  assert.deepEqual(cleanSource({ referrer: "https://strongsuitgame.com/" }), { tag: "direct", via: "direct" });
});

test("source: bad input is ignored, never an error", () => {
  assert.deepEqual(cleanSource({ ref: "<script>", referrer: "not a url" }), { tag: "direct", via: "direct" });
  assert.deepEqual(cleanSource({ ref: "x".repeat(40) }), { tag: "direct", via: "direct" });
  assert.deepEqual(cleanSource({ ref: 42, referrer: { toString: () => "https://reddit.com" } }), { tag: "direct", via: "direct" });
  assert.deepEqual(cleanSource("dailydle"), { tag: "direct", via: "direct" });
  assert.equal(refHost("file:///etc/passwd"), null);
  assert.equal(refHost("https://localhost/"), null);
});

test("getMe records the source once, when the profile is made; later visits don't overwrite it", async () => {
  const { db, h } = setup();
  assert.deepEqual(await h.getMe({ source: { ref: "", referrer: "https://www.dailydle.org/games/strong-suit" } }, "u1"), { created: true });
  assert.deepEqual(db.store.get("players/u1").source, { tag: "dailydle", via: "referrer", host: "dailydle.org" });
  assert.deepEqual(await h.getMe({ source: { ref: "reddit" } }, "u1"), { created: false });
  assert.equal(db.store.get("players/u1").source.tag, "dailydle", "first touch wins");
  await h.getMe({}, "u2");   // an older page that doesn't send a source
  assert.deepEqual(db.store.get("players/u2").source, { tag: "direct", via: "direct" });
  await h.getMe(undefined, "u3");
  assert.equal(db.store.get("players/u3").source.tag, "direct");
});

test("admin sources table: visitors, players, returners and a week on, per source", async () => {
  const { db, h, t } = setup();
  for (let n = 1; n <= 30; n++) db.store.set(`hands/${n}`, { number: n, date: new Date(Date.UTC(2026, 10, n, 12)).toISOString().slice(0, 10), opensAt: Timestamp.fromMillis(Date.UTC(2026, 10, n)), categories: [] });
  const add = (uid, source, daysAgo, stats) => db.store.set(`players/${uid}`, { name: uid, createdAt: Timestamp.fromMillis(t - daysAgo * DAY), plus: false, groupIds: [], stats, ...(source ? { source } : {}) });
  const dd = { tag: "dailydle", via: "referrer", host: "dailydle.org" };
  add("a", dd, 10, { played: 5, lastHand: 19 });   // arrived on hand 10, still playing on 19: a week on
  add("b", dd, 10, { played: 2, lastHand: 12 });   // came back, but not a week on
  add("c", dd, 2, { played: 1, lastHand: 18 });    // too recent to count for a week on
  add("d", dd, 1, {});                             // visited, never played
  add("e", { tag: "direct", via: "direct" }, 3, { played: 1, lastHand: 17 });
  add("f", null, 5, { played: 3, lastHand: 20 });  // from before tracking
  add("old", dd, 40, { played: 9, lastHand: 20 }); // outside the 30 days
  const s = await h.adminStats();
  const row = tag => s.sources.find(r => r.tag === tag);
  assert.deepEqual(row("dailydle"), { tag: "dailydle", via: "referrer", players: 4, played: 3, returned: 2, weekEligible: 2, weekOn: 1 });
  assert.equal(row("direct").players, 1);
  assert.equal(row("untracked").players, 1);
  assert.equal(s.sources[0].tag, "dailydle", "biggest source first");
  assert.equal(s.sources.reduce((n, r) => n + r.players, 0), 6);
});
