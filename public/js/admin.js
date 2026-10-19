// Strong Suit admin page. The data comes from the adminStats function, which refuses anyone not on the admin list.
// ?demo=1 shows made-up numbers, for checking the layout without signing in.
import { DAYS, toHand, FAMILY_EMOJI, WILDCARD } from "./content.js";

const SDK = "https://www.gstatic.com/firebasejs/12.19.0/";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const fmtPct = v => (v === null ? "–" : v + "%");
const avg1 = (a, b) => (b ? (a / b).toFixed(1) : "–");
const fmtDate = s => (s ? new Date(s + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");
const MIN_N = 5;   // below this many players a rate is flagged as a small sample

let load;   // () => Promise<stats>
let data = null;

/* ---------- getting in ---------- */
async function boot() {
  if (new URLSearchParams(location.search).has("demo")) { load = async () => demoStats(); return refresh(); }
  let config = null;
  try { const r = await fetch("/__/firebase/init.json", { cache: "no-store" }); if (r.ok) config = await r.json(); } catch (_) {}
  if (!config) return gate("Couldn't load the Firebase settings. This page only works on the live site or a preview link.");
  const [{ initializeApp }, A, Fn] = await Promise.all([import(SDK + "firebase-app.js"), import(SDK + "firebase-auth.js"), import(SDK + "firebase-functions.js")]);
  const app = initializeApp(config);
  const auth = A.getAuth(app);
  const call = Fn.httpsCallable(Fn.getFunctions(app, "europe-west2"), "adminStats", { timeout: 60000 });
  load = async () => (await call({})).data;
  await auth.authStateReady();
  $("signIn").onclick = async () => {
    try { const p = new A.GoogleAuthProvider(); p.setCustomParameters({ prompt: "select_account" }); await A.signInWithPopup(auth, p); refresh(); }
    catch (e) { if (e.code !== "auth/popup-closed-by-user") gate(e.message, true); }
  };
  const u = auth.currentUser;
  if (!u || u.isAnonymous || !u.email) return gate("Sign in with the admin Google account. If you've been playing as a guest in this browser, this switches you to that account.", true);
  refresh();
}
function gate(text, showSignIn) {
  $("main").hidden = true; $("gate").hidden = false;
  $("gateText").textContent = text; $("signIn").hidden = !showSignIn;
}
async function refresh() {
  $("refresh").disabled = true;
  try {
    data = await load();
    $("gate").hidden = true; $("main").hidden = false;
    render();
  } catch (e) {
    const code = String(e.code || "").replace("functions/", "");
    gate(code === "permission-denied" ? "This page is private, and that account isn't on the admin list. Try another account." : "Couldn't load the numbers: " + e.message, code === "permission-denied");
  } finally { $("refresh").disabled = false; }
}
$("refresh").onclick = refresh;
let resizeT; addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => data && render(), 200); });

