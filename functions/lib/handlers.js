// Game handlers with their dependencies passed in, so tests can run them against an in-memory database.
import * as G from "./game.js";
import { createHash } from "node:crypto";
import { allowedName } from "./names.js";
import { cleanSource } from "./sources.js";

export function makeHandlers({ db, FieldValue, Timestamp, auth, HttpsError, now = () => Date.now() }) {
const LEAD_SECONDS = 3;   // the 3-2-1 countdown before the timer starts

const fail = (code, msg) => { throw new HttpsError(code, msg); };
const needHand = h => (Number.isInteger(h) && h >= 1 && h <= 100000 ? h : fail("invalid-argument", "Unknown hand."));

const refs = (uid, hand) => ({
  hand: db.doc(`hands/${hand}`),
  key: db.doc(`handKeys/${hand}`),
  player: db.doc(`players/${uid}`),
  play: db.doc(`players/${uid}/plays/${hand}`),
  secret: db.doc(`playSecrets/${uid}_${hand}`),
});

function newPlayer(uid) {
  return { name: G.defaultName(), createdAt: FieldValue.serverTimestamp(), plus: false, groupIds: [], stats: {} };
}

// Guests (anonymous sign-in) can play, but can't join or start groups and aren't on the Everyone leaderboard.
// The ID token says how the player signed in. If it still says anonymous (or there's no token), ask
// Firebase Auth, in case they've only just created an account. If that lookup fails, treat them as a guest:
// claimScores puts their scores on the board once they're signed in.
async function isGuest(uid, token) {
  const via = token && token.firebase && token.firebase.sign_in_provider;
  if (via && via !== "anonymous") return false;
  try { return !((await auth.getUser(uid)).providerData || []).length; }
  catch (e) { console.error("isGuest", uid, e); return true; }
}
const GUEST_GROUPS = "Create a free account to join groups. Your scores so far come with you.";

/* ---------- 1. Lock in the ranking ---------- */
const startHand = (async ({ hand, ranking }, uid) => {
  needHand(hand);
  if (!G.checkRanking(ranking)) fail("invalid-argument", "Rank all five categories.");
  const r = refs(uid, hand);
  const out = await db.runTransaction(async tx => {
    const [h, play, player] = await Promise.all([tx.get(r.hand), tx.get(r.play), tx.get(r.player)]);
    if (!h.exists) fail("not-found", "That hand doesn't exist.");
    if (h.get("opensAt").toMillis() > now()) fail("failed-precondition", "That hand isn't open yet.");
    if (play.exists) {
      if (JSON.stringify(play.get("ranking")) === JSON.stringify(ranking)) return { order: play.get("order"), skipped: play.get("skipped") };
      fail("already-exists", "You've already started this hand.");
    }
    const { order, skipped } = G.playOrder(ranking);
    if (!player.exists) tx.set(r.player, newPlayer(uid));
    tx.set(r.play, {
      hand, date: h.get("date") || null, ranking, order, skipped, categories: h.get("categories"),
      startedAt: FieldValue.serverTimestamp(), rounds: {}, status: "playing",
    });
    return { order, skipped, fresh: true };
  });
  if (out.fresh) {   // for the admin page: how many start a hand, against how many finish it
    await db.doc(`roundStats/${hand}`).set({ started: FieldValue.increment(1) }, { merge: true }).catch(e => console.error("roundStats", e));
    delete out.fresh;
  }
  return out;
});

/* ---------- 2. Deal a round: prompts and shuffled answers, never the key ---------- */
const startRound = (async ({ hand, bonus }, uid) => {
  needHand(hand);
  const r = refs(uid, hand);
  return db.runTransaction(async tx => {
    const [play, keys] = await Promise.all([tx.get(r.play), tx.get(r.key)]);
    if (!play.exists) fail("failed-precondition", "Rank your hand first.");
    const p = play.data();
    const cur = p.current;
    if (cur && (cur.key === "bonus") === !!bonus) return payload(cur);   // resume after a refresh
    if (bonus && p.status !== "done") fail("failed-precondition", "Finish your hand first.");
    const key = G.nextRoundKey(p, !!bonus);
    if (!key) fail("failed-precondition", bonus ? "You've already played the bonus round." : "You've played all four rounds.");
    const slot = key === "bonus" ? p.skipped : p.order[+key];
    const round = keys.get("rounds")[slot];
    const cat = p.categories[slot];
    const perm = G.shuffledPerm();
    const next = {
      key, slot, mult: key === "bonus" ? 0 : +key + 1, label: cat.label, family: cat.family,
      prompts: round.prompts, answers: perm.map(j => round.answers[j]),
      startsAt: Timestamp.fromMillis(now() + LEAD_SECONDS * 1000),   // when the 3-2-1 countdown ends and the stopwatch starts
    };
    tx.update(r.play, { current: next });
    tx.set(r.secret, { uid, hand, key, perm });
    return payload(next);
  });
});
// rounds dealt before the time limit was dropped stored a deadline 45s after the start instead
const startMs = c => c.startsAt ? c.startsAt.toMillis() : c.deadline.toMillis() - 45000;
const payload = c => { const { deadline, ...rest } = c; return { ...rest, startsAt: startMs(c), now: now(), capSeconds: G.ROUND_CAP_SECONDS }; };

/* ---------- 3. Check a round; after round four, score the hand ---------- */
const submitRound = (async ({ hand, key, picks, timeMs }, uid, token) => {
  needHand(hand);
  if (!G.checkPicks(picks)) fail("invalid-argument", "Those answers don't look right.");
  const r = refs(uid, hand);
  const out = await db.runTransaction(async tx => {
    const [play, secret, keys, player] = await Promise.all([tx.get(r.play), tx.get(r.secret), tx.get(r.key), tx.get(r.player)]);
    if (!play.exists) fail("failed-precondition", "Rank your hand first.");
    const p = play.data(), cur = p.current;
    if (!cur || cur.key !== key || !secret.exists) fail("failed-precondition", "That round isn't in play.");
    const late = false;   // no time limit: a round counts however long it takes
    // time taken by the server's clock (the round starts when the 3-2-1 countdown ends): the leaderboard tie-break
    const serverMs = Math.min(G.ROUND_CAP_SECONDS * 1000, Math.max(0, now() - startMs(cur)));
    const { chosen, marks, correct } = G.markRound(secret.get("perm"), picks);
    const round = keys.get("rounds")[cur.slot];
    const cat = p.categories[cur.slot];
    const result = {
      slot: cur.slot, mult: cur.mult, label: cat.label, family: cat.family, categoryId: cat.categoryId,
      correct, marks, late, serverMs, timeMs: Number.isFinite(timeMs) ? Math.round(timeMs) : null,
      review: { prompts: round.prompts, answers: round.answers, chosen, fact: round.fact, src: round.src },
    };
    // the month this hand belongs to, for group month tables (reads must come before writes)
    let monthRef = null, monthSnap = null;
    if (key === "3") {
      const date = p.date || (await tx.get(r.hand)).get("date");
      if (typeof date === "string" && /^\d{4}-\d{2}/.test(date)) {
        monthRef = db.doc(`players/${uid}/months/${date.slice(0, 7)}`);
        monthSnap = await tx.get(monthRef);
      }
    }
    const upd = { current: FieldValue.delete() };
    let final = null;
    if (key === "bonus") upd.bonus = result;
    else {
      upd[`rounds.${key}`] = result;
      if (key === "3") {
        const correctByRound = [0, 1, 2].map(k => p.rounds[k].correct).concat(correct);
        final = G.finalScore(correctByRound);
        final.time = [0, 1, 2].map(k => p.rounds[k].serverMs ?? G.ROUND_CAP_SECONDS * 1000).reduce((a, b) => a + b, serverMs);
        Object.assign(upd, { status: "done", finishedAt: FieldValue.serverTimestamp(), ...final });
        const pl = player.exists ? player.data() : newPlayer(uid);
        const st = pl.stats || {};
        const streak = G.nextStreak(st, hand);
        // per subject: times dealt, skipped, played, and pairs right
        const families = {};
        const fam = f => G.countsInStats(f) ? (families[f] ||= {}) : {};   // Joker rounds aren't counted
        p.categories.forEach(c => { fam(c.family).dealt = FieldValue.increment(1); });
        fam(p.categories[p.skipped].family).skipped = FieldValue.increment(1);
        [0, 1, 2].map(k => p.rounds[k]).concat(result).forEach(x => {
          Object.assign(fam(x.family), { rounds: FieldValue.increment(1), correct: FieldValue.increment(x.correct) });
        });
        tx.set(r.player, {
          ...(player.exists ? {} : pl),
          stats: {
            played: FieldValue.increment(1), totalScore: FieldValue.increment(final.score), timeTotal: FieldValue.increment(final.time),
            awareTotal: FieldValue.increment(final.aware), bestScore: Math.max(st.bestScore || 0, final.score),
            streak, bestStreak: Math.max(st.bestStreak || 0, streak), lastHand: hand, families,
          },
        }, { merge: true });
        if (monthRef) tx.set(monthRef, {
          played: FieldValue.increment(1), totalScore: FieldValue.increment(final.score), awareTotal: FieldValue.increment(final.aware), timeTotal: FieldValue.increment(final.time),
          best: Math.max((monthSnap.exists && monthSnap.get("best")) || 0, final.score), families,
        }, { merge: true });
        final.name = pl.name;
        final.families = families;
      }
    }
    tx.update(r.play, upd);
    tx.delete(r.secret);
    return { result, final, rounds: p.rounds, skipped: p.categories[p.skipped], skippedSlot: p.skipped, strongest: p.ranking[0] };
  });

  // Leaderboards and category stats sit outside the transaction: they're tallies, not the record.
  // Guests' scores count towards the stats but stay off the Everyone leaderboard (and its tally) until they sign up.
  const listed = out.final ? !(await isGuest(uid, token)) : false;
  const b = db.batch();
  const inc = FieldValue.increment;
  if (out.final) {
    const f = out.final;
    if (listed) {
      b.set(db.doc(`leaderboards/${hand}`), { players: inc(1), totalScore: inc(f.score), tally: { [f.score]: inc(1) } }, { merge: true });
      b.set(db.doc(`leaderboards/${hand}/entries/${uid}`), { name: f.name, score: f.score, time: f.time, aware: f.aware, at: FieldValue.serverTimestamp() });
    }
    [0, 1, 2].map(k => out.rounds[k]).concat(out.result).forEach(x =>
      b.set(db.doc(`categoryStats/${x.categoryId}`), { played: inc(1), correct: inc(x.correct) }, { merge: true }));
    b.set(db.doc(`categoryStats/${out.skipped.categoryId}`), { skipped: inc(1) }, { merge: true });
    b.set(db.doc("stats/families"), { families: f.families }, { merge: true });   // everyone's subject averages, for profiles
    // per round and per pair, for the admin page (server-only)
    const rounds = {};
    const rs = slot => (rounds[slot] ||= {});
    [0, 1, 2].map(k => out.rounds[k]).concat(out.result).forEach(x => Object.assign(rs(x.slot), {
      played: inc(1), correct: inc(x.correct), time: inc(x.serverMs ?? 0), [`asX${x.mult}`]: inc(1),
      pairs: Object.fromEntries(x.marks.map((m, i) => [i, inc(m ? 1 : 0)])),
    }));
    rs(out.skippedSlot).skipped = inc(1);
    rs(out.strongest).strongest = inc(1);
    b.set(db.doc(`roundStats/${hand}`), { finished: inc(1), totalScore: inc(f.score), awareTotal: inc(f.aware), rounds }, { merge: true });
  } else if (key === "bonus") {
    b.set(db.doc(`categoryStats/${out.result.categoryId}`), { bonusPlayed: inc(1), bonusCorrect: inc(out.result.correct) }, { merge: true });
    b.set(db.doc(`roundStats/${hand}`), { bonusPlayed: inc(1), rounds: { [out.result.slot]: { bonusPlayed: inc(1), bonusCorrect: inc(out.result.correct) } } }, { merge: true });
  }
  await b.commit().catch(e => console.error("tally update failed", hand, uid, e));
  const res = { result: out.result };
  if (out.final) res.final = { score: out.final.score, best: out.final.best, aware: out.final.aware, time: out.final.time, listed };
  return res;
});

/* ---------- Names ---------- */
const setName = (async ({ name }, uid) => {
  const n = G.cleanName(name);
  if (!n) fail("invalid-argument", "Names are 2–20 letters or numbers.");
  if (!allowedName(n)) fail("invalid-argument", "That name isn't allowed. Try another.");
  const pref = db.doc(`players/${uid}`);
  const groupIds = await db.runTransaction(async tx => {
    const p = await tx.get(pref);
    if (!p.exists) { tx.set(pref, { ...newPlayer(uid), name: n }); return []; }
    tx.update(pref, { name: n });
    return p.get("groupIds") || [];
  });
  const b = db.batch();
  groupIds.forEach(g => b.set(db.doc(`groups/${g}/members/${uid}`), { name: n }, { merge: true }));
  await b.commit();
  return { name: n };
});

// The page calls this on every load; the first call makes the profile and records where the player came from.
const getMe = (async ({ source } = {}, uid) => {
  const pref = db.doc(`players/${uid}`);
  return db.runTransaction(async tx => {
    const p = await tx.get(pref);
    if (p.exists) return { created: false };   // first touch wins: an existing source is never overwritten
    tx.set(pref, { ...newPlayer(uid), source: cleanSource(source) });
    return { created: true };
  });
});

/* ---------- Groups ---------- */
const createGroup = (async ({ name, symbol }, uid, token) => {
  if (await isGuest(uid, token)) fail("failed-precondition", GUEST_GROUPS);
  const n = G.cleanGroupName(name);
  const sym = G.cleanSymbol(symbol) || "club";
  if (!n) fail("invalid-argument", "Group names are 2–30 characters.");
  if (!allowedName(n)) fail("invalid-argument", "That group name isn't allowed. Try another.");
  const pref = db.doc(`players/${uid}`);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = G.groupCode();
    const gref = db.collection("groups").doc();
    const ok = await db.runTransaction(async tx => {
      const [c, p] = await Promise.all([tx.get(db.doc(`groupCodes/${code}`)), tx.get(pref)]);
      if (c.exists) return false;
      const pl = p.exists ? p.data() : newPlayer(uid);
      if (!p.exists) tx.set(pref, pl);
      tx.set(gref, { name: n, symbol: sym, ownerUid: uid, code, memberCount: 1, cap: pl.plus ? 50 : G.FREE_GROUP_CAP, createdAt: FieldValue.serverTimestamp() });
      tx.set(gref.collection("members").doc(uid), { name: pl.name, joinedAt: FieldValue.serverTimestamp() });
      tx.set(db.doc(`groupCodes/${code}`), { groupId: gref.id });
      tx.set(pref, { groupIds: FieldValue.arrayUnion(gref.id) }, { merge: true });
      return true;
    });
    if (ok) return { groupId: gref.id, code };
  }
  fail("unavailable", "Couldn't make a group code. Try again.");
});

