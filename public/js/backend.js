// Talks to Firebase. Falls back to an offline demo (?demo=1, or when there's no Firebase config, e.g. a local file server).
import { makeEngine, finalScore } from "./engine.js";
import { DAYS, toHand, WILDCARD } from "./content.js";

const SDK = "https://www.gstatic.com/firebasejs/12.19.0/";
const EMAIL_KEY = "ss_signin_email";

// Where this visit came from, read before anything rewrites the address. The server keeps it only
// when it makes a new profile (first touch wins), and keeps just the tag and the referring site's name.
function visitSource() {
  const params = new URLSearchParams(location.search);
  let ref = params.get("ref") || (params.has("join") ? "invite" : "");
  if (params.has("ref")) {   // drop the tag from the address bar, so a shared link doesn't pass it on
    params.delete("ref");
    const q = params.toString();
    try { history.replaceState(history.state, "", location.pathname + (q ? "?" + q : "") + location.hash); } catch (_) {}
  }
  return { ref: ref.slice(0, 32), referrer: (document.referrer || "").slice(0, 2000) };
}

export async function createBackend() {
  const source = visitSource();
  const params = new URLSearchParams(location.search);
  if (!params.has("demo")) {
    let config = null;
    try { const r = await fetch("/__/firebase/init.json", { cache: "no-store" }); if (r.ok) config = await r.json(); } catch (_) {}
    if (config) return firebaseBackend(config, source);
  }
  return demoBackend();
}