/* ---------- charts: plain SVG, one hue per meaning ---------- */
function niceMax(v) { if (v <= 5) return 5; const p = 10 ** Math.floor(Math.log10(v)), m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }
/** bars: [{ label, title, back?, value }] — back is an optional wider, paler bar behind (e.g. started vs finished). */
function barChart(el, bars, { max, fmt = v => v, height = 190 } = {}) {
  if (!bars.length) { el.innerHTML = '<p class="muted small">Nothing yet.</p>'; return; }
  if (el.classList.contains("fill")) { el.innerHTML = ""; height = Math.max(height, Math.floor(el.clientHeight)); }   // take the card's full height
  const W = Math.max(300, Math.round(el.clientWidth || 600)), L = 34, B = 22, T = 8, iw = W - L - 4;   // drawn at real size, so text stays 11px
  const top = max ?? niceMax(Math.max(1, ...bars.map(b => Math.max(b.value, b.back || 0))));   // a given max is used as it is (e.g. 60)
  const H = height, ih = H - B - T;
  const step = iw / bars.length, bw = Math.max(2, Math.min(28, step * 0.7)), every = Math.ceil(bars.length / Math.max(3, Math.min(12, Math.floor(iw / 56))));   // about one label per 56px, so dates don't overlap on a phone
  const y = v => T + ih - (v / top) * ih;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  [0, 0.5, 1].forEach(f => { const v = top * f, yy = y(v); s += `<line x1="${L}" x2="${W - 4}" y1="${yy}" y2="${yy}" stroke="var(--line)" stroke-width="1"/><text x="${L - 6}" y="${yy + 4}" text-anchor="end">${fmt(Math.round(v * 10) / 10)}</text>`; });
  bars.forEach((b, i) => {
    const cx = L + step * i + step / 2;
    s += `<g><title>${esc(b.title)}</title><rect x="${cx - step / 2}" y="${T}" width="${step}" height="${ih}" fill="transparent"/>`;
    if (b.back) s += `<rect x="${cx - bw / 2 - 2}" y="${y(b.back)}" width="${bw + 4}" height="${Math.max(0, T + ih - y(b.back))}" rx="3" fill="var(--soft)"/>`;
    if (b.value > 0) s += `<rect x="${cx - bw / 2}" y="${y(b.value)}" width="${bw}" height="${T + ih - y(b.value)}" rx="3" fill="var(--back-2)"/>`;
    s += "</g>";
    if (i % every === 0) s += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>`;
  });
  el.innerHTML = s + "</svg>";
}
/** A running total over days. points: [{ label, value, title }]. Drawn as a line over a pale area, with a dot per day when there are few. */
function lineChart(el, points, { height = 190 } = {}) {
  if (!points.length) { el.innerHTML = '<p class="muted small">Nothing yet.</p>'; return; }
  const W = Math.max(300, Math.round(el.clientWidth || 600)), L = 34, R = 8, B = 22, T = 8, iw = W - L - R, H = height, ih = H - B - T;
  const top = niceMax(Math.max(1, ...points.map(p => p.value)));
  const n = points.length, step = n > 1 ? iw / (n - 1) : 0;
  const x = i => (n > 1 ? L + step * i : L + iw / 2), y = v => T + ih - (v / top) * ih;
  const every = Math.ceil(n / 8);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  [0, 0.5, 1].forEach(f => { const v = top * f, yy = y(v); s += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="var(--line)" stroke-width="1"/><text x="${L - 6}" y="${yy + 4}" text-anchor="end">${Math.round(v * 10) / 10}</text>`; });
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  if (n > 1) s += `<path d="${line}L${x(n - 1).toFixed(1)},${T + ih}L${x(0).toFixed(1)},${T + ih}Z" fill="var(--soft)" opacity="0.55"/>`;
  s += `<path d="${line}" fill="none" stroke="var(--back-2)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  points.forEach((p, i) => {
    const w = n > 1 ? step : iw;
    s += `<g><title>${esc(p.title)}</title><rect x="${x(i) - w / 2}" y="${T}" width="${w}" height="${ih}" fill="transparent"/>`;
    if (n <= 31 || i === n - 1) s += `<circle cx="${x(i)}" cy="${y(p.value)}" r="${i === n - 1 ? 4 : 3}" fill="var(--back-2)" stroke="var(--card)" stroke-width="1.5"/>`;
    s += "</g>";
    if (i % every === 0 || i === n - 1 && (n - 1) % every > every / 2) s += `<text x="${x(i)}" y="${H - 6}" text-anchor="${n > 1 && i === n - 1 ? "end" : n > 1 && i === 0 ? "start" : "middle"}">${esc(p.label)}</text>`;
  });
  el.innerHTML = s + "</svg>";
}
const table = (head, rows) => rows.length
  ? '<table><thead><tr>' + head.map(h => `<th${h.n ? ' class="n"' : ""}>${h.t}</th>`).join("") + "</tr></thead><tbody>" +
    rows.map(r => "<tr>" + r.map((c, i) => `<td${head[i].n ? ' class="n"' : ""}>${c}</td>`).join("") + "</tr>").join("") + "</tbody></table>"
  : '<p class="muted small">Nothing yet.</p>';
const meter = (v, cls = "") => (v === null ? "" : `<span class="meter ${cls}"><i style="width:${v}%"></i></span>`);
const small = n => (n < MIN_N ? ` <span class="low" title="Small sample">(n=${n})</span>` : ` <span class="muted">(n=${n})</span>`);
const roundName = r => (FAMILY_EMOJI[r.family] || "") + " " + esc(r.label);

/* ---------- the page ---------- */
function render() {
  const d = data, open = d.hands.filter(h => h.open);
  const today = open.at(-1);
  $("updated").textContent = "Updated " + new Date(d.at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }) + (d.launchDate ? " · launch " + fmtDate(d.launchDate) : "");
  $("tiles").innerHTML = [
    ["Visitors (all time)", d.totals.players.toLocaleString("en-GB")],
    ["Accounts", d.totals.accounts == null ? "–" : d.totals.accounts.toLocaleString("en-GB")],
    // accounts that have finished a hand, out of everyone who has (guests included); the admin's own account is left out
    ["Players with an account", d.totals.accountsPlayed == null || d.totals.playedVisitors == null ? "–" : fmtPct(pct(d.totals.accountsPlayed, d.totals.playedVisitors))],
    ["Finished today" + (today ? " · #" + today.hand : ""), today ? today.finished : "–"],
    ["Completion today", today ? fmtPct(pct(today.finished, today.started)) : "–"],
    ["Groups", d.totals.groups],
  ].map(([l, v]) => `<div class="tile"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("");

  barChart($("chPlayers"), open.map(h => ({ label: "#" + h.hand, value: h.finished, back: h.started,
    title: `Hand #${h.hand} (${fmtDate(h.date)}): ${h.started} started, ${h.finished} finished, ${h.bonusPlayed} played the bonus` })));
  barChart($("chNew"), d.newPlayers.map(x => ({ label: fmtDate(x.date), value: x.n, title: `${fmtDate(x.date)}: ${x.n} first visits` })));
  drawGrowth(d);
  drawSources(d.sources);

  const fams = Object.entries(d.families).map(([f, x]) => ({ f, right: pct(x.correct || 0, (x.rounds || 0) * 6), skip: pct(x.skipped || 0, x.dealt || 0), rounds: x.rounds || 0, dealt: x.dealt || 0 }))
    .sort((a, b) => (a.right ?? 101) - (b.right ?? 101));
  $("tbFams").innerHTML = table([{ t: "Subject" }, { t: "Right", n: 1 }, { t: "Skipped", n: 1 }],
    fams.map(x => [(FAMILY_EMOJI[x.f] || "") + " " + esc(x.f) + small(x.dealt), fmtPct(x.right) + meter(x.right), fmtPct(x.skip) + meter(x.skip, "amber")]));

  const rounds = open.flatMap(h => h.rounds.map(r => ({ ...r, hand: h.hand, finished: h.finished })));
  const hard = rounds.filter(r => r.played).sort((a, b) => a.correct / a.played - b.correct / b.played).slice(0, 10);
  $("tbHard").innerHTML = table([{ t: "Hand" }, { t: "Round" }, { t: "Avg /6", n: 1 }, { t: "Avg time", n: 1 }],
    hard.map(r => ["#" + r.hand, roundName(r) + small(r.played), avg1(r.correct, r.played), Math.round(r.time / r.played / 1000) + "s"]));
  const skipped = rounds.filter(r => r.finished).map(r => ({ ...r, rate: pct(r.skipped, r.finished), top: pct(r.strongest, r.finished) }))
    .sort((a, b) => b.rate - a.rate || a.top - b.top).slice(0, 10);
  $("tbSkip").innerHTML = table([{ t: "Hand" }, { t: "Round" }, { t: "Skipped", n: 1 }, { t: "Strongest", n: 1 }],
    skipped.map(r => ["#" + r.hand, roundName(r) + small(r.finished), fmtPct(r.rate) + meter(r.rate, "amber"), fmtPct(r.top)]));

  const pairs = rounds.filter(r => r.played).flatMap(r => r.pairs.map(p => ({ ...p, hand: r.hand, round: r, n: r.played, rate: pct(p.correct, r.played) })))
    .sort((a, b) => a.rate - b.rate || b.n - a.n).slice(0, 20);
  $("tbPairs").innerHTML = '<div class="pairs">' + table([{ t: "Pair" }, { t: "Round" }, { t: "Right", n: 1 }],
    pairs.map(p => [esc(p.prompt) + " → <b>" + esc(p.answer) + "</b>", "#" + p.hand + " " + roundName(p.round), fmtPct(p.rate) + small(p.n) + meter(p.rate)])) + "</div>";

  // drawn last, once the Subjects table beside it has set the row's height
  barChart($("chScore"), open.filter(h => h.finished).map(h => ({ label: "#" + h.hand, value: h.totalScore / h.finished,
    title: `Hand #${h.hand}: average ${(h.totalScore / h.finished).toFixed(1)} from ${h.finished} players` + (h.awareTotal ? `, self-awareness ${Math.round(h.awareTotal / h.finished)}%` : "") })), { max: 60 });
  const pick = $("handPick"), was = pick.value;
  pick.innerHTML = open.slice().reverse().map(h => `<option value="${h.hand}">Hand #${h.hand} · ${fmtDate(h.date)}</option>`).join("");
  if (was && open.find(h => String(h.hand) === was)) pick.value = was;
  pick.onchange = drawHand; drawHand();
}
function drawGrowth(d) {
  const day = x => ({ label: fmtDate(x.date), value: x.n });
  if (!d.accountsByDay) $("chAccounts").innerHTML = `<p class="muted small">${d.totals.accounts === null ? "Couldn't read the sign-ins just now. Try Refresh." : "Not live yet: the server hasn't been updated."}</p>`;
  else {
    const first = d.accountsByDay[0];
    lineChart($("chAccounts"), d.accountsByDay.map((x, i) => ({ ...day(x),
      title: i === 0 && d.accountsBefore ? `${fmtDate(x.date)}: ${x.n} accounts, including ${d.accountsBefore} made before sign-up dates were recorded` : `${fmtDate(x.date)}: ${x.n} accounts` })));
    $("accNote").textContent = "Running total of players with an account (Google or email link), by UTC day. Your own account isn't counted." +
      (first && d.accountsBefore ? ` Sign-up dates are recorded from ${fmtDate(d.accountsFrom)}, so the ${d.accountsBefore} made before then start the line.` : "");
  }
  if (!d.groupsByDay) $("chGroups").innerHTML = '<p class="muted small">Not live yet: the server hasn\'t been updated.</p>';
  else lineChart($("chGroups"), d.groupsByDay.map(x => ({ ...day(x), title: `${fmtDate(x.date)}: ${x.n} groups` })));
}
const VIA = { ref: "link tag", referrer: "referring site", direct: "no source" };
function drawSources(rows) {
  if (!rows) { $("tbSources").innerHTML = '<p class="muted small">Not live yet: the server hasn\'t been updated.</p>'; return; }
  if (!rows.length) { $("tbSources").innerHTML = '<p class="muted small">No visitors in the last 30 days.</p>'; return; }
  const rate = (a, b) => { const v = pct(a, b); return fmtPct(v) + (b && b < MIN_N ? small(b) : "") + meter(v); };
  $("tbSources").innerHTML = table([{ t: "Source" }, { t: "Visitors", n: 1 }, { t: "Played a hand", n: 1 }, { t: "Played 2+", n: 1 }, { t: "A week on", n: 1 }],
    rows.map(r => [esc(r.tag) + (r.via ? ` <span class="muted small">${esc(VIA[r.via] || r.via)}</span>` : ""), r.players,
      rate(r.played, r.players), rate(r.returned, r.players), r.weekEligible ? rate(r.weekOn, r.weekEligible) : "–"]));
}
function drawHand() {
  const h = data.hands.find(x => String(x.hand) === $("handPick").value);
  if (!h) { $("handDetail").innerHTML = '<p class="muted small">No hands open yet.</p>'; return; }
  let s = `<p class="muted small">${h.started} started · ${h.finished} finished · ${h.bonusPlayed} played the bonus` +
    (h.finished ? ` · average ${(h.totalScore / h.finished).toFixed(1)}/60` : "") + "</p>";
  h.rounds.forEach(r => {
    s += `<div class="section"><h2 style="font-size:16px">${roundName(r)}</h2><p class="muted small">` +
      `Played ${r.played} · avg ${avg1(r.correct, r.played)}/6` + (r.played ? ` · ${Math.round(r.time / r.played / 1000)}s` : "") +
      ` · skipped by ${fmtPct(pct(r.skipped, h.finished))} · strongest for ${fmtPct(pct(r.strongest, h.finished))}` +
      (r.bonusPlayed ? ` · bonus ${avg1(r.bonusCorrect, r.bonusPlayed)}/6 (${r.bonusPlayed})` : "") + "</p>";
    if (r.played) s += '<div class="tablewrap pairs">' + table([{ t: "Pair" }, { t: "Right", n: 1 }],
      r.pairs.map(p => { const v = pct(p.correct, r.played); return [esc(p.prompt) + " → <b>" + esc(p.answer) + "</b>", fmtPct(v) + meter(v)]; })) + "</div>";
    s += "</div>";
  });
  $("handDetail").innerHTML = s;
}