const joinGroup = (async ({ code }, uid, token) => {
  const c = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length !== 6) fail("invalid-argument", "Group codes are six characters.");
  if (await isGuest(uid, token)) fail("failed-precondition", GUEST_GROUPS);
  const cref = db.doc(`groupCodes/${c}`);
  const pref = db.doc(`players/${uid}`);
  return db.runTransaction(async tx => {
    const cd = await tx.get(cref);
    if (!cd.exists) fail("not-found", "No group has that code.");
    const gref = db.doc(`groups/${cd.get("groupId")}`);
    const mref = gref.collection("members").doc(uid);
    const [g, m, p] = await Promise.all([tx.get(gref), tx.get(mref), tx.get(pref)]);
    if (m.exists) return { groupId: gref.id, name: g.get("name") };
    if (g.get("memberCount") >= g.get("cap")) fail("resource-exhausted", "That group is full.");
    const pl = p.exists ? p.data() : newPlayer(uid);
    if (!p.exists) tx.set(pref, pl);
    tx.set(mref, { name: pl.name, joinedAt: FieldValue.serverTimestamp() });
    tx.update(gref, { memberCount: FieldValue.increment(1) });
    tx.set(pref, { groupIds: FieldValue.arrayUnion(gref.id) }, { merge: true });
    return { groupId: gref.id, name: g.get("name") };
  });
});

