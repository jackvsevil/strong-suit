// Strong Suit, version 1. Screens and game flow; all checking and scoring of real hands happens on the server.
import { createBackend } from "./backend.js";
import { makeEngine } from "./engine.js";
import { TUTORIAL, FAMILY_EMOJI, toHand } from "./content.js";

const ROUND_SECONDS = 45;
const SITE = "https://strongsuitgame.com";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const famLabel = f => '<span class="emo" aria-hidden="true">' + (FAMILY_EMOJI[f] || "") + "</span>" + esc(f);
const first = label => String(label).split(" → ")[0];

/* ---------- small UI helpers ---------- */
const SCREENS = ["loading", "home", "setup", "ready", "round", "reveal", "results", "board", "groups", "group", "hands", "profile"];
const NAV_FOR = { group: "groups", board: "groups" };
function show(id) {
  document.body.classList.toggle("inround", id === "round");
  SCREENS.forEach(s => ($(s).hidden = s !== id));
  document.querySelectorAll(".nav button[data-go]").forEach(b => b.classList.toggle("on", b.dataset.go === (NAV_FOR[id] || id)));
  window.scrollTo(0, 0);
}
function barVis() { $("bar").hidden = !$("barInner").children.length && $("coach").hidden; }
function bar(buttons) {
  const b = $("barInner"); b.innerHTML = "";
  buttons.forEach(o => {
    const el = document.createElement("button");
    el.className = "btn" + (o.ghost ? " ghost" : ""); el.textContent = o.label; el.disabled = !!o.disabled; el.onclick = o.onClick;
    b.appendChild(el);
  });
  barVis();
}
function coach(msg) {
  const c = $("coach");
  if (!(G && G.tut) || !msg) { c.hidden = true; c.innerHTML = ""; c.dataset.msg = ""; barVis(); return; }
  if (c.dataset.msg !== msg) { c.innerHTML = '<span class="tag">Practice hand</span>' + msg; c.dataset.msg = msg; c.style.animation = "none"; c.offsetHeight; c.style.animation = ""; }
  c.hidden = false; barVis();
}
function toast(msg, ms = 2400) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms); }
function busy(on) { document.body.classList.toggle("busy", !!on); }
/** A small dialog. Resolves true/false, or the input's value when `input` is given. */
function ask({ title, text = "", ok = "OK", cancel = "Cancel", input = null, danger = false }) {
  return new Promise(resolve => {
    const m = $("ask");
    $("askTitle").textContent = title; $("askText").textContent = text; $("askText").hidden = !text;
    const inp = $("askInput"); inp.hidden = !input;
    if (input) { inp.value = input.value || ""; inp.placeholder = input.placeholder || ""; inp.maxLength = input.max || 40; }
    $("askOk").textContent = ok; $("askOk").classList.toggle("danger", danger); $("askCancel").textContent = cancel;
    const done = v => { m.hidden = true; $("askOk").onclick = $("askCancel").onclick = null; resolve(v); };
    $("askOk").onclick = () => done(input ? inp.value.trim() : true);
    $("askCancel").onclick = () => done(input ? null : false);
    m.hidden = false; (input ? inp : $("askOk")).focus();
  });
}

/* ---------- dates: hand N is the Nth local day from launch ---------- */
const ymd = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const dayNum = s => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const handFor = (launch, date) => dayNum(date) - dayNum(launch) + 1;
const dateOf = (launch, n) => { const [y, m, d] = launch.split("-").map(Number); return new Date(y, m - 1, d + n - 1); };
const fmtDay = d => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
function untilMidnight() {
  const now = new Date(), mid = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const m = Math.max(0, Math.round((mid - now) / 60000));
  return m >= 60 ? Math.floor(m / 60) + "h " + (m % 60) + "m" : m + "m";
}

/* ---------- themed days: card backs, the middle card's symbol and (when artwork exists) the logo ---------- */
// Keyed by the player's local date: "MM-DD" every year, or "YYYY-MM-DD" for dates that move.
// logo: true looks for brand/themes/<id>-light.png and -dark.png, and keeps the normal logo if they're missing.
const THEMES = {
  "10-31": { id: "halloween", sym: "🎃", logo: true },
  "11-01": { id: "movember", sym: "🥸" },
  "11-05": { id: "bonfire", sym: "🎆" },
  "2026-11-08": { id: "diwali", sym: "🪔" },
  "11-30": { id: "standrews", sym: "🦄" },
  "12-25": { id: "christmas", sym: "🎄" },
  "12-31": { id: "nye", sym: "🥂" },
};
function themeFor(d) {
  const forced = new URLSearchParams(location.search).get("theme");   // ?theme=halloween previews a theme
  if (forced) return Object.values(THEMES).find(t => t.id === forced) || null;
  const iso = ymd(d);
  return THEMES[iso] || THEMES[iso.slice(5)] || null;
}
let themeNow;
function applyTheme() {
  const t = themeFor(new Date());
  if ((t && t.id) === (themeNow && themeNow.id)) return;
  themeNow = t;
  document.body.className = document.body.className.replace(/\btheme-\S+/g, "").trim();
  if (t) document.body.classList.add("theme-" + t.id);
  $("fanTop").dataset.sym = t ? t.sym : "♠";
  const brand = $("homeLink"), svg = brand.querySelector("svg.wordmark");
  brand.querySelector("img.wordmark")?.remove(); svg.removeAttribute("hidden");
  if (t && t.logo) {
    const img = new Image(), dark = matchMedia("(prefers-color-scheme: dark)");
    img.className = "wordmark"; img.alt = "Strong Suit";
    const pick = () => (img.src = "brand/themes/" + t.id + "-" + (dark.matches ? "dark" : "light") + ".png");
    img.onload = () => { if (!img.isConnected) { brand.prepend(img); svg.setAttribute("hidden", ""); } };   // only once the artwork has loaded
    img.onerror = () => { img.remove(); svg.removeAttribute("hidden"); };
    dark.addEventListener("change", pick); pick();
  }
}

/* ---------- state ---------- */
let api;
const S = { config: {}, me: null, n: null, hand: null, play: null };
let G = null;   // the game in progress: { eng, n, hand, play, tut, bonus, payload, respAt, round, last }
let timerId = null;

async function refreshMe() { S.me = await api.getMe().catch(() => S.me); return S.me; }

/* ---------- home ---------- */
async function renderHome() {
  G = null; coach(""); document.body.classList.remove("tut");
  applyTheme();
  const launch = S.config.launchDate;
  const today = ymd(new Date());
  S.n = launch ? handFor(launch, today) : null;
  $("homeDate").textContent = fmtDay(new Date());
  const stats = (S.me && S.me.stats) || {};
  $("homeStats").innerHTML = stats.played
    ? '<span><b>' + stats.played + "</b> played</span><span><b>" + (stats.streak && stats.lastHand >= S.n - 1 ? stats.streak : 0) + "</b> day streak</span><span><b>" + Math.round(stats.totalScore / stats.played) + "</b> average</span>"
    : "";
  $("homeStats").hidden = !stats.played;
  if (!launch || S.n < 1) {
    $("homeTitle").textContent = "Coming soon";
    $("homeSub").textContent = launch ? "Hand #1 opens on " + fmtDay(dateOf(launch, 1)) + ". Try the practice hand while you wait." : "The first hand is on its way. Try the practice hand while you wait.";
    bar([{ label: "Try the practice hand", onClick: startTutorial }]);
    return show("home");
  }
  $("homeTitle").textContent = "Hand #" + S.n;
  S.hand = await api.getHand(S.n).catch(() => null);
  S.play = S.hand ? await api.getPlay(S.n).catch(() => null) : null;
  if (!S.hand) {
    $("homeSub").textContent = "Today's hand isn't ready yet. Check back soon.";
    bar([{ label: "Try the practice hand", ghost: true, onClick: startTutorial }]);
  } else if (S.play && S.play.status === "done") {
    $("homeSub").textContent = "You scored " + S.play.score + "/60 today. The next hand opens in " + untilMidnight() + ".";
    bar([{ label: "See today's result", onClick: () => openHand(S.n) }]);
  } else if (S.play) {
    $("homeSub").textContent = "You're part-way through today's hand.";
    bar([{ label: "Carry on", onClick: () => openHand(S.n) }]);
  } else {
    $("homeSub").textContent = "Five categories. Skip one, then play the rest for rising stakes.";
    bar([{ label: "Play hand #" + S.n, onClick: () => openHand(S.n) }]);
  }
  show("home");
}

