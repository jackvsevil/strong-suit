// Talks to Firebase. Falls back to an offline demo (?demo=1, or when there's no Firebase config, e.g. a local file server).
import { makeEngine, finalScore } from "./engine.js";
import { DAYS, toHand } from "./content.js";

const SDK = "https://www.gstatic.com/firebasejs/12.19.0/";
const EMAIL_KEY = "ss_signin_email";

export async function createBackend() {
  const params = new URLSearchParams(location.search);
  if (!params.has("demo")) {
    let config = null;
    try { const r = await fetch("/__/firebase/init.json", { cache: "no-store" }); if (r.ok) config = await r.json(); } catch (_) {}
    if (config) return firebaseBackend(config);
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

async function firebaseBackend(config) {
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
    history.replaceState(null, "", location.pathname);
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
    async sendEmailLink(email) {
      await A.sendSignInLinkToEmail(auth, email, { url: location.origin + "/", handleCodeInApp: true }).catch(e => { throw friendly(e); });
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
      if (!me) { await call("getMe")({}); me = await get(`players/${uid()}`); }
      return me;
    },
    startHand: (n, ranking) => call("startHand")({ hand: n, ranking }),
    startRound: (n, bonus) => call("startRound")({ hand: n, bonus: !!bonus }),
    submitRound: (n, key, picks, timeMs) => call("submitRound")({ hand: n, key, picks, timeMs }),
    setName: name => call("setName")({ name }),

    async leaderboard(n) {
      const [sum, top, mine] = await Promise.all([
        get(`leaderboards/${n}`),
        F.getDocs(F.query(F.collection(db, `leaderboards/${n}/entries`), F.orderBy("score", "desc"), F.limit(20))),
        get(`leaderboards/${n}/entries/${uid()}`),
      ]);
      return { summary: sum, top: top.docs.map(d => ({ uid: d.id, ...d.data() })), mine };
    },
    async groups() {
      const me = await get(`players/${uid()}`);
      const ids = (me && me.groupIds) || [];
      const gs = await Promise.all(ids.map(id => get(`groups/${id}`).then(g => g && { id, ...g }).catch(() => null)));
      return gs.filter(Boolean);
    },
    async groupBoard(gid, n) {
      const ms = await F.getDocs(F.collection(db, `groups/${gid}/members`));
      const rows = await Promise.all(ms.docs.map(async d => {
        const e = await get(`leaderboards/${n}/entries/${d.id}`).catch(() => null);
        return { uid: d.id, name: d.data().name, score: e ? e.score : null, aware: e ? e.aware : null };
      }));
      return rows;
    },
    createGroup: name => call("createGroup")({ name }),
    joinGroup: code => call("joinGroup")({ code }),
    joinWaitlist: email => call("joinWaitlist")({ email }),
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
  const hands = {};
  DAYS.forEach((cats, i) => {
    const h = toHand(cats, i + 1);
    h.date = ymd(new Date(launch.getFullYear(), launch.getMonth(), launch.getDate() + i));
    hands[i + 1] = h;
  });
  // made-up rivals so the leaderboards have something in them
  const bots = ["Ada", "Bea", "Cal", "Dev", "Eli", "Fin", "Gus", "Hal", "Ivy", "Jo"].map((name, i) => ({ uid: "bot" + i, name, seed: i }));
  const botScore = (b, n) => (b.seed * 7 + n * 13) % 47 + 8;
  const engine = makeEngine({
    hands, plays: st.plays, onSave: save,
    onFinish(n, p) {
      const s = st.me.stats;
      s.played = (s.played || 0) + 1; s.totalScore = (s.totalScore || 0) + p.score; s.awareTotal = (s.awareTotal || 0) + p.aware;
      s.bestScore = Math.max(s.bestScore || 0, p.score);
      s.streak = s.lastHand === n - 1 ? (s.streak || 0) + 1 : 1; s.bestStreak = Math.max(s.bestStreak || 0, s.streak); s.lastHand = n;
      s.families ||= {};
      [0, 1, 2, 3].forEach(k => { const r = p.rounds[k]; const f = (s.families[r.family] ||= { rounds: 0, correct: 0 }); f.rounds++; f.correct += r.correct; });
    },
  });
  const entries = n => {
    const list = bots.map(b => ({ uid: b.uid, name: b.name, score: botScore(b, n), aware: 60 + (b.seed * 11 + n) % 41 }));
    const p = st.plays[n];
    if (p && p.status === "done") list.push({ uid: "me", name: st.me.name, score: p.score, aware: p.aware });
    return list;
  };
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
      const list = entries(n).sort((a, b) => b.score - a.score);
      const tally = {}; list.forEach(e => (tally[e.score] = (tally[e.score] || 0) + 1));
      return { summary: { players: list.length, tally, totalScore: list.reduce((s, e) => s + e.score, 0) }, top: list.slice(0, 20), mine: list.find(e => e.uid === "me") || null };
    },
    groups: async () => st.me.groupIds.map(id => ({ id, ...st.groups[id] })),
    async groupBoard(gid, n) {
      const g = st.groups[gid]; const all = entries(n);
      return g.members.map(uid => { const e = all.find(x => x.uid === uid); return { uid, name: uid === "me" ? st.me.name : (bots.find(b => b.uid === uid) || {}).name, score: e ? e.score : null, aware: e ? e.aware : null }; });
    },
    async createGroup(name) {
      const id = "g" + Date.now(); const c = code();
      st.groups[id] = { name, code: c, memberCount: 3, cap: 10, ownerUid: "me", members: ["me", "bot1", "bot4"] };
      st.me.groupIds.push(id); save(); return { groupId: id, code: c };
    },
    async joinGroup(c) {
      const id = Object.keys(st.groups).find(k => st.groups[k].code === String(c).toUpperCase());
      if (!id) throw Object.assign(new Error("No group has that code."), { code: "not-found" });
      if (!st.me.groupIds.includes(id)) { st.me.groupIds.push(id); st.groups[id].members.push("me"); st.groups[id].memberCount++; }
      save(); return { groupId: id, name: st.groups[id].name };
    },
    async joinWaitlist(email) { st.waitlist = email; save(); return { ok: true }; },
    async leaveGroup(id) { st.me.groupIds = st.me.groupIds.filter(x => x !== id); delete st.groups[id]; save(); return { ok: true }; },
    async deleteAccount() { localStorage.removeItem(KEY); location.reload(); },
    _finalScore: finalScore,
  };
}