async function leave(uid, groupId) {
  const gref = db.doc(`groups/${groupId}`);
  const mref = gref.collection("members").doc(uid);
  const pref = db.doc(`players/${uid}`);
  await db.runTransaction(async tx => {
    const [g, m] = await Promise.all([tx.get(gref), tx.get(mref)]);
    const others = g.exists ? await tx.get(gref.collection("members").orderBy("joinedAt").limit(2)) : null;
    if (g.exists && m.exists) {
      if (g.get("memberCount") <= 1) {
        tx.delete(gref); tx.delete(db.doc(`groupCodes/${g.get("code")}`));
      } else {
        const upd = { memberCount: FieldValue.increment(-1) };
        if (g.get("ownerUid") === uid) {
          const heir = others.docs.find(d => d.id !== uid);
          if (heir) upd.ownerUid = heir.id;
        }
        tx.update(gref, upd);
      }
      tx.delete(mref);
    }
    tx.set(pref, { groupIds: FieldValue.arrayRemove(groupId) }, { merge: true });
  });
}
const leaveGroup = (async ({ groupId }, uid) => {
  if (typeof groupId !== "string" || !groupId) fail("invalid-argument", "Unknown group.");
  await leave(uid, groupId);
  return { ok: true };
});

/* ---------- Group creator's controls ---------- */
async function ownedGroup(tx, groupId, uid) {
  if (typeof groupId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(groupId)) fail("invalid-argument", "Unknown group.");
  const gref = db.doc(`groups/${groupId}`);
  const g = await tx.get(gref);
  if (!g.exists) fail("not-found", "That group no longer exists.");
  if (g.get("ownerUid") !== uid) fail("permission-denied", "Only the group's creator can do that.");
  return { gref, g };
}
// Rename the group and/or change its symbol.
const updateGroup = (async ({ groupId, name, symbol }, uid) => {
  const upd = {};
  if (name !== undefined) {
    const n = G.cleanGroupName(name);
    if (!n) fail("invalid-argument", "Group names are 2–30 characters.");
    if (!allowedName(n)) fail("invalid-argument", "That group name isn't allowed. Try another.");
    upd.name = n;
  }
  if (symbol !== undefined) upd.symbol = G.cleanSymbol(symbol) || fail("invalid-argument", "Pick one of the symbols.");
  if (!Object.keys(upd).length) fail("invalid-argument", "Nothing to change.");
  await db.runTransaction(async tx => { const { gref } = await ownedGroup(tx, groupId, uid); tx.update(gref, upd); });
  return upd;
});
// Remove a member. They could rejoin with the code, so the creator can also issue a new one.
const removeMember = (async ({ groupId, memberUid }, uid) => {
  if (typeof memberUid !== "string" || !memberUid) fail("invalid-argument", "Unknown player.");
  if (memberUid === uid) fail("invalid-argument", "To leave your own group, use Leave this group.");
  await db.runTransaction(async tx => {
    const { gref } = await ownedGroup(tx, groupId, uid);
    const mref = gref.collection("members").doc(memberUid);
    const m = await tx.get(mref);
    if (!m.exists) fail("not-found", "They're not in this group.");
    tx.delete(mref);
    tx.update(gref, { memberCount: FieldValue.increment(-1) });
    tx.set(db.doc(`players/${memberUid}`), { groupIds: FieldValue.arrayRemove(groupId) }, { merge: true });
  });
  return { ok: true };
});
// A fresh invite code; the old one stops working straight away.
const newGroupCode = (async ({ groupId }, uid) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = G.groupCode();
    const ok = await db.runTransaction(async tx => {
      const { gref, g } = await ownedGroup(tx, groupId, uid);
      const c = await tx.get(db.doc(`groupCodes/${code}`));
      if (c.exists) return false;
      tx.delete(db.doc(`groupCodes/${g.get("code")}`));
      tx.set(db.doc(`groupCodes/${code}`), { groupId });
      tx.update(gref, { code });
      return true;
    });
    if (ok) return { code };
  }
  fail("unavailable", "Couldn't make a new code. Try again.");
});