/* ---------- open a hand: rank it, carry on, or see the result ---------- */
async function openHand(n, from) {
  S.from = from || null;   // "hands" when opened from Your hands, so Back returns there
  busy(true);
  try {
    const hand = n === S.n && S.hand ? S.hand : await api.getHand(n);
    if (!hand) { toast("That hand isn't open yet."); return renderHome(); }
    const play = await api.getPlay(n);
    G = { eng: api, n, hand, play, tut: false, bonus: false };
    if (!play) return renderSetup(true);
    if (play.status === "done") return renderResults();
    if (play.current) { G.bonus = play.current.key === "bonus"; return readyRound(); }
    readyRound();
  } catch (e) { toast(e.message); renderHome(); }
  finally { busy(false); }
}

function startTutorial() {
  closeHow();
  const hand = toHand(TUTORIAL, 0);
  const plays = {};
  G = { eng: makeEngine({ hands: { 0: hand }, plays }), n: 0, hand, play: null, tut: true, bonus: false };
  document.body.classList.add("tut");
  renderSetup(true);
}

/* ---------- setup: tap cards strongest first; the one left over is skipped ---------- */
let ranked = [];
function renderSetup(animate) {
  if (animate) ranked = [];
  const cats = G.hand.categories;
  $("setupTitle").textContent = G.tut ? "Practice hand" : "Hand #" + G.n + ": rank your categories";
  $("setupSub").textContent = G.tut ? "Five easy categories to learn the ropes. Nothing here counts." : "Strongest first. Your fifth card is skipped. You'll play weakest first, for ×1, up to your strongest, for ×4.";
  const left = ranked.length === 4 ? cats.findIndex((_, i) => !ranked.includes(i)) : null;
  const hand = $("hand"); hand.innerHTML = ""; hand.classList.toggle("deal", !!animate);
  cats.forEach((c, i) => {
    const b = document.createElement("button"); b.className = "cat";
    const pos = ranked.indexOf(i), mult = pos > -1 ? 4 - pos : null;
    if (mult) b.classList.add("ranked");
    if (i === left) b.classList.add("skipped");
    const idx = i === left ? "Skip" : (mult ? "<span><small>×</small>" + mult + "</span>" : "");
    b.innerHTML = '<div class="index' + (mult ? " mx" + mult : "") + '" aria-hidden="true">' + idx + '</div><div><div class="fam">' + famLabel(c.family) + '</div><div class="rule">' + esc(c.label) + "</div></div>";
    b.setAttribute("aria-label", c.family + ": " + c.label + (i === left ? ", skipped" : "") + (mult ? ", times " + mult : ""));
    b.onclick = () => {
      if (pos > -1) ranked.splice(pos, 1);
      else if (ranked.length < 4) ranked.push(i);
      else ranked[3] = i;   // tapping the skipped card swaps it in for your weakest pick
      renderSetup();
    };
    hand.appendChild(b);
  });
  if (G.tut) coach([
    "Which category do you know best? Tap it first. It'll be worth <b>×4</b>.",
    "Nice. Now tap your next strongest, worth <b>×3</b>. (Tap a ranked card again to undo it.)",
    "And your next strongest? That one's worth <b>×2</b>.",
    "One more, worth <b>×1</b>. Whichever card you don't tap gets skipped, so leave your weakest.",
    "<b>" + (left !== null ? esc(first(cats[left].label)) : "") + "</b> is left over, so you'll skip it. Change your mind? Tap it to swap it in for your ×1 pick. Happy? Tap Deal.",
  ][ranked.length]);
  bar([{ label: "Back", ghost: true, onClick: renderHome },
       { label: ranked.length < 4 ? (4 - ranked.length) + " more to rank" : "Deal (skip " + first(cats[left].label) + ")", disabled: ranked.length < 4, onClick: deal }]);
  show("setup");
}
async function deal() {
  const cats = G.hand.categories;
  const ranking = ranked.concat(cats.findIndex((_, i) => !ranked.includes(i)));
  busy(true);
  try {
    await G.eng.startHand(G.n, ranking);
    G.play = await G.eng.getPlay(G.n);
    readyRound();
  } catch (e) {
    toast(e.message);
    if (e.code === "already-exists") openHand(G.n);
  } finally { busy(false); }
}

/* ---------- a round ---------- */
const roundsDone = p => [0, 1, 2, 3].filter(k => p.rounds && p.rounds[k]).length;
function readyRound() {
  const p = G.play, k = roundsDone(p);
  const slot = G.bonus ? p.skipped : p.order[k];
  const c = p.categories[slot];
  $("readyRound").textContent = G.bonus ? "Bonus round · doesn't count" : "Round " + (k + 1) + " of 4";
  if (G.bonus) { $("readyMult").textContent = "★"; $("readyMult").className = "bigmult mxb"; }
  else { $("readyMult").innerHTML = "<small>×</small>" + (k + 1); $("readyMult").className = "bigmult mx" + (k + 1); }
  $("readyRule").textContent = c.label;
  $("readyErr").hidden = true;
  const fetched = G.eng.startRound(G.n, G.bonus).then(pl => { G.payload = pl; G.respAt = Date.now(); return pl; });
  fetched.catch(() => {});
  if (G.tut) {
    $("readyCount").hidden = true;
    coach(G.bonus ? "This is the category you skipped. It doesn't count towards your score: it just shows whether you were right to skip it."
      : k === 0 ? "You play your <b>weakest</b> pick first, while the stakes are low. Each round is worth more than the last."
      : "Round " + (k + 1) + " is worth <b>×" + (k + 1) + "</b>, so every correct pair scores " + (k + 1) + " points.");
    bar([{ label: "Start round", onClick: () => fetched.then(beginRound, roundError) }]);
    return show("ready");
  }
  $("readyCount").hidden = false; bar([]); show("ready");
  let n = 3; $("readyCount").textContent = n;
  const t = setInterval(() => {
    n--;
    if (n > 0) { $("readyCount").textContent = n; return; }
    clearInterval(t);
    $("readyCount").textContent = "…";
    fetched.then(beginRound, roundError);
  }, 800);
}
function roundError(e) {
  $("readyCount").hidden = true;
  $("readyErr").textContent = e.message; $("readyErr").hidden = false;
  bar([{ label: "Home", ghost: true, onClick: renderHome }, { label: "Try again", onClick: readyRound }]);
}

