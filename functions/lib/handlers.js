// Game handlers with their dependencies passed in, so tests can run them against an in-memory database.
import * as G from "./game.js";
import { createHash } from "node:crypto";
import { allowedName } from "./names.js";

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

/* ---------- 1. Lock in the ranking ---------- */
const startHand = (async ({ hand, ranking }, uid) => {
  needHand(hand);
  if (!G.checkRanking(ranking)) fail("invalid-argument", "Rank all five categories.");
  const r = refs(uid, hand);
  return db.runTransaction(async tx => {
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
    return { order, skipped };
  });
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
      deadline: Timestamp.fromMillis(now() + (LEAD_SECONDS + G.ROUND_SECONDS) * 1000),
    };
    tx.update(r.play, { current: next });
    tx.set(r.secret, { uid, hand, key, perm });
    return payload(next);
  });
});
const payload = c => ({ ...c, deadline: c.deadline.toMillis(), now: now(), seconds: G.ROUND_SECONDS });

/* ---------- 3. Check a round; after round four, score the hand ---------- */
const submitRound = (async ({ hand, key, picks, timeMs }, uid) => {
  needHand(hand);
  if (!G.checkPicks(picks)) fail("invalid-argument", "Those answers don't look right.");
  const r = refs(uid, hand);
  const out = await db.runTransaction(async tx => {
    const [play, secret, keys, player] = await Promise.all([tx.get(r.play), tx.get(r.secret), tx.get(r.key), tx.get(r.player)]);
    if (!play.exists) fail("failed-precondition", "Rank your hand first.");
    const p = play.data(), cur = p.current;
    if (!cur || cur.key !== key || !secret.exists) fail("failed-precondition", "That round isn't in play.");
    const late = now() > cur.deadline.toMillis() + G.GRACE_SECONDS * 1000;
    // time taken by the server's clock (the round starts when the 3-2-1 countdown ends): the leaderboard tie-break
    const serverMs = Math.min(G.ROUND_SECONDS * 1000, Math.max(0, now() - (cur.deadline.toMillis() - G.ROUND_SECONDS * 1000)));
    const { chosen, marks, correct } = G.markRound(secret.get("perm"), picks, late);
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
        final.time = [0, 1, 2].map(k => p.rounds[k].serverMs ?? G.ROUND_SECONDS * 1000).reduce((a, b) => a + b, serverMs);
        Object.assign(upd, { status: "done", finishedAt: FieldValue.serverTimestamp(), ...final });
        const pl = player.exists ? player.data() : newPlayer(uid);
        const st = pl.stats || {};
        const streak = G.nextStreak(st, hand);
        // per subject: times dealt, skipped, played, and pairs right
        const families = {};
        const fam = f => (families[f] ||= {});
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
    return { result, final, rounds: p.rounds, skipped: p.categories[p.skipped] };
  });

  // Leaderboards and category stats sit outside the transaction: they're tallies, not the record.
  const b = db.batch();
  const inc = FieldValue.increment;
  if (out.final) {
    const f = out.final;
    b.set(db.doc(`leaderboards/${hand}`), { players: inc(1), totalScore: inc(f.score), tally: { [f.score]: inc(1) } }, { merge: true });
    b.set(db.doc(`leaderboards/${hand}/entries/${uid}`), { name: f.name, score: f.score, time: f.time, aware: f.aware, at: FieldValue.serverTimestamp() });
    [0, 1, 2].map(k => out.rounds[k]).concat(out.result).forEach(x =>
      b.set(db.doc(`categoryStats/${x.categoryId}`), { played: inc(1), correct: inc(x.correct) }, { merge: true }));
    b.set(db.doc(`categoryStats/${out.skipped.categoryId}`), { skipped: inc(1) }, { merge: true });
    b.set(db.doc("stats/families"), { families: f.families }, { merge: true });   // everyone's subject averages, for profiles
  } else if (key === "bonus") {
    b.set(db.doc(`categoryStats/${out.result.categoryId}`), { bonusPlayed: inc(1), bonusCorrect: inc(out.result.correct) }, { merge: true });
  }
  await b.commit().catch(e => console.error("tally update failed", hand, uid, e));
  const res = { result: out.result };
  if (out.final) res.final = { score: out.final.score, best: out.final.best, aware: out.final.aware, time: out.final.time };
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

const getMe = (async (_, uid) => {
  const pref = db.doc(`players/${uid}`);
  return db.runTransaction(async tx => {
    const p = await tx.get(pref);
    if (p.exists) return { created: false };
    tx.set(pref, newPlayer(uid));
    return { created: true };
  });
});

/* ---------- Groups ---------- */
const createGroup = (async ({ name }, uid) => {
  const n = G.cleanGroupName(name);
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
      tx.set(gref, { name: n, ownerUid: uid, code, memberCount: 1, cap: pl.plus ? 50 : G.FREE_GROUP_CAP, createdAt: FieldValue.serverTimestamp() });
      tx.set(gref.collection("members").doc(uid), { name: pl.name, joinedAt: FieldValue.serverTimestamp() });
      tx.set(db.doc(`groupCodes/${code}`), { groupId: gref.id });
      tx.set(pref, { groupIds: FieldValue.arrayUnion(gref.id) }, { merge: true });
      return true;
    });
    if (ok) return { groupId: gref.id, code };
  }
  fail("unavailable", "Couldn't make a group code. Try again.");
});

const joinGroup = (async ({ code }, uid) => {
  const c = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length !== 6) fail("invalid-argument", "Group codes are six characters.");
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

/* ---------- Delete everything about a player ---------- */
const deleteAccount = (async (_, uid) => {
  const pref = db.doc(`players/${uid}`);
  const p = await pref.get();
  for (const g of (p.exists && p.get("groupIds")) || []) await leave(uid, g);
  const plays = await pref.collection("plays").get();
  const months = await pref.collection("months").get();
  const secrets = await db.collection("playSecrets").where("uid", "==", uid).get();
  const waits = await db.collection("waitlist").where("uid", "==", uid).get();
  const docs = [...plays.docs.map(d => d.ref), ...months.docs.map(d => d.ref), ...plays.docs.map(d => db.doc(`leaderboards/${d.id}/entries/${uid}`)), ...secrets.docs.map(d => d.ref), ...waits.docs.map(d => d.ref), pref];
  for (let i = 0; i < docs.length; i += 400) {
    const b = db.batch(); docs.slice(i, i + 400).forEach(d => b.delete(d)); await b.commit();
  }
  await auth.deleteUser(uid).catch(() => {});
  return { ok: true };
});

/* ---------- Launch waitlist: one email on launch day, nothing else ---------- */
const joinWaitlist = (async ({ email }, uid) => {
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail("invalid-argument", "That doesn't look like an email address.");
  const id = createHash("sha256").update(e).digest("hex");
  await db.doc(`waitlist/${id}`).set({ email: e, uid, joinedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
});

  return { startHand, startRound, submitRound, setName, getMe, createGroup, joinGroup, leaveGroup, groupDay, groupMonth, deleteAccount, joinWaitlist };
}