function friendly(e) {
  const code = String(e && e.code || "").replace(/^functions\//, "");
  const msg = e && e.message;
  if (["unavailable", "internal", "deadline-exceeded"].includes(code) || /network|fetch/i.test(msg || ""))
    return Object.assign(new Error("Couldn't reach Strong Suit. Check your connection and try again."), { code });
  return Object.assign(new Error(msg || "Something went wrong."), { code });
}

async function firebaseBackend(config, source) {
  const [{ initializeApp }, A, F, Fn] = await Promise.all([
    import(SDK + "firebase-app.js"), import(SDK + "firebase-auth.js"),
    import(SDK + "firebase-firestore.js"), import(SDK + "firebase-functions.js"),
  ]);
  const app = initializeApp(config);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  const fns = Fn.getFunctions(app, "europe-west2");
  const call = name => async data => { try { return (await Fn.httpsCallable(fns, name)(data)).data; } catch (e) { throw friendly(e); } };
  const get = async path => { const s = await F.getDoc(F.doc(db, path)); return s.exists() ? s.data() : null; };
  let warmedAt = 0, warmedRoundsAt = 0;

  await auth.authStateReady();
  let linkNote = null;
  if (A.isSignInWithEmailLink(auth, location.href)) linkNote = await finishEmailLink().catch(e => ({ error: friendly(e).message }));
  if (!auth.currentUser) await A.signInAnonymously(auth);
  const uid = () => auth.currentUser.uid;

  async function finishEmailLink() {
    let email = null;
    try { email = localStorage.getItem(EMAIL_KEY); } catch (_) {}
    if (!email) email = prompt("Confirm your email address to finish signing in");
    if (!email) return null;
    const cred = A.EmailAuthProvider.credentialWithLink(email, location.href);
    const u = auth.currentUser;
    try {
      if (u && u.isAnonymous) await A.linkWithCredential(u, cred);
      else await A.signInWithCredential(auth, cred);
    } catch (e) {
      if (e.code === "auth/credential-already-in-use" || e.code === "auth/email-already-in-use") await A.signInWithCredential(auth, cred);
      else throw e;
    }
    try { localStorage.removeItem(EMAIL_KEY); } catch (_) {}
    const join = new URLSearchParams(location.search).get("join");   // a guest who signed up to join a group
    history.replaceState(null, "", location.pathname + (join ? "?join=" + encodeURIComponent(join) : ""));
    return { signedIn: email };
  }

  return {
    demo: false,
    linkNote,
    account() {
      const u = auth.currentUser;
      const p = u.providerData.find(x => x.providerId === "google.com") || u.providerData.find(x => x.providerId === "password" || x.providerId === "emailLink");
      return { uid: u.uid, anonymous: u.isAnonymous, email: u.email || (p && p.email) || null, provider: p ? p.providerId : null };
    },
    async signInGoogle() {
      const provider = new A.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      try {
        if (auth.currentUser.isAnonymous) await A.linkWithPopup(auth.currentUser, provider);
        else await A.signInWithPopup(auth, provider);
        return { merged: true };
      } catch (e) {
        if (e.code === "auth/credential-already-in-use") {
          const cred = A.GoogleAuthProvider.credentialFromError(e);
          await A.signInWithCredential(auth, cred);
          return { switched: true };   // they already had an account: today's anonymous progress stays with the old guest account
        }
        if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return { cancelled: true };
        throw friendly(e);
      }
    },
    async sendEmailLink(email, join) {   // join: a group code to offer once they're back, signed in
      const url = location.origin + "/" + (join ? "?join=" + encodeURIComponent(join) : "");
      await A.sendSignInLinkToEmail(auth, email, { url, handleCodeInApp: true }).catch(e => { throw friendly(e); });
      try { localStorage.setItem(EMAIL_KEY, email); } catch (_) {}
    },
    async signOut() { await A.signOut(auth); await A.signInAnonymously(auth); },

    config: () => get("config/app"),
    async getHand(n) {
      try { return await get(`hands/${n}`); }
      catch (e) { if (e.code === "permission-denied") return null; throw friendly(e); }
    },
    getPlay: n => get(`players/${uid()}/plays/${n}`),
    async getMe() {
      let me = await get(`players/${uid()}`);
      if (!me) { await call("getMe")({ source }); me = await get(`players/${uid()}`); }
      // just signed up (or signed up before this existed): put the hands they played as a guest on the leaderboard
      if (me && !me.listed && !auth.currentUser.isAnonymous) {
        await call("claimScores")({}).catch(() => {});
        me = (await get(`players/${uid()}`)) || me;
      }
      return me;
    },
    startHand: (n, ranking) => call("startHand")({ hand: n, ranking }),
    startRound: (n, bonus) => call("startRound")({ hand: n, bonus: !!bonus }),
    submitRound: (n, key, picks, timeMs) => call("submitRound")({ hand: n, key, picks, timeMs }),
    setName: name => call("setName")({ name }),

    async leaderboard(n) {
      const entries = F.collection(db, `leaderboards/${n}/entries`);
      const [sum, top, mine] = await Promise.all([
        get(`leaderboards/${n}`),
        F.getDocs(F.query(entries, F.orderBy("score", "desc"), F.orderBy("time", "asc"), F.limit(20))),   // ties go to the quicker player
        get(`leaderboards/${n}/entries/${uid()}`),
      ]);
      let mineRank = null;
      if (mine && sum) {
        const higher = Object.entries(sum.tally || {}).reduce((t, [sc, c]) => t + (+sc > mine.score ? c : 0), 0);
        const quicker = await F.getCountFromServer(F.query(entries, F.where("score", "==", mine.score), F.where("time", "<", mine.time ?? 0)))
          .then(r => r.data().count).catch(() => 0);
        mineRank = higher + quicker + 1;
      }
      return { summary: sum, top: top.docs.map(d => ({ uid: d.id, ...d.data() })), mine, mineRank };
    },
    async groups() {
      const me = await get(`players/${uid()}`);
      const ids = (me && me.groupIds) || [];
      const gs = await Promise.all(ids.map(id => get(`groups/${id}`).then(g => g && { id, ...g }).catch(() => null)));
      return gs.filter(Boolean);
    },
    async group(gid) { const g = await get(`groups/${gid}`); return g && { id: gid, ...g }; },
    groupDay: (gid, n) => call("groupDay")({ groupId: gid, hand: n }),
    groupMonth: (gid, month) => call("groupMonth")({ groupId: gid, month }),
    groupPreview: (code, n) => call("groupPreview")({ code, hand: n }),
    // Wakes the group functions while the player is still on the Groups list, so the group page doesn't wait
    // for a cold start. At most once every 5 minutes; failures don't matter.
    warmGroups() {
      if (Date.now() - warmedAt < 5 * 60000) return;
      warmedAt = Date.now();
      ["groupDay", "groupMonth"].forEach(n => Fn.httpsCallable(fns, n)({ warm: true }).catch(() => {}));
    },
    // The same for the functions a hand uses, while the player is on the home or ranking screen: an idle function
    // takes 2-3 seconds to start, which otherwise lands on their first round. At most once every 5 minutes.
    warmRounds() {
      if (Date.now() - warmedRoundsAt < 5 * 60000) return;
      warmedRoundsAt = Date.now();
      ["startHand", "startRound", "submitRound"].forEach(n => Fn.httpsCallable(fns, n)({ warm: true }).catch(() => {}));
    },
    globalFamilies: () => get("stats/families").then(d => (d && d.families) || {}).catch(() => ({})),
    async myPlays() {   // every hand you've started, keyed by hand number
      const qs = await F.getDocs(F.collection(db, `players/${uid()}/plays`));
      return Object.fromEntries(qs.docs.map(d => [d.id, d.data()]));
    },
    createGroup: (name, symbol) => call("createGroup")({ name, symbol }),
    updateGroup: (groupId, changes) => call("updateGroup")({ groupId, ...changes }),
    removeMember: (groupId, memberUid) => call("removeMember")({ groupId, memberUid }),
    newGroupCode: groupId => call("newGroupCode")({ groupId }),
    async groupMembers(gid) {
      const ms = await F.getDocs(F.collection(db, `groups/${gid}/members`));
      return ms.docs.map(d => ({ uid: d.id, name: d.data().name }));
    },
    joinGroup: code => call("joinGroup")({ code }),
    leaveGroup: groupId => call("leaveGroup")({ groupId }),
    async deleteAccount() { await call("deleteAccount")({}); await A.signOut(auth).catch(() => {}); await A.signInAnonymously(auth); },
  };
}

/* ---------- Demo: everything in this browser, using the four prototype hands ---------- */
function demoBackend() {
  const KEY = "ss_demo_v1";
  let st = {};
  try { st = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (_) {}
  st.plays ||= {}; st.me ||= { name: "Player " + (1000 + Math.floor(Math.random() * 9000)), groupIds: [], stats: {} }; st.groups ||= {};
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (_) {} };
  const today = new Date();
  const pre = new URLSearchParams(location.search).has("prelaunch");   // ?demo=1&prelaunch=1 shows the countdown page
  const launch = new Date(today.getFullYear(), today.getMonth(), today.getDate() + (pre ? 3 : -(DAYS.length - 1)));
  const ymd = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const hands = {}, hands_ = hands;
  DAYS.forEach((cats, i) => {
    const h = toHand(cats, i + 1);
    h.date = ymd(new Date(launch.getFullYear(), launch.getMonth(), launch.getDate() + i));
    hands[i + 1] = h;
  });
  // made-up rivals so the leaderboards have something in them
  const bots = ["Ada", "Bea", "Cal", "Dev", "Eli", "Fin", "Gus", "Hal", "Ivy", "Jo"].map((name, i) => ({ uid: "bot" + i, name, seed: i }));
  const engine = makeEngine({
    hands, plays: st.plays, onSave: save,
    onFinish(n, p) {
      const s = st.me.stats;
      s.played = (s.played || 0) + 1; s.totalScore = (s.totalScore || 0) + p.score; s.awareTotal = (s.awareTotal || 0) + p.aware;
      s.bestScore = Math.max(s.bestScore || 0, p.score);
      s.streak = s.lastHand === n - 1 ? (s.streak || 0) + 1 : 1; s.bestStreak = Math.max(s.bestStreak || 0, s.streak); s.lastHand = n;
      s.families ||= {};
      const fam = f => f === WILDCARD ? {} : (s.families[f] ||= { dealt: 0, skipped: 0, rounds: 0, correct: 0 });
      p.categories.forEach(c => fam(c.family).dealt++);
      fam(p.categories[p.skipped].family).skipped++;
      [0, 1, 2, 3].forEach(k => { const r = p.rounds[k]; const f = fam(r.family); f.rounds++; f.correct += r.correct; });
    },
  });
  // a whole made-up play for a bot, so group pages have rankings and picks to show
  const rng = seed => { let s = seed >>> 0 || 1; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; };
  const shuf = (a, r) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  function botPlay(b, n) {
    const h = hands[n];
    if (!h || (b.seed + n) % 4 === 1) return null;   // bots miss the odd day
    const r = rng(b.seed * 1000 + n * 7 + 1);
    const ranking = shuf([0, 1, 2, 3, 4], r), order = ranking.slice(0, 4).reverse(), skipped = ranking[4];
    const mk = (slot, mult) => {
      const c = Math.floor(r() * 7), idx = shuf([0, 1, 2, 3, 4, 5], r), wrong = idx.slice(c), chosen = [];
      idx.slice(0, c).forEach(i => (chosen[i] = i));
      wrong.forEach((i, j) => (chosen[i] = wrong.length > 1 ? wrong[(j + 1) % wrong.length] : null));
      const cat = h.categories[slot];
      return { slot, mult, label: cat.label, family: cat.family, correct: c, marks: chosen.map((x, i) => x === i), review: { chosen } };
    };
    const rounds = {}; order.forEach((slot, k) => (rounds[k] = mk(slot, k + 1)));
    const bonus = r() < 0.5 ? mk(skipped, 0) : null;
    const time = [0, 1, 2, 3].reduce(t => t + 15000 + Math.floor(r() * 75000), 0);
    return { status: "done", ranking, order, skipped, categories: h.categories, rounds, bonus, time, ...finalScore([0, 1, 2, 3].map(k => rounds[k].correct)) };
  }
  const nameOf = uid => (uid === "me" ? st.me.name : (bots.find(b => b.uid === uid) || {}).name);
  const playOf = (uid, n) => (uid === "me" ? st.plays[n] || null : botPlay(bots.find(b => b.uid === uid), n));
  const entries = n => {
    const list = bots.map(b => ({ b, p: botPlay(b, n) })).filter(x => x.p).map(({ b, p }) => ({ uid: b.uid, name: b.name, score: p.score, time: p.time, aware: p.aware }));
    const p = st.plays[n];
    if (p && p.status === "done" && st.email) list.push({ uid: "me", name: st.me.name, score: p.score, time: p.time, aware: p.aware });   // guests aren't listed
    return list;
  };
  // an invite to try in demo mode: ?demo=1&join=PUBQZ2
  const DEMO_INVITE = { code: "PUBQZ2", name: "The Pub Quizzers", symbol: "beer", members: ["bot0", "bot2", "bot3", "bot5", "bot7"] };
  const guestError = () => Object.assign(new Error("Create a free account to join groups. Your scores so far come with you."), { code: "failed-precondition" });
  const code = () => Array.from({ length: 6 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)]).join("");
  return {
    demo: true, linkNote: null,
    account: () => ({ uid: "me", anonymous: !st.email, email: st.email || null, provider: st.email ? "demo" : null }),
    async signInGoogle() { st.email = "you@example.com"; save(); return { merged: true }; },
    async sendEmailLink(email) { st.email = email; save(); },
    async signOut() { delete st.email; save(); },
    config: async () => ({ launchDate: ymd(launch) }),
    getHand: async n => (hands[n] ? { number: n, date: hands[n].date, categories: hands[n].categories } : null),
    getPlay: engine.getPlay,
    getMe: async () => structuredClone(st.me),
    startHand: engine.startHand, startRound: engine.startRound, submitRound: engine.submitRound,
    async setName(name) { st.me.name = String(name).trim().slice(0, 20); save(); return { name: st.me.name }; },
    async leaderboard(n) {
      const list = entries(n).sort((a, b) => b.score - a.score || a.time - b.time);
      const tally = {}; list.forEach(e => (tally[e.score] = (tally[e.score] || 0) + 1));
      const i = list.findIndex(e => e.uid === "me");
      return { summary: { players: list.length, tally, totalScore: list.reduce((s, e) => s + e.score, 0) }, top: list.slice(0, 20), mine: i < 0 ? null : list[i], mineRank: i < 0 ? null : i + 1 };
    },
    groups: async () => st.me.groupIds.map(id => ({ id, ...st.groups[id] })),
    group: async gid => (st.groups[gid] ? { id: gid, ...st.groups[gid] } : null),
    warmGroups() {},
    warmRounds() {},
    // same shapes as the server's groupDay and groupMonth
    async groupDay(gid, n) {
      const g = st.groups[gid], h = hands_[n];
      if (!g) throw Object.assign(new Error("You're not in that group."), { code: "permission-denied" });
      if (!h) throw Object.assign(new Error("That hand isn't open yet."), { code: "not-found" });
      const plays = Object.fromEntries(g.members.map(uid => [uid, playOf(uid, n)]));
      const mine = plays.me, canSee = !!(mine && mine.status === "done");
      const members = g.members.map(uid => {
        const p = plays[uid], row = { uid, name: nameOf(uid), status: p ? p.status : null };
        if (p && p.status === "done") Object.assign(row, { score: p.score, best: p.best, aware: p.aware, time: p.time ?? null });
        if (canSee && p && p.status === "done") Object.assign(row, { ranking: p.ranking, skipped: p.skipped });
        return row;
      });
      const out = { hand: n, date: h.date, categories: h.categories.map(c => ({ slot: c.slot, label: c.label, family: c.family })), members, canSee, bonusDone: !!(mine && mine.bonus) };
      if (!canSee) return out;
      out.rounds = h.categories.map(c => {
        if (c.slot === mine.skipped && !mine.bonus) return { slot: c.slot, locked: true };
        const k = h.rounds[c.slot], picks = {};
        g.members.forEach(uid => {
          const p = plays[uid];
          if (!p || p.status !== "done") return;
          const r = Object.values(p.rounds).find(x => x.slot === c.slot) || (p.bonus && p.bonus.slot === c.slot ? p.bonus : null);
          picks[uid] = r ? { mult: r.mult, chosen: r.review.chosen, correct: r.correct } : { mult: null };
        });
        return { slot: c.slot, prompts: k.prompts, answers: k.answers, fact: k.fact, src: k.src, picks };
      });
      return structuredClone(out);
    },
    async groupMonth(gid, month) {
      const g = st.groups[gid];
      if (!g) throw Object.assign(new Error("You're not in that group."), { code: "permission-denied" });
      const ns = Object.keys(hands_).map(Number).filter(n => month === "all" || hands_[n].date.startsWith(month));
      return {
        month,
        members: g.members.map(uid => {
          const m = { uid, name: nameOf(uid), played: 0, total: 0, time: 0, best: 0, families: {} };
          ns.forEach(n => {
            const p = playOf(uid, n);
            if (!p || p.status !== "done") return;
            m.played++; m.total += p.score; m.time += p.time || 0; m.best = Math.max(m.best, p.score);
            const fam = f => f === WILDCARD ? {} : (m.families[f] ||= { dealt: 0, skipped: 0, rounds: 0, correct: 0 });
            p.categories.forEach(c => fam(c.family).dealt++);
            fam(p.categories[p.skipped].family).skipped++;
            [0, 1, 2, 3].forEach(k => { const f = fam(p.rounds[k].family); f.rounds++; f.correct += p.rounds[k].correct; });
          });
          return m;
        }),
      };
    },
    myPlays: async () => structuredClone(st.plays),
    async globalFamilies() {   // everyone's totals per subject: the bots plus you
      const fams = {};
      const fam = f => f === WILDCARD ? {} : (fams[f] ||= { dealt: 0, skipped: 0, rounds: 0, correct: 0 });
      Object.keys(hands_).forEach(n => [...bots.map(b => botPlay(b, +n)), st.plays[n]].forEach(p => {
        if (!p || p.status !== "done") return;
        p.categories.forEach(c => fam(c.family).dealt++);
        fam(p.categories[p.skipped].family).skipped++;
        [0, 1, 2, 3].forEach(k => { const f = fam(p.rounds[k].family); f.rounds++; f.correct += p.rounds[k].correct; });
      }));
      return fams;
    },
    async createGroup(name, symbol) {
      if (!st.email) throw guestError();
      const id = "g" + Date.now(); const c = code();
      st.groups[id] = { name, symbol: symbol || "club", code: c, memberCount: 3, cap: 10, ownerUid: "me", members: ["me", "bot1", "bot4"] };
      st.me.groupIds.push(id); save(); return { groupId: id, code: c };
    },
    async updateGroup(id, changes) { Object.assign(st.groups[id], changes); save(); return changes; },
    async removeMember(id, uid) { const g = st.groups[id]; g.members = g.members.filter(m => m !== uid); g.memberCount = g.members.length; save(); return { ok: true }; },
    async newGroupCode(id) { st.groups[id].code = code(); save(); return { code: st.groups[id].code }; },
    groupMembers: async id => st.groups[id].members.map(uid => ({ uid, name: nameOf(uid) })),
    async groupPreview(c, n) {
      c = String(c || "").toUpperCase();
      const own = Object.values(st.groups).find(g => g.code === c);
      const g = own || (c === DEMO_INVITE.code ? { ...DEMO_INVITE, memberCount: DEMO_INVITE.members.length, cap: 10 } : null);
      if (!g) throw Object.assign(new Error("That invite code doesn't work any more."), { code: "not-found" });
      const member = g.members.includes("me"), mine = st.plays[n];
      const out = { code: c, name: g.name, symbol: g.symbol, memberCount: g.memberCount, full: g.memberCount >= g.cap, member, hand: n, finished: false };
      if (member || !hands_[n] || !(mine && mine.status === "done")) return out;
      out.finished = true;
      out.members = g.members.map(uid => {
        const p = playOf(uid, n), row = { name: nameOf(uid), status: p ? p.status : null };
        if (p && p.status === "done") Object.assign(row, { score: p.score, time: p.time ?? null });
        return row;
      });
      return out;
    },
    async joinGroup(c) {
      if (!st.email) throw guestError();
      if (String(c).toUpperCase() === DEMO_INVITE.code && !Object.values(st.groups).some(g => g.code === DEMO_INVITE.code))
        st.groups["gdemo"] = { name: DEMO_INVITE.name, symbol: DEMO_INVITE.symbol, code: DEMO_INVITE.code, memberCount: DEMO_INVITE.members.length, cap: 10, ownerUid: "bot0", members: DEMO_INVITE.members.slice() };
      const id = Object.keys(st.groups).find(k => st.groups[k].code === String(c).toUpperCase());
      if (!id) throw Object.assign(new Error("No group has that code."), { code: "not-found" });
      if (!st.me.groupIds.includes(id)) { st.me.groupIds.push(id); st.groups[id].members.push("me"); st.groups[id].memberCount++; }
      save(); return { groupId: id, name: st.groups[id].name };
    },
    async leaveGroup(id) { st.me.groupIds = st.me.groupIds.filter(x => x !== id); delete st.groups[id]; save(); return { ok: true }; },
    async deleteAccount() { localStorage.removeItem(KEY); location.reload(); },
    _finalScore: finalScore,
  };
}