let rs = null;   // round state
function beginRound(pl) {
  const left = G.tut ? Infinity : Math.min(ROUND_SECONDS * 1000, pl.deadline - pl.now - (Date.now() - G.respAt));
  rs = { pl, answers: Array(6).fill(null), sel: 0, end: Date.now() + left, done: false, started: Date.now() };
  $("rFam").innerHTML = famLabel(pl.family); $("rRule").textContent = pl.label;
  $("rMult").textContent = G.bonus ? "Bonus" : "×" + pl.mult; $("rMult").className = "chipmult " + (G.bonus ? "mxb" : "mx" + pl.mult);
  show("round"); renderRound();
  clearInterval(timerId);
  $("timer").hidden = G.tut;
  if (G.tut) { $("secs").textContent = "No time limit in practice"; return; }
  if (left <= 0) return lockIn();
  timerId = setInterval(tick, 200); tick();
}
function tick() {
  const left = Math.max(0, rs.end - Date.now()), s = Math.ceil(left / 1000);
  $("secs").textContent = s + "s";
  $("timerBar").style.transform = "scaleX(" + left / (ROUND_SECONDS * 1000) + ")";
  $("timer").classList.toggle("low", s <= 10);
  if (left <= 0) lockIn();
}
function renderRound() {
  const st = rs, pairs = $("pairs"); pairs.innerHTML = "";
  st.pl.prompts.forEach((p, i) => {
    const row = document.createElement("div"); row.className = "pair";
    const pr = document.createElement("div"); pr.className = "prompt"; pr.textContent = p;
    const sl = document.createElement("button"); sl.className = "slot" + (st.answers[i] ? " filled" : "") + (st.sel === i ? " sel" : "");
    sl.textContent = st.answers[i] || (st.sel === i ? "Pick an answer" : "…");
    sl.setAttribute("aria-label", p + ": " + (st.answers[i] || "no answer yet"));
    sl.dataset.slot = i;
    sl.onclick = () => { if (dragJustEnded) return; if (st.answers[i]) st.answers[i] = null; st.sel = i; renderRound(); };
    if (st.answers[i]) makeDraggable(sl, { slot: i });
    row.append(pr, sl); pairs.appendChild(row);
  });
  const pool = $("pool"); pool.innerHTML = "";
  st.pl.answers.forEach(a => {
    const ch = document.createElement("button"); ch.className = "chip"; ch.textContent = a; ch.hidden = st.answers.includes(a);
    makeDraggable(ch, { answer: a });
    ch.onclick = () => {
      if (dragJustEnded) return;
      if (st.sel === null) st.sel = st.answers.indexOf(null);
      if (st.sel === -1 || st.sel === null) return;
      st.answers[st.sel] = a;
      const next = st.answers.findIndex((x, k) => x === null && k > st.sel);
      st.sel = next > -1 ? next : st.answers.indexOf(null);
      if (st.sel === -1) st.sel = null;
      renderRound();
    };
    pool.appendChild(ch);
  });
  const filled = st.answers.filter(Boolean).length, k = st.pl.mult - 1;
  if (G.tut) coach(filled === 6 ? "All six matched. Tap <b>Lock in</b> to see how you did."
    : G.bonus ? "Bonus round: same rules, but it doesn't count. Just see how you'd have done."
    : k === 0 ? (filled === 0 ? "Match each item on the left to its answer. Tap an answer below to fill the highlighted gap, or drag it onto any gap."
                             : "That's it. Keep going. Tap a filled gap to take its answer back, or drag answers between gaps to swap them.")
    : k === 3 ? "Your strongest category, worth <b>×4</b>. Up to 24 points on this one."
    : "Same again, now worth <b>×" + (k + 1) + "</b>.");
  $("rHint").textContent = filled === 0 ? "Tap or drag to match" : filled + " of 6 matched";
  bar(filled < 6 ? [] : [{ label: "Lock in", onClick: lockIn }]);
  pool.classList.toggle("empty", filled === 6);
  const barH = $("bar").hidden ? 0 : Math.max(0, $("bar").offsetHeight - 18);
  pool.style.bottom = barH + "px";
  if (st.sel !== null && !$("round").hidden) {
    const sl = document.querySelector('[data-slot="' + st.sel + '"]');
    const r = sl.getBoundingClientRect(), top = document.querySelector(".roundhead").getBoundingClientRect().bottom;
    const floor = filled === 6 ? innerHeight - barH : pool.getBoundingClientRect().top;
    if (r.bottom > floor - 8) window.scrollBy(0, r.bottom - floor + 14);
    else if (r.top < top + 4) window.scrollBy(0, r.top - top - 14);
  }
}

/* ---------- drag and drop (mouse, pen and touch) ---------- */
let drag = null, dragJustEnded = false;
function makeDraggable(el, src) {
  el.addEventListener("pointerdown", e => {
    if (e.button > 0 || rs.done) return;
    drag = { el, src, x0: e.clientX, y0: e.clientY, ghost: null };
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
  });
  el.addEventListener("pointermove", e => {
    if (!drag || drag.el !== el) return;
    if (!drag.ghost) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
      const r = el.getBoundingClientRect(), g = el.cloneNode(true);
      g.classList.add("dragghost"); g.classList.remove("sel"); g.style.width = r.width + "px";
      g.dx = drag.x0 - r.left; g.dy = drag.y0 - r.top;
      document.body.appendChild(g); drag.ghost = g; el.style.opacity = ".35";
    }
    const g = drag.ghost; g.style.left = e.clientX - g.dx + "px"; g.style.top = e.clientY - g.dy + "px";
    document.querySelectorAll(".slot.over").forEach(x => x.classList.remove("over"));
    const t = dropTarget(e); if (t && t.dataset.slot !== undefined) t.classList.add("over");
  });
  const end = (e, cancelled) => {
    if (!drag || drag.el !== el) return;
    const d = drag; drag = null;
    if (!d.ghost) return;
    d.ghost.remove(); el.style.opacity = "";
    document.querySelectorAll(".slot.over").forEach(x => x.classList.remove("over"));
    dragJustEnded = true; setTimeout(() => (dragJustEnded = false), 0);
    if (!cancelled) dropOn(d.src, dropTarget(e));
  };
  el.addEventListener("pointerup", e => end(e, false));
  el.addEventListener("pointercancel", e => end(e, true));
}
function dropTarget(e) { const hit = document.elementFromPoint(e.clientX, e.clientY); return hit ? hit.closest("[data-slot], #pool") : null; }
function dropOn(src, target) {
  const st = rs; if (!st || st.done) return;
  if (target && target.dataset.slot !== undefined) {
    const i = +target.dataset.slot;
    if (src.answer !== undefined) st.answers[i] = src.answer;
    else if (src.slot !== i) { const tmp = st.answers[i]; st.answers[i] = st.answers[src.slot]; st.answers[src.slot] = tmp; }
  } else if (src.slot !== undefined) st.answers[src.slot] = null;
  const empty = st.answers.indexOf(null); st.sel = empty === -1 ? null : empty;
  renderRound();
}

/* ---------- lock in: the server marks it ---------- */
async function lockIn() {
  if (!rs || rs.done) return;
  rs.done = true; clearInterval(timerId);
  const picks = rs.answers.map(a => (a === null ? null : rs.pl.answers.indexOf(a)));
  bar([{ label: "Checking…", disabled: true }]);
  try {
    const out = await G.eng.submitRound(G.n, rs.pl.key, picks, Date.now() - rs.started);
    G.play = await G.eng.getPlay(G.n);
    showReveal(out.result, rs.pl.key);
  } catch (e) {
    rs.done = false;
    toast(e.message, 4000);
    bar([{ label: "Try again", onClick: lockIn }]);
  }
}
function revealList(result, list) {
  const rv = result.review; list.innerHTML = "";
  rv.prompts.forEach((p, i) => {
    const ok = result.marks[i], ch = rv.chosen[i];
    const d = document.createElement("div"); d.className = "res " + (ok ? "ok" : "no");
    d.innerHTML = '<div class="mark" aria-label="' + (ok ? "Correct" : "Wrong") + '">' + (ok ? "✓" : "✕") + '</div><div><div class="p"></div><div class="a"></div></div>';
    d.querySelector(".p").textContent = p;
    const a = d.querySelector(".a");
    if (ok) a.textContent = rv.answers[i];
    else { const s = document.createElement("s"); s.textContent = ch === null || ch === undefined ? "no answer" : rv.answers[ch]; a.append(s, " " + rv.answers[i]); }
    list.appendChild(d);
  });
}
function fillReveal(result) {
  $("revScore").textContent = result.correct + "/6";
  $("revCalc").textContent = result.mult ? "× " + result.mult + " = " + result.correct * result.mult + " points" : "Bonus round · doesn't count";
  $("revRule").innerHTML = famLabel(result.family) + " · " + esc(result.label) + (result.late ? " · <b>time ran out before your answers arrived</b>" : "");
  revealList(result, $("revList"));
  $("factText").textContent = result.review.fact || "";
  $("factSrc").hidden = !result.review.src; if (result.review.src) $("factSrc").href = result.review.src;
  $("fact").hidden = !result.review.fact;
}
function showReveal(result, key) {
  fillReveal(result);
  if (key === "bonus") {
    if (G.tut) coach("");
    bar([{ label: "Back to your results", onClick: () => { G.bonus = false; renderResults(); } }]);
    return show("reveal");
  }
  const k = +key, last = k === 3;
  if (G.tut) coach(k === 0
    ? "Green pairs were right. Red ones show what you picked, then the answer. In a daily hand you get <b>" + ROUND_SECONDS + " seconds</b> a round."
    : last ? "That's all four rounds. Let's see your score." : "");
  const nextCat = !last && G.play.categories[G.play.order[k + 1]];
  bar([{ label: last ? "See your results" : "Next: ×" + (k + 2) + " " + first(nextCat.label), onClick: () => (last ? renderResults() : readyRound()) }]);
  show("reveal");
}