/* ---------- made-up numbers for ?demo=1 ---------- */
function demoStats() {
  let seed = 7; const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const start = new Date(); start.setUTCDate(start.getUTCDate() - (DAYS.length - 1));
  const hands = DAYS.map((cats, i) => {
    const h = toHand(cats, i + 1), started = 40 + Math.floor(r() * 80) + i * 25, finished = Math.floor(started * (0.7 + r() * 0.25));
    const date = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    return {
      hand: i + 1, date, open: true, started, finished, bonusPlayed: Math.floor(finished * 0.4), totalScore: finished * (25 + r() * 15), awareTotal: finished * (70 + r() * 20), tally: {},
      rounds: h.categories.map((c, slot) => {
        const skipped = Math.floor(finished * r() * 0.45), played = finished - skipped, pairs = h.rounds[slot].prompts.map((p, k) => ({ prompt: p, answer: h.rounds[slot].answers[k], correct: Math.floor(played * (0.2 + r() * 0.75)) }));
        return { ...c, played, skipped, strongest: Math.floor(finished * r() * 0.4), correct: pairs.reduce((t, p) => t + p.correct, 0), time: played * (15000 + r() * 25000), bonusPlayed: Math.floor(skipped * 0.4), bonusCorrect: Math.floor(skipped * 0.4 * 3), pairs };
      }),
    };
  });
  const families = {};
  hands.forEach(h => h.rounds.forEach(x => { if (x.family === WILDCARD) return; const f = (families[x.family] ||= { dealt: 0, skipped: 0, rounds: 0, correct: 0 }); f.dealt += h.finished; f.skipped += x.skipped; f.rounds += x.played; f.correct += x.correct; }));
  const today = Date.now();
  return {
    launchDate: hands[0].date, at: today, totals: { players: 412, groups: 37, accounts: 58, accountsPlayed: 55, playedVisitors: 301 }, families, hands,
    accountsFrom: hands[0].date, accountsBefore: 12,
    accountsByDay: hands.map((h, i) => ({ date: h.date, n: 12 + Math.round(46 * (i / Math.max(1, hands.length - 1)) ** 1.4) })),
    groupsByDay: hands.map((h, i) => ({ date: h.date, n: Math.round(37 * (i / Math.max(1, hands.length - 1)) ** 1.2) })),
    newPlayers: Array.from({ length: 30 }, (_, i) => ({ date: new Date(today - (29 - i) * 86400000).toISOString().slice(0, 10), n: i < 26 ? 0 : Math.floor(30 + r() * 90) })),
    sources: [["direct", "direct"], ["dailydle", "referrer"], ["reddit", "ref"], ["untracked", null], ["dlesgg", "referrer"], ["invite", "ref"], ["someblog.com", "referrer"]].map(([tag, via], i) => {
      const players = Math.max(2, Math.floor((140 - i * 20) * (0.5 + r()))), played = Math.floor(players * (0.5 + r() * 0.4)), returned = Math.floor(played * r() * 0.7), weekEligible = Math.floor(players * 0.6);
      return { tag, via, players, played, returned, weekEligible, weekOn: Math.floor(weekEligible * r() * 0.4) };
    }),
  };
}

boot();