/* ---------- Group pages: only members can look, and only the server reads other players' plays ---------- */
async function groupMembers(groupId, uid) {
  if (typeof groupId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(groupId)) fail("invalid-argument", "Unknown group.");
  const gref = db.doc(`groups/${groupId}`);
  const me = await gref.collection("members").doc(uid).get();
  if (!me.exists) fail("permission-denied", "You're not in that group.");
  const ms = await gref.collection("members").get();
  return ms.docs.map(d => ({ uid: d.id, name: d.get("name") }));
}

// One hand: everyone's score, and, once you've finished it yourself, how they ranked it and what they picked.
const groupDay = (async ({ groupId, hand }, uid) => {
  needHand(hand);
  const members = await groupMembers(groupId, uid);
  const h = await db.doc(`hands/${hand}`).get();
  if (!h.exists || h.get("opensAt").toMillis() > now()) fail("not-found", "That hand isn't open yet.");
  const plays = await Promise.all(members.map(m => db.doc(`players/${m.uid}/plays/${hand}`).get()));
  const byUid = Object.fromEntries(members.map((m, i) => [m.uid, plays[i].exists ? plays[i].data() : null]));
  const mine = byUid[uid];
  const canSee = !!(mine && mine.status === "done");
  const categories = h.get("categories").map(c => ({ slot: c.slot, label: c.label, family: c.family }));
  const rows = members.map(m => {
    const p = byUid[m.uid];
    const row = { uid: m.uid, name: m.name, status: p ? p.status : null };
    if (p && p.status === "done") Object.assign(row, { score: p.score, best: p.best, aware: p.aware, time: p.time ?? null });
    if (canSee && p && p.status === "done") Object.assign(row, { ranking: p.ranking, skipped: p.skipped });
    return row;
  });
  const out = { hand, date: h.get("date") || null, categories, members: rows, canSee, bonusDone: !!(mine && mine.bonus) };
  if (!canSee) return out;
  const keys = (await db.doc(`handKeys/${hand}`).get()).get("rounds");
  out.rounds = categories.map(c => {
    if (c.slot === mine.skipped && !mine.bonus) return { slot: c.slot, locked: true };   // don't spoil your bonus round
    const k = keys[c.slot], picks = {};
    members.forEach(m => {
      const p = byUid[m.uid];
      if (!p || p.status !== "done") return;
      const r = Object.values(p.rounds || {}).find(x => x.slot === c.slot) || (p.bonus && p.bonus.slot === c.slot ? p.bonus : null);
      picks[m.uid] = r ? { mult: r.mult, chosen: r.review.chosen, correct: r.correct } : { mult: null };
    });
    return { slot: c.slot, prompts: k.prompts, answers: k.answers, fact: k.fact, src: k.src, picks };
  });
  return out;
});