/* ---------- results ---------- */
function shareText(p) {
  const lines = ["Strong Suit #" + p.hand + " · " + p.score + "/60"];
  [3, 2, 1, 0].forEach(k => { const r = p.rounds[k]; lines.push("×" + r.mult + " " + (FAMILY_EMOJI[r.family] || "") + " " + r.marks.map(m => (m ? "🟩" : "⬜")).join("")); });
  const sk = p.categories[p.skipped];
  lines.push(p.bonus ? "⏭️ " + (FAMILY_EMOJI[sk.family] || "") + " " + p.bonus.marks.map(m => (m ? "🟨" : "⬜")).join("")
                     : "⏭️ " + (FAMILY_EMOJI[sk.family] || "") + " skipped " + first(sk.label));
  lines.push("🎯 Self-awareness " + p.aware + "%");
  lines.push(SITE);
  return lines.join("\n");
}
function verdict(p) {
  const b = p.bonus.correct;
  const low = [0, 1, 2, 3].map(k => p.rounds[k]).reduce((m, x) => (x.correct < m.correct ? x : m));
  const name = first(low.label);
  if (b > low.correct) return "Should have played it! " + b + "/6 beats your " + low.correct + "/6 on " + name + ".";
  if (b === low.correct) return "A coin flip: level with your " + low.correct + "/6 on " + name + ".";
  return "Good skip. It would have been your weakest round.";
}
function dotsEl(marks, cls) {
  const d = document.createElement("div"); d.className = "dots" + (cls ? " " + cls : ""); d.setAttribute("aria-hidden", "true");
  marks.forEach(m => { const i = document.createElement("i"); if (m) i.className = "on"; d.appendChild(i); });
  return d;
}
function renderResults() {
  const p = G.play;
  $("resTitle").textContent = G.tut ? "Practice hand" : "Hand #" + p.hand;
  $("resNum").innerHTML = p.score + "<small>/60</small>";
  $("awPct").textContent = p.aware + "%";
  $("awText").textContent = "How well you ranked yourself. " + (p.aware === 100 ? "You put your categories in the best possible order for your results." : "You'd have scored " + p.best + " with the best order for these results; you scored " + p.score + ".");
  const rows = $("resRows"); rows.innerHTML = "";
  [3, 2, 1, 0].forEach(k => {
    const x = p.rounds[k];
    const d = document.createElement("button"); d.className = "row tap";
    d.innerHTML = '<div class="m mx' + x.mult + '">×' + x.mult + '</div><div class="t"></div><div class="s">' + x.correct * x.mult + '<span class="chev" aria-hidden="true">›</span></div>';
    const t = d.querySelector(".t"); t.textContent = x.label;
    const sm = document.createElement("small"); sm.textContent = (FAMILY_EMOJI[x.family] || "") + " " + x.family + " · " + x.correct + "/6"; t.appendChild(sm);
    t.appendChild(dotsEl(x.marks));
    d.setAttribute("aria-label", "Review " + x.label + ": " + x.correct + " of 6");
    d.onclick = () => openReview(x);
    rows.appendChild(d);
  });
  const skc = p.categories[p.skipped];
  const sk = document.createElement(p.bonus ? "button" : "div"); sk.className = "row" + (p.bonus ? " tap" : " skip");
  sk.innerHTML = '<div class="m' + (p.bonus ? " star" : "") + '">' + (p.bonus ? "★" : "–") + '</div><div class="t"></div><div class="s">' + (p.bonus ? '<span class="chev" aria-hidden="true">›</span>' : "Skipped") + "</div>";
  const skt = sk.querySelector(".t"); skt.textContent = skc.label;
  if (p.bonus) {
    const sm = document.createElement("small"); sm.textContent = (FAMILY_EMOJI[skc.family] || "") + " " + skc.family + " · " + p.bonus.correct + "/6 · skipped"; skt.appendChild(sm);
    skt.appendChild(dotsEl(p.bonus.marks, "bonus-dots"));
    const v = document.createElement("div"); v.className = "verdict"; v.textContent = verdict(p); skt.appendChild(v);
    sk.onclick = () => openReview(p.bonus);
  }
  rows.appendChild(sk);
  $("reviewHint").hidden = false;
  $("bonusCard").hidden = !!p.bonus;
  $("bonusText").textContent = "Try " + skc.label + ", the category you skipped, to see if you were right to skip it. It won't change your score.";
  $("percentile").hidden = true;
  $("shareText").hidden = $("nextNote").hidden = G.tut;
  if (G.tut) {
    coach(p.bonus ? "That's the whole game. Ready for the real thing?"
      : "Your <b>self-awareness</b> score shows how well you ranked yourself. Tap a round to look back at it. You can also play the category you skipped as a bonus.");
    bar([{ label: "Home", ghost: true, onClick: renderHome }, { label: "Done", onClick: renderHome }]);
    return show("results");
  }
  const text = shareText(p); $("shareText").value = text;
  $("nextNote").textContent = p.hand === S.n ? "The next hand opens in " + untilMidnight() + "." : "";
  bar([S.from === "hands" ? { label: "Back", ghost: true, onClick: renderHands } : { label: "Home", ghost: true, onClick: renderHome },
       { label: "Share result", onClick: () => share(text) }]);
  show("results");
  api.leaderboard(p.hand).then(lb => {
    const s = lb.summary; if (!s || !s.players || s.players < 2) return;
    const below = Object.entries(s.tally || {}).reduce((n, [sc, c]) => n + (+sc < p.score ? c : 0), 0);
    $("percentile").innerHTML = "You beat <b>" + Math.round((below / (s.players - 1)) * 100) + "%</b> of the " + s.players.toLocaleString("en-GB") + " players today. Average " + Math.round(s.totalScore / s.players) + ".";
    $("percentile").hidden = false;
  }).catch(() => {});
}
function openReview(result) {
  fillReveal(result);
  bar([{ label: "Back to your results", onClick: renderResults }]);
  show("reveal");
}
async function playBonus() { G.bonus = true; readyRound(); }
async function share(text) {
  if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
  try { await navigator.clipboard.writeText(text); toast("Copied. Paste it in your group chat."); }
  catch (e) { const t = $("shareText"); t.focus(); t.select(); toast("Text selected. Copy it to share."); }
}

/* ---------- everyone: the global top 20 for a hand, reached from Groups ---------- */
let boardSeq = 0;
async function renderBoard(n = S.n) {
  show("board");
  bar([]);
  const seq = ++boardSeq;
  const list = $("boardList"); list.innerHTML = '<p class="muted small">Loading…</p>';
  $("boardNote").textContent = "";
  $("bStep").hidden = !(S.n >= 1);
  if (!(S.n >= 1)) { list.innerHTML = '<p class="muted">The leaderboard starts with Hand #1.</p>'; return; }
  const today = n === S.n;
  $("bWhen").textContent = "Hand #" + n;
  $("bWhenSub").textContent = fmtDay(dateOf(S.config.launchDate, n)) + (today ? " · today" : "");
  $("bPrev").disabled = n <= 1; $("bNext").disabled = today;
  $("bPrev").onclick = () => renderBoard(n - 1); $("bNext").onclick = () => renderBoard(n + 1);
  try {
    const myUid = api.account().uid;
    let note = "";
    const lb = await api.leaderboard(n);
    if (seq !== boardSeq) return;
    let rows = lb.top;
    const s = lb.summary;
    const when = today ? " today" : "";
    if (lb.mine && s) {
      note = "You're " + ordinal(lb.mineRank) + " of " + s.players.toLocaleString("en-GB") + when + ".";
      if (!rows.find(r => r.uid === myUid)) rows = rows.concat({ ...lb.mine, uid: myUid, rank: lb.mineRank });
    } else if (s && s.players) note = s.players.toLocaleString("en-GB") + (s.players === 1 ? " player" : " players") + (today ? " so far today. Play to get on the board." : ".");
    else note = today ? "Nobody's played yet today." : "";
    list.innerHTML = "";
    rows.forEach((r, i) => {
      const d = document.createElement("div"); d.className = "lb" + (r.uid === myUid ? " me" : "");
      d.innerHTML = '<span class="rk">' + (r.rank || i + 1) + '</span><span class="nm"><b></b><small></small></span><span class="sc">' + r.score + "</span>";
      d.querySelector(".nm b").textContent = r.name + (r.uid === myUid ? " (you)" : "");
      d.querySelector(".nm small").textContent = fmtTime(r.time);
      list.appendChild(d);
    });
    if (!rows.length) list.innerHTML = '<p class="muted">No scores yet.</p>';
    $("boardNote").textContent = note + (rows.length ? " Equal scores are split by total time across the four rounds." : "");
  } catch (e) { list.innerHTML = '<p class="muted">' + esc(e.message) + "</p>"; }
}
const ordinal = n => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
/** Total time across the four rounds, e.g. "2:41.3". Tenths, because that's what separates equal scores. */
const fmtTime = ms => {
  if (!Number.isFinite(ms)) return "";
  const t = Math.round(ms / 100), m = Math.floor(t / 600), s = (t % 600) / 10;
  return m + ":" + (s < 10 ? "0" : "") + s.toFixed(1);
};

/* ---------- your hands: every hand so far, newest first ---------- */
async function renderHands() {
  show("hands"); bar([]);
  const list = $("handsList"); list.innerHTML = '<p class="muted small">Loading…</p>';
  $("handsNote").textContent = "";
  $("handsSub").hidden = !(S.n >= 1);
  if (!(S.n >= 1)) { list.innerHTML = '<p class="muted">Your hands will appear here once Hand #1 opens.</p>'; return; }
  let plays;
  try { plays = await api.myPlays(); } catch (e) { list.innerHTML = '<p class="muted">' + esc(e.message) + "</p>"; return; }
  list.innerHTML = "";
  let missed = 0;
  for (let n = S.n; n >= 1; n--) {
    const p = plays[n], today = n === S.n, done = p && p.status === "done";
    const open = done || today;
    const d = document.createElement(open ? "button" : "div");
    d.className = "row hs" + (open ? " tap" : " skip");
    d.innerHTML = '<div class="m"></div><div class="t"><small></small></div><div class="s"></div>';
    d.querySelector(".t").prepend("Hand #" + n + " · " + fmtDay(dateOf(S.config.launchDate, n)));
    const m = d.querySelector(".m"), sm = d.querySelector("small"), s = d.querySelector(".s");
    if (done) {
      const sk = p.categories[p.skipped];
      m.textContent = p.score;
      sm.textContent = p.aware + "% self-awareness · skipped " + (FAMILY_EMOJI[sk.family] || "") + " " + sk.family;
      s.innerHTML = '<span class="chev" aria-hidden="true">›</span>';
      d.setAttribute("aria-label", "Hand " + n + ": " + p.score + " out of 60");
      d.onclick = () => openHand(n, "hands");
    } else if (today) {
      m.textContent = "–";
      sm.textContent = p ? "Part-way through" : "Today's hand";
      s.innerHTML = '<span class="pill">' + (p ? "Carry on" : "Play") + "</span>";
      d.onclick = () => openHand(n);
    } else {
      m.textContent = "–";
      sm.textContent = p ? "Not finished" : "Missed";
      missed++;
    }
    list.appendChild(d);
  }
  if (missed) $("handsNote").textContent = "Playing hands you missed is coming with ♠\uFE0E Plus.";
}

/* ---------- groups ---------- */
async function renderGroups() {
  show("groups");
  bar([]);
  const list = $("groupList"); list.innerHTML = '<p class="muted small">Loading…</p>';
  symbolPicker($("newSym"), newSymbol, id => (newSymbol = id));
  $("startGroup").open = false;   // folded until they want it
  const groups = await api.groups().catch(e => (toast(e.message), []));
  list.innerHTML = groups.length ? "" : '<p class="muted">You\'re not in any groups yet. Start one and share the code, or join a friend\'s.</p>';
  groups.forEach(g => {
    const d = document.createElement("button"); d.className = "row tap gopen";
    d.innerHTML = '<div class="m">' + symHtml(g.symbol) + '</div><div class="t"><small></small></div><div class="s"><span class="chev" aria-hidden="true">›</span></div>';
    d.querySelector(".t").prepend(g.name);
    d.querySelector("small").textContent = g.memberCount + " of " + g.cap + " members";
    d.onclick = () => renderGroup(g.id);
    list.appendChild(d);
  });
}

/* ---------- group symbols (IDs match GROUP_SYMBOLS on the server) ---------- */
const VS16 = "\uFE0F";   // ask for the emoji version of the suits, to match the other symbols
const SYMBOLS = {
  spade: "♠" + VS16, heart: "♥" + VS16, diamond: "♦" + VS16, club: "♣" + VS16,
  joker: "🃏", crown: "👑", star: "⭐", dice: "🎲", trophy: "🏆", target: "🎯",
  beer: "🍺", wine: "🍷", coffee: "☕", brain: "🧠", owl: "🦉", fire: "🔥", bolt: "⚡", octopus: "🐙", fox: "🦊", bee: "🐝",
};
const SYMBOL_NAMES = { spade: "Spades", heart: "Hearts", diamond: "Diamonds", club: "Clubs", joker: "Joker", crown: "Crown", star: "Star", dice: "Dice", trophy: "Trophy", target: "Target",
  beer: "Beer", wine: "Wine", coffee: "Coffee", brain: "Brain", owl: "Owl", fire: "Fire", bolt: "Lightning", octopus: "Octopus", fox: "Fox", bee: "Bee" };
const symHtml = id => '<span class="sym" aria-hidden="true">' + SYMBOLS[SYMBOLS[id] ? id : "club"] + "</span>";
/** Fills a .symgrid with one button per symbol; onPick(id) is called when one is chosen. */
function symbolPicker(el, selected, onPick) {
  el.innerHTML = "";
  Object.keys(SYMBOLS).forEach(id => {
    const b = document.createElement("button");
    b.type = "button"; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", id === selected); b.setAttribute("aria-label", SYMBOL_NAMES[id]);
    b.innerHTML = symHtml(id);
    b.onclick = () => { el.querySelectorAll("button").forEach(x => x.setAttribute("aria-checked", x === b)); onPick(id); };
    el.appendChild(b);
  });
}
let newSymbol = "spade";

/* ---------- one group: table (day, month, all time), everyone's picks, and subject stats ---------- */
async function renderGroup(gid) {
  show("group"); bar([]);
  $("gBody").innerHTML = '<p class="muted small">Loading…</p>';
  ["gTabs", "gPeriods", "gStep"].forEach(id => ($(id).hidden = true));
  const g = await api.group(gid).catch(() => null);
  if (!g) { toast("Couldn't open that group."); return renderGroups(); }
  $("gName").innerHTML = symHtml(g.symbol) + esc(g.name);
  drawManage(g);
  $("gMeta").textContent = g.memberCount + " of " + g.cap + " members · code " + g.code;
  $("gInvite").onclick = () => copyInvite(g);
  $("gLeave").onclick = async () => {
    if (!(await ask({ title: "Leave " + g.name + "?", text: g.memberCount <= 1 ? "You're the last member, so the group will be deleted." : "You can rejoin later with the code.", ok: "Leave", danger: true }))) return;
    busy(true); try { await api.leaveGroup(g.id); toast("Left " + g.name); await refreshMe(); } catch (e) { toast(e.message); } finally { busy(false); renderGroups(); }
  };
  const launch = S.config.launchDate;
  const open = launch && S.n >= 1;
  const thisMonth = ymd(new Date()).slice(0, 7);
  GV = { gid, tab: "table", period: "day", hand: S.n, month: thisMonth, firstMonth: open ? launch.slice(0, 7) : thisMonth, day: {}, mon: {}, seq: 0 };
  document.querySelectorAll("#gTabs button").forEach(b => (b.onclick = () => { GV.tab = b.dataset.tab; drawGroup(); }));
  document.querySelectorAll("#gPeriods button").forEach(b => (b.onclick = () => { GV.period = b.dataset.period; drawGroup(); }));
  $("gPrev").onclick = () => stepGroup(-1); $("gNext").onclick = () => stepGroup(1);
  if (!open) {
    ["gTabs", "gPeriods", "gStep"].forEach(id => ($(id).hidden = true));
    $("gBody").innerHTML = '<p class="muted">Scores, picks and subject stats appear here once Hand #1 opens' + (launch ? " on " + fmtDay(dateOf(launch, 1)) : "") + ".</p>";
    return;
  }
  $("gTabs").hidden = false;
  drawGroup();
}

/** Copies the invite message; if the browser won't allow it, shows the text to copy by hand. */
async function copyInvite(g) {
  const text = "Join my Strong Suit group \"" + g.name + "\": " + SITE + "/?join=" + g.code + "\n(or enter code " + g.code + ")";
  try { await navigator.clipboard.writeText(text); toast("Invite copied. Paste it into your group chat.", 3000); }
  catch (_) { await ask({ title: "Copy this invite", text: "Your browser didn't let us copy it automatically.", ok: "Done", cancel: "Close", input: { value: text, max: 300 } }); }
}