// A month ("2026-10") or all time ("all"): totals, and per-subject rounds, pairs right and skips for each member.
const groupMonth = (async ({ groupId, month }, uid) => {
  if (month !== "all" && !(typeof month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(month))) fail("invalid-argument", "Unknown month.");
  const members = await groupMembers(groupId, uid);
  const docs = await Promise.all(members.map(m => db.doc(month === "all" ? `players/${m.uid}` : `players/${m.uid}/months/${month}`).get()));
  const fams = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, { dealt: v.dealt || 0, skipped: v.skipped || 0, rounds: v.rounds || 0, correct: v.correct || 0 }]));
  return {
    month,
    members: members.map((m, i) => {
      const d = docs[i].exists ? docs[i].data() : {};
      const s = month === "all" ? d.stats || {} : d;
      return { uid: m.uid, name: m.name, played: s.played || 0, total: s.totalScore || 0, time: s.timeTotal || 0, best: (month === "all" ? s.bestScore : s.best) || 0, families: fams(s.families) };
    }),
  };
});

/* ---------- Admin page: totals only, plus per-round and per-pair results (the caller is checked in index.js) ---------- */
const adminStats = async () => {
  const DAY = 86400000, today = Math.floor(now() / DAY) * DAY;
  const count = q => q.count().get().then(r => r.data().count);
  const [cfg, hands, keys, rstats, boards, fams, players, groups, newByDay, recent] = await Promise.all([
    db.doc("config/app").get(),
    db.collection("hands").get(),
    db.collection("handKeys").get(),
    db.collection("roundStats").get(),
    db.collection("leaderboards").get(),
    db.doc("stats/families").get(),
    count(db.collection("players")),
    count(db.collection("groups")),
    Promise.all(Array.from({ length: 30 }, (_, i) => {   // new players per UTC day, last 30 days
      const from = today - (29 - i) * DAY;
      return count(db.collection("players").where("createdAt", ">=", Timestamp.fromMillis(from)).where("createdAt", "<", Timestamp.fromMillis(from + DAY)))
        .then(n => ({ date: new Date(from).toISOString().slice(0, 10), n }));
    })),
    db.collection("players").where("createdAt", ">=", Timestamp.fromMillis(today - 29 * DAY)).get(),   // for the sources table
  ]);
  const accounts = await countAccounts();
  const byId = snap => Object.fromEntries(snap.docs.map(d => [d.id, d.data()]));
  const K = byId(keys), R = byId(rstats), L = byId(boards);
  const out = hands.docs.map(d => {
    const h = d.data(), n = Number(d.id), rs = R[d.id] || {}, lb = L[d.id] || {}, open = h.opensAt.toMillis() <= now();
    const k = (K[d.id] && K[d.id].rounds) || [];
    return {
      hand: n, date: h.date, open,
      started: rs.started || 0, finished: rs.finished || lb.players || 0, bonusPlayed: rs.bonusPlayed || 0,
      totalScore: rs.totalScore ?? lb.totalScore ?? 0, awareTotal: rs.awareTotal || 0, tally: lb.tally || {},
      rounds: h.categories.map(c => {
        const x = (rs.rounds || {})[c.slot] || {};
        return {
          slot: c.slot, label: c.label, family: c.family, categoryId: c.categoryId,
          played: x.played || 0, correct: x.correct || 0, time: x.time || 0, skipped: x.skipped || 0, strongest: x.strongest || 0,
          bonusPlayed: x.bonusPlayed || 0, bonusCorrect: x.bonusCorrect || 0,
          pairs: open && k[c.slot] ? k[c.slot].prompts.map((pr, i) => ({ prompt: pr, answer: k[c.slot].answers[i], correct: (x.pairs || {})[i] || 0 })) : [],
        };
      }),
    };
  }).sort((a, b) => a.hand - b.hand);
  return {
    launchDate: cfg.exists ? cfg.get("launchDate") : null, at: now(),
    totals: { players, groups, accounts }, newPlayers: newByDay, sources: sourceTable(recent.docs, hands.docs),
    families: (fams.exists && fams.get("families")) || {}, hands: out,
  };
};

// Players who've created an account (Google or email link), as opposed to guests. Firebase Auth hands out 1,000 at a time.
// null if Auth can't be read, so the page shows a dash rather than a wrong number.
async function countAccounts() {
  let n = 0, pageToken;
  try {
    do {
      const page = await auth.listUsers(1000, pageToken);
      n += page.users.filter(u => (u.providerData || []).length).length;
      pageToken = page.pageToken;
    } while (pageToken);
    return n;
  } catch (e) { console.error("countAccounts", e); return null; }
}

// New players in the last 30 days by where they came from, and whether they stuck around.
// "A week on" counts players who finished a hand at least 7 days after the one open when they arrived,
// out of those who arrived at least 7 days ago. Profiles from before tracking began show as "untracked".
function sourceTable(players, hands) {
  const DAY = 86400000, handOn = {};
  hands.forEach(d => { const h = d.data(); if (h.date) handOn[h.date] = Number(d.id); });
  const first = Math.min(...Object.values(handOn), Infinity);
  const rows = {};
  for (const d of players) {
    const p = d.data(), src = p.source || {}, st = p.stats || {};
    const tag = typeof src.tag === "string" ? src.tag : "untracked";
    const r = (rows[tag] ||= { tag, via: src.via || null, players: 0, played: 0, returned: 0, weekEligible: 0, weekOn: 0 });
    r.players++;
    if ((st.played || 0) >= 1) r.played++;
    if ((st.played || 0) >= 2) r.returned++;
    const at = p.createdAt && p.createdAt.toMillis ? p.createdAt.toMillis() : null;
    if (at !== null && at <= now() - 7 * DAY) {
      r.weekEligible++;
      const arrived = handOn[new Date(at).toISOString().slice(0, 10)] ?? (Number.isFinite(first) ? first : null);
      if (arrived !== null && (st.lastHand || 0) >= arrived + 7) r.weekOn++;
    }
  }
  return Object.values(rows).sort((a, b) => b.players - a.players || a.tag.localeCompare(b.tag));
}