/* The creator's controls: rename, symbol, a new invite code, and removing members. */
async function drawManage(g) {
  const mine = g.ownerUid === api.account().uid;
  $("gManage").hidden = !mine;
  $("gManage").open = false;   // starts folded; the creator taps to open it
  if (!mine) return;
  $("gRename").value = g.name;
  $("gCode").textContent = g.code;
  const save = async (changes, done) => {
    busy(true);
    try { await api.updateGroup(g.id, changes); Object.assign(g, changes); $("gName").innerHTML = symHtml(g.symbol) + esc(g.name); toast(done); }
    catch (e) { toast(e.message); } finally { busy(false); }
  };
  $("gRenameBtn").onclick = () => {
    const name = $("gRename").value.trim();
    if (name === g.name) return;
    save({ name }, "Renamed");
  };
  symbolPicker($("gSym"), g.symbol || "club", id => save({ symbol: id }, "Symbol changed"));
  $("gNewCode").onclick = async () => {
    if (!(await ask({ title: "Make a new invite code?", text: "The old code " + g.code + " will stop working straight away, including for anyone you've sent it to who hasn't joined yet.", ok: "New code" }))) return;
    busy(true);
    try { const r = await api.newGroupCode(g.id); g.code = r.code; $("gCode").textContent = r.code; $("gMeta").textContent = g.memberCount + " of " + g.cap + " members · code " + g.code; toast("New code: " + r.code, 3000); }
    catch (e) { toast(e.message); } finally { busy(false); }
  };
  const list = $("gMembers");
  list.innerHTML = '<p class="muted small">Loading…</p>';
  const members = await api.groupMembers(g.id).catch(() => []);
  const me = api.account().uid;
  list.innerHTML = "";
  members.sort((a, b) => (a.uid === me ? -1 : b.uid === me ? 1 : a.name.localeCompare(b.name))).forEach(m => {
    const row = document.createElement("div"); row.className = "mem";
    const n = document.createElement("span"); n.textContent = m.name + (m.uid === me ? " (you)" : "");
    row.appendChild(n);
    if (m.uid !== me) {
      const b = document.createElement("button"); b.className = "linkbtn"; b.textContent = "Remove";
      b.onclick = async () => {
        if (!(await ask({ title: "Remove " + m.name + "?", text: "They'll leave the group straight away. They could rejoin with the invite code, so make a new code if you need to keep them out.", ok: "Remove", danger: true }))) return;
        busy(true);
        try { await api.removeMember(g.id, m.uid); toast(m.name + " removed"); renderGroup(g.id); }
        catch (e) { toast(e.message); } finally { busy(false); }
      };
      row.appendChild(b);
    }
    list.appendChild(row);
  });
}

/* Group page state: which tab, which period, and data already fetched this visit. */
let GV = null;
const monthAdd = (m, k) => { const [y, mo] = m.split("-").map(Number); const d = new Date(y, mo - 1 + k, 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); };
const monthName = m => { const [y, mo] = m.split("-").map(Number); return new Date(y, mo - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" }); };
const avg1 = (c, r) => (r ? (c / r).toFixed(1) : "–");
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
function stepGroup(k) {
  const per = groupPeriod();
  if (per === "day") GV.hand = Math.min(S.n, Math.max(1, GV.hand + k));
  else if (per === "month") { const m = monthAdd(GV.month, k); if (m >= GV.firstMonth && m <= ymd(new Date()).slice(0, 7)) GV.month = m; }
  drawGroup();
}
function groupPeriod() {
  if (GV.tab === "picks") return "day";
  if (GV.tab === "subjects" && GV.period === "day") return "month";
  return GV.period;
}
function groupDay(n) { return (GV.day[n] ||= api.groupDay(GV.gid, n).catch(e => { delete GV.day[n]; throw e; })); }
function groupMonth(m) { return (GV.mon[m] ||= api.groupMonth(GV.gid, m).catch(e => { delete GV.mon[m]; throw e; })); }

async function drawGroup() {
  const per = groupPeriod(), seq = ++GV.seq;
  document.querySelectorAll("#gTabs button").forEach(b => { b.classList.toggle("on", b.dataset.tab === GV.tab); b.setAttribute("aria-selected", b.dataset.tab === GV.tab); });
  $("gPeriods").hidden = GV.tab === "picks";
  document.querySelectorAll("#gPeriods button").forEach(b => { b.hidden = GV.tab === "subjects" && b.dataset.period === "day"; b.classList.toggle("on", b.dataset.period === per); });
  $("gStep").hidden = per === "all";
  if (per === "day") {
    $("gWhen").textContent = "Hand #" + GV.hand;
    $("gWhenSub").textContent = fmtDay(dateOf(S.config.launchDate, GV.hand)) + (GV.hand === S.n ? " · today" : "");
    $("gPrev").disabled = GV.hand <= 1; $("gNext").disabled = GV.hand >= S.n;
  } else if (per === "month") {
    $("gWhen").textContent = monthName(GV.month);
    $("gWhenSub").textContent = GV.month === ymd(new Date()).slice(0, 7) ? "this month" : "";
    $("gPrev").disabled = GV.month <= GV.firstMonth; $("gNext").disabled = GV.month >= ymd(new Date()).slice(0, 7);
  }
  const body = $("gBody");
  body.innerHTML = '<p class="muted small">Loading…</p>';
  try {
    const data = per === "day" ? await groupDay(GV.hand) : await groupMonth(per === "all" ? "all" : GV.month);
    if (seq !== GV.seq) return;   // they've moved on
    body.innerHTML = GV.tab === "picks" ? picksHtml(data) : GV.tab === "subjects" ? subjectsHtml(data, per) : per === "day" ? dayHtml(data) : monthHtml(data, per);
    body.querySelectorAll("[data-open]").forEach(b => (b.onclick = () => openHand(+b.dataset.open)));
  } catch (e) { if (seq === GV.seq) body.innerHTML = '<p class="muted">' + esc(e.message) + "</p>"; }
}

const tiles = cells => '<div class="stats">' + cells.map(([l, v]) => "<div><b>" + esc(v) + "</b><span>" + esc(l) + "</span></div>").join("") + "</div>";
function lbRows(rows) {   // rows: { uid, name, value (null = didn't play), sub, none }
  const me = api.account().uid;
  let rank = 0, prev = null;
  return rows.map((r, i) => {
    const key = r.value + "|" + (r.time ?? "");   // equal score and equal time share a place
    if (key !== prev) { rank = i + 1; prev = key; }
    return '<div class="lb' + (r.uid === me ? " me" : "") + '"><span class="rk">' + (r.value === null ? "–" : rank) + '</span><span class="nm">' + esc(r.name) + (r.uid === me ? " (you)" : "") +
      (r.sub ? "<small>" + esc(r.sub) + "</small>" : "") + '</span><span class="sc">' + (r.value === null ? "<small>" + esc(r.none) + "</small>" : r.value) + "</span></div>";
  }).join("");
}
// highest first; equal scores go to the quicker player
const byValue = (a, b) => (b.value ?? -1) - (a.value ?? -1) || (a.time ?? Infinity) - (b.time ?? Infinity) || a.name.localeCompare(b.name);

function dayHtml(d) {
  const rows = d.members.map(m => {
    const done = m.status === "done";
    let sub = "";
    if (done) {
      const sk = m.skipped !== undefined ? d.categories[m.skipped] : null;
      sub = [fmtTime(m.time), sk ? "skipped " + (FAMILY_EMOJI[sk.family] || "") + " " + sk.family : "", m.aware + "% self-aware"].filter(Boolean).join(" · ");
    }
    return { uid: m.uid, name: m.name, value: done ? m.score : null, time: done ? m.time : null, sub, none: m.status === "playing" ? "playing" : "not played" };
  }).sort(byValue);
  const done = rows.filter(r => r.value !== null);
  const top = done[0];
  let html = tiles([
    ["Played", done.length + "/" + rows.length],
    ["Average", done.length ? Math.round(done.reduce((t, r) => t + r.value, 0) / done.length) : "–"],
    ["Top score" + (top ? " · " + top.name : ""), top ? top.value : "–"],
  ]) + '<div class="list">' + lbRows(rows) + "</div>";
  if (!d.canSee) html += '<p class="small muted">' + (d.hand === S.n ? "Finish today's hand to see what everyone skipped and what they picked." : "You didn't finish this hand, so what everyone skipped and picked stays hidden.") + "</p>";
  return html;
}

function monthHtml(m, per) {
  const rows = m.members.map(x => ({
    uid: x.uid, name: x.name, value: x.played ? x.total : null, time: x.played ? x.time : null, none: "no hands",
    sub: x.played ? x.played + (x.played === 1 ? " hand" : " hands") + " · average " + Math.round(x.total / x.played) + " · best " + x.best : "",
  })).sort(byValue);
  const played = m.members.reduce((t, x) => t + x.played, 0), total = m.members.reduce((t, x) => t + x.total, 0);
  const best = m.members.reduce((b, x) => (x.played && (!b || x.best > b.best) ? x : b), null);
  return tiles([
    ["Hands played", played],
    ["Average hand", played ? Math.round(total / played) : "–"],
    ["Best hand" + (best ? " · " + best.name : ""), best ? best.best : "–"],
  ]) + '<p class="small muted">Ranked by total points' + (per === "all" ? " since you each started" : " this month") + ".</p>" +
    '<div class="list">' + lbRows(rows) + "</div>";
}

function picksHtml(d) {
  if (!d.canSee) {
    return '<div class="card"><b>No peeking</b><p class="small muted">' +
      (d.hand === S.n ? "Play today's hand first. Then you'll see how everyone ranked their categories and what they picked for every question."
                      : "Picks only show for hands you've finished.") + "</p>" +
      (d.hand === S.n ? '<button class="btn" data-open="' + d.hand + '">Play hand #' + d.hand + "</button>" : "") + "</div>";
  }
  const me = api.account().uid;
  const done = d.members.filter(m => m.status === "done").sort((a, b) => b.score - a.score);
  const others = d.members.filter(m => m.status !== "done");
  const nm = m => esc(m.name) + (m.uid === me ? " (you)" : "");
  let html = '<div class="card"><div><b>How everyone ranked it</b><p class="small muted">Strongest first. The crossed-out one was skipped.</p></div><div class="list">' +
    done.map(m => '<div class="rk-row"><span class="nm">' + nm(m) + '</span><span class="em">' +
      m.ranking.map((s, i) => '<span' + (i === 4 ? ' class="sk"' : "") + ' title="' + esc(d.categories[s].label) + '">' + (FAMILY_EMOJI[d.categories[s].family] || "•") + "</span>").join("") + "</span></div>").join("") +
    "</div>" + (others.length ? '<p class="small muted">Not finished yet: ' + others.map(nm).join(", ") + "</p>" : "") + "</div>";
  d.rounds.forEach(r => {
    const c = d.categories[r.slot];
    html += '<div class="card"><div class="rhead"><b>' + famLabel(c.family) + " · " + esc(c.label) + "</b>";
    if (r.locked) {
      html += '</div><p class="small muted">You skipped this one. Play your bonus round to see everyone\'s picks.</p><button class="btn ghost" data-open="' + d.hand + '">Go to your bonus round</button></div>';
      return;
    }
    const played = done.filter(m => r.picks[m.uid] && r.picks[m.uid].mult !== null);
    const skipped = done.filter(m => !r.picks[m.uid] || r.picks[m.uid].mult === null);
    html += "<small>" + (played.length ? "Average " + avg1(played.reduce((t, m) => t + r.picks[m.uid].correct, 0), played.length) + "/6" : "") + "</small></div>";
    html += '<p class="small muted">' + played.map(m => nm(m) + " " + (r.picks[m.uid].mult ? "×" + r.picks[m.uid].mult : "★ bonus")).join(" · ") +
      (skipped.length ? (played.length ? " · " : "") + "skipped by " + skipped.map(nm).join(", ") : "") + "</p>";
    r.prompts.forEach((p, i) => {
      html += '<div class="pick"><div class="q">' + esc(p) + " → <span>" + esc(r.answers[i]) + '</span></div><div class="who">' +
        played.map(m => {
          const ch = r.picks[m.uid].chosen[i];
          if (ch === i) return "<i>" + nm(m) + "</i>";
          return '<i class="no">' + nm(m) + ": <small>" + (ch === null || ch === undefined ? "no answer" : esc(r.answers[ch])) + "</small></i>";
        }).join("") + "</div></div>";
    });
    if (r.fact) html += '<p class="rfact">' + esc(r.fact) + "</p>";
    html += "</div>";
  });
  return html;
}

function subjectsHtml(m, per) {
  const me = api.account().uid;
  const when = per === "all" ? "yet" : "in " + monthName(GV.month).split(" ")[0];
  if (!m.members.some(x => x.played)) return '<p class="muted">No hands played ' + when + ".</p>";
  const fams = {};
  m.members.forEach(x => Object.entries(x.families).forEach(([f, v]) => {
    const t = (fams[f] ||= { f, dealt: 0, skipped: 0, rounds: 0, correct: 0, people: [] });
    t.dealt += v.dealt; t.skipped += v.skipped; t.rounds += v.rounds; t.correct += v.correct;
    if (v.dealt || v.rounds) t.people.push({ uid: x.uid, name: x.name, ...v });
  }));
  const list = Object.values(fams);
  const subj = list.slice().sort((a, b) => (b.rounds ? b.correct / b.rounds : -1) - (a.rounds ? a.correct / a.rounds : -1) || b.dealt - a.dealt);
  let html = '<div><b>Subject leaderboards</b><p class="small muted">Average pairs right per round, out of 6. Tap a subject to see everyone.</p></div><div class="list">';
  subj.forEach(t => {
    const people = t.people.slice().sort((a, b) => (b.rounds ? b.correct / b.rounds : -1) - (a.rounds ? a.correct / a.rounds : -1) || a.name.localeCompare(b.name));
    const lead = people[0] && people[0].rounds ? people[0] : null;
    html += '<details class="subj"><summary><span>' + famLabel(t.f) + "<small>" + (lead ? "Top: " + esc(lead.name) + " " + avg1(lead.correct, lead.rounds) + " · " : "") +
      t.rounds + (t.rounds === 1 ? " round" : " rounds") + "</small></span><b>" + avg1(t.correct, t.rounds) + "<small>group</small></b></summary><div class=\"list\">";
    let rank = 0, prev = null;
    people.forEach((p, i) => {
      const v = p.rounds ? avg1(p.correct, p.rounds) : null;
      if (v !== prev) { rank = i + 1; prev = v; }
      html += '<div class="mrow' + (p.uid === me ? " me" : "") + '"><span class="r">' + (v === null ? "–" : rank) + '</span><span class="n">' + esc(p.name) + (p.uid === me ? " (you)" : "") +
        "<small>" + p.rounds + (p.rounds === 1 ? " round" : " rounds") + " · skipped " + p.skipped + " of " + p.dealt + '</small></span><span class="v">' + (v ?? "–") + "</span></div>";
    });
    html += "</div></details>";
  });
  html += "</div>";
  const skips = list.filter(t => t.dealt).map(t => {
    const top = t.people.filter(p => p.dealt).sort((a, b) => b.skipped / b.dealt - a.skipped / a.dealt || b.dealt - a.dealt)[0];
    return { ...t, rate: pct(t.skipped, t.dealt), top: top && top.skipped ? top : null };
  }).sort((a, b) => b.rate - a.rate || b.dealt - a.dealt);
  html += '<div class="card"><div><b>What the group skips</b><p class="small muted">How often each subject was skipped when it was dealt.</p></div><div class="list">' +
    skips.map(x => '<div class="fam-row"><div class="fn">' + famLabel(x.f) + "<small>" + x.skipped + " of " + x.dealt +
      (x.top ? " · most by " + esc(x.top.name) + " (" + pct(x.top.skipped, x.top.dealt) + "%)" : "") + '</small></div><div class="barline skip"><i style="width:' + x.rate + '%"></i></div><b>' + x.rate + "%</b></div>").join("") +
    "</div></div>";
  return html;
}
async function createGroup() {
  const name = $("newGroup").value.trim();
  if (name.length < 2) return toast("Give your group a name.");
  busy(true);
  try { const g = await api.createGroup(name, newSymbol); $("newGroup").value = ""; newSymbol = "spade"; toast("Group made. Invite your friends with the code " + g.code, 4000); await refreshMe(); renderGroup(g.groupId); }
  catch (e) { toast(e.message); } finally { busy(false); }
}
async function joinGroup(code) {
  code = (code || $("joinCode").value).trim();
  if (!code) return toast("Enter a group code.");
  busy(true);
  try { const g = await api.joinGroup(code); $("joinCode").value = ""; toast("You're in " + g.name); await refreshMe(); renderGroup(g.groupId); }
  catch (e) { toast(e.message); } finally { busy(false); }
}

/* ---------- profile ---------- */
async function renderProfile() {
  show("profile");
  bar([]);
  await refreshMe();
  const me = S.me || {}, st = me.stats || {}, acc = api.account();
  $("pName").textContent = me.name || "";
  if (acc.anonymous) {
    $("pAccount").innerHTML = 'Playing as a guest on this device. <button class="inlinelink" id="createAcc">Create an account</button>';
    $("createAcc").onclick = () => { $("signinBox").scrollIntoView({ behavior: "smooth", block: "center" }); $("signinBox").classList.add("flash"); setTimeout(() => $("signinBox").classList.remove("flash"), 1200); };
  } else $("pAccount").textContent = "Signed in" + (acc.email ? " as " + acc.email : "");
  $("signinBox").hidden = !acc.anonymous;
  $("signedInBox").hidden = acc.anonymous;
  const played = st.played || 0;
  const cells = [
    ["Played", played], ["Average", played ? Math.round(st.totalScore / played) : "–"], ["Best", played ? st.bestScore : "–"],
    ["Streak", st.streak && st.lastHand >= S.n - 1 ? st.streak : 0], ["Best streak", st.bestStreak || 0], ["Self-awareness", played ? Math.round(st.awareTotal / played) + "%" : "–"],
  ];
  $("pStats").innerHTML = cells.map(([l, v]) => "<div><b>" + esc(v) + "</b><span>" + l + "</span></div>").join("");
  const fams = Object.entries(st.families || {}).map(([f, x]) => ({
    f, rounds: x.rounds || 0, pct: x.rounds ? Math.round((x.correct / (x.rounds * 6)) * 100) : null, dealt: x.dealt || 0, skipped: x.skipped || 0,
  })).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.dealt - a.dealt);
  const playedFams = fams.filter(x => x.rounds);
  const dealt = fams.filter(x => x.dealt).map(x => ({ ...x, rate: Math.round((x.skipped / x.dealt) * 100) }))
    .sort((a, b) => b.rate - a.rate || b.dealt - a.dealt);
  // your bar, with everyone's average as a thin grey bar beneath it
  const meter = (cls, mine, all) => '<div class="bars"><div class="barline' + cls + '"><i style="width:' + mine + '%"></i></div>' +
    (all === null ? "" : '<div class="barline all" title="Everyone: ' + all + '%"><i style="width:' + all + '%"></i></div>') + "</div>";
  const val = (mine, all) => "<b>" + mine + "%" + (all === null ? "" : "<small>" + all + "%</small>") + "</b>";
  const drawFams = g => {
    const right = f => (g[f] && g[f].rounds ? Math.round((g[f].correct / (g[f].rounds * 6)) * 100) : null);
    const skip = f => (g[f] && g[f].dealt ? Math.round(((g[f].skipped || 0) / g[f].dealt) * 100) : null);
    $("pFams").innerHTML = playedFams.length
      ? playedFams.map(x => '<div class="fam-row"><div class="fn">' + famLabel(x.f) + "<small>" + x.rounds + (x.rounds === 1 ? " round" : " rounds") + " played</small></div>" +
          meter("", x.pct, right(x.f)) + val(x.pct, right(x.f)) + "</div>").join("")
      : '<p class="muted small">Play a few hands to see which subjects you know best.</p>';
    $("pSkips").innerHTML = dealt.length
      ? dealt.map(x => '<div class="fam-row"><div class="fn">' + famLabel(x.f) + "<small>Skipped " + x.skipped + " of " + x.dealt + (x.dealt === 1 ? " hand" : " hands") + "</small></div>" +
          meter(" skip", x.rate, skip(x.f)) + val(x.rate, skip(x.f)) + "</div>").join("")
      : '<p class="muted small">Once you\'ve played a hand, you\'ll see which subjects you tend to skip.</p>';
  };
  drawFams({});
  if (playedFams.length || dealt.length) api.globalFamilies().then(g => { if (!$("profile").hidden) drawFams(g); });
}
async function editName() {
  const name = await ask({ title: "Your name", text: "Shown on leaderboards and in your groups. 2–20 letters or numbers.", ok: "Save", input: { value: S.me && S.me.name, max: 20 } });
  if (!name) return;
  busy(true); try { await api.setName(name); toast("Saved"); } catch (e) { toast(e.message); } finally { busy(false); renderProfile(); }
}
async function signInGoogle() {
  try {
    const r = await api.signInGoogle();
    if (r.cancelled) return;
    toast(r.switched ? "Signed in to your existing account." : "Signed in. Your progress is saved.");
    await refreshMe(); renderProfile();
  } catch (e) { toast(e.message, 4000); }
}
async function signInEmail() {
  const email = $("emailIn").value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return toast("Enter your email address.");
  busy(true);
  try { await api.sendEmailLink(email); toast("Check your email for a sign-in link.", 4000); $("emailIn").value = ""; }
  catch (e) { toast(e.message, 4000); } finally { busy(false); }
}
async function signOut() {
  if (!(await ask({ title: "Sign out?", text: "You can sign back in any time to pick up where you left off.", ok: "Sign out" }))) return;
  await api.signOut(); await refreshMe(); renderHome();
}
async function deleteAccount() {
  if (!(await ask({ title: "Delete your account?", text: "This permanently removes your name, scores, stats and group memberships.", ok: "Delete everything", danger: true }))) return;
  busy(true); try { await api.deleteAccount(); toast("Your account has been deleted."); await refreshMe(); renderHome(); } catch (e) { toast(e.message); } finally { busy(false); }
}


/* ---------- how to play ---------- */
function openHow() { $("howto").hidden = false; $("howClose").focus(); }
function closeHow() { $("howto").hidden = true; try { localStorage.setItem("ss_seen_howto", "1"); } catch (_) {} }

/* ---------- start ---------- */
function wire() {
  $("helpBtn").onclick = openHow; $("howClose").onclick = closeHow; $("howPractice").onclick = startTutorial;
  $("howto").addEventListener("click", e => { if (e.target.id === "howto") closeHow(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") { if (!$("howto").hidden) closeHow(); if (!$("ask").hidden) $("askCancel").click(); } });
  $("bonusBtn").onclick = playBonus;
  document.querySelectorAll("[data-home]").forEach(b => (b.onclick = renderHome));
  document.querySelectorAll("[data-groups]").forEach(b => (b.onclick = renderGroups));
  $("homeLink").onclick = e => { e.preventDefault(); if (!document.body.classList.contains("inround")) renderHome(); };
  document.querySelectorAll(".nav button[data-go]").forEach(b => (b.onclick = () => ({ hands: renderHands, groups: renderGroups, profile: renderProfile })[b.dataset.go]()));
  $("everyoneRow").onclick = () => renderBoard();
  $("createBtn").onclick = createGroup; $("joinBtn").onclick = () => joinGroup();
  $("nameBtn").onclick = editName; $("googleBtn").onclick = signInGoogle; $("emailBtn").onclick = signInEmail;
  $("signOutBtn").onclick = signOut; $("deleteBtn").onclick = deleteAccount; $("practiceBtn").onclick = startTutorial;
}
async function boot() {
  wire();
  show("loading");
  try { api = await createBackend(); }
  catch (e) { $("loadingText").textContent = "Couldn't load Strong Suit. Check your connection and refresh."; return; }
  $("demoBanner").hidden = !api.demo;
  S.config = (await api.config().catch(() => null)) || {};
  await refreshMe();
  if (api.linkNote && api.linkNote.signedIn) toast("Signed in as " + api.linkNote.signedIn);
  if (api.linkNote && api.linkNote.error) toast(api.linkNote.error, 5000);
  await renderHome();
  const join = new URLSearchParams(location.search).get("join");
  if (join) {
    history.replaceState(null, "", location.pathname + (api.demo ? "?demo=1" : ""));
    if (await ask({ title: "Join this group?", text: "Code " + join.toUpperCase() + ". Members will see your name, scores and subject stats, and, once they've played a hand, your answers.", ok: "Join" })) await joinGroup(join);
    return;
  }
  let seen = false; try { seen = localStorage.getItem("ss_seen_howto") === "1"; } catch (_) {}
  if (!seen) openHow();   // first visit: how to play; otherwise stay on the home screen with its Play button
}
boot();