/* ---------- A guest has just created an account: put the hands they've already finished on the leaderboard ---------- */
// The page calls this once signed in until the profile says `listed`. Safe to repeat: a hand that already has an
// entry is left alone, and scores taken off a leaderboard by moderation stay off.
const claimScores = (async (_, uid, token) => {
  if (await isGuest(uid, token)) fail("failed-precondition", "Create an account first.");
  const pref = db.doc(`players/${uid}`);
  const p = await pref.get();
  if (!p.exists || p.get("listed")) return { added: 0 };
  const inc = FieldValue.increment;
  const plays = await pref.collection("plays").where("status", "==", "done").get();
  let added = 0;
  for (const d of plays.docs) {
    const pl = d.data(), hand = Number(d.id);
    if (!Number.isInteger(hand) || pl.removedFromLeaderboard || !Number.isFinite(pl.score)) continue;
    const eref = db.doc(`leaderboards/${hand}/entries/${uid}`);
    const fresh = await db.runTransaction(async tx => {
      if ((await tx.get(eref)).exists) return false;
      tx.set(eref, { name: p.get("name"), score: pl.score, time: pl.time ?? G.ROUND_CAP_SECONDS * 4000, aware: pl.aware ?? 0, at: pl.finishedAt || FieldValue.serverTimestamp() });
      tx.set(db.doc(`leaderboards/${hand}`), { players: inc(1), totalScore: inc(pl.score), tally: { [pl.score]: inc(1) } }, { merge: true });
      return true;
    });
    if (fresh) added++;
  }
  await pref.set({ listed: true }, { merge: true });
  return { added };
});

/* ---------- Delete everything about a player ---------- */
const deleteAccount = (async (_, uid) => {
  const pref = db.doc(`players/${uid}`);
  const p = await pref.get();
  for (const g of (p.exists && p.get("groupIds")) || []) await leave(uid, g);
  const plays = await pref.collection("plays").get();
  const months = await pref.collection("months").get();
  const secrets = await db.collection("playSecrets").where("uid", "==", uid).get();
  const docs = [...plays.docs.map(d => d.ref), ...months.docs.map(d => d.ref), ...plays.docs.map(d => db.doc(`leaderboards/${d.id}/entries/${uid}`)), ...secrets.docs.map(d => d.ref), pref];
  for (let i = 0; i < docs.length; i += 400) {
    const b = db.batch(); docs.slice(i, i + 400).forEach(d => b.delete(d)); await b.commit();
  }
  await auth.deleteUser(uid).catch(() => {});
  return { ok: true };
});

  return { startHand, startRound, submitRound, setName, getMe, claimScores, createGroup, joinGroup, leaveGroup, updateGroup, removeMember, newGroupCode, groupDay, groupMonth, adminStats, deleteAccount };
}
