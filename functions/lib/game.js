// Pure game rules: no Firebase here, so everything can be unit-tested.
import { randomInt } from "node:crypto";

// Rounds have no time limit. The server still times each one (from the end of the 3-2-1 countdown to lock-in)
// to split tied scores, counting at most ROUND_CAP_SECONDS so a round left open for hours can't skew the totals.
export const ROUND_CAP_SECONDS = 600;

// "Joker" is a wildcard subject for silly one-off rounds (April Fools and the like). It plays like any other
// subject but is left out of every per-subject stat: profiles, group subject tables, skip data and the admin page.
export const WILDCARD_FAMILY = "Joker";
export const countsInStats = family => family !== WILDCARD_FAMILY;
export const PAIRS = 6;
export const CATEGORIES = 5;
export const MAX_SCORE = PAIRS * (1 + 2 + 3 + 4);   // 60

/** Hand N opens at local midnight; the earliest time zone is UTC+14, so it can be read from 10:00 UTC the day before. */
export function handDate(launchDate, hand) {
  const [y, m, d] = launchDate.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + (hand - 1) * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
export function opensAtMs(launchDate, hand) {
  const [y, m, d] = handDate(launchDate, hand).split("-").map(Number);
  return Date.UTC(y, m - 1, d) - 14 * 3600000;
}

/** ranking: five category slots (0–4), strongest first. The fifth is skipped; the other four are played weakest first. */
export function checkRanking(ranking) {
  if (!Array.isArray(ranking) || ranking.length !== CATEGORIES) return false;
  const s = new Set(ranking);
  return s.size === CATEGORIES && ranking.every(x => Number.isInteger(x) && x >= 0 && x < CATEGORIES);
}
export function playOrder(ranking) {
  return { order: ranking.slice(0, 4).reverse(), skipped: ranking[4] };   // order[k] is played as round k, worth ×(k+1)
}

/** Next round key for a play: "0"–"3", "bonus", or null if nothing is left. */
export function nextRoundKey(play, wantBonus) {
  const done = play.rounds || {};
  for (let k = 0; k < 4; k++) if (!done[k]) return wantBonus ? null : String(k);
  if (wantBonus && !play.bonus) return "bonus";
  return null;
}

export function shuffledPerm(n = PAIRS, rnd = randomInt) {
  const p = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) { const j = rnd(i + 1); [p[i], p[j]] = [p[j], p[i]]; }
  return p;
}

/** picks[i] is the index (in the shuffled list shown) chosen for prompt i, or null. perm[j] is the true answer index at shuffled position j. */
export function checkPicks(picks) {
  if (!Array.isArray(picks) || picks.length !== PAIRS) return false;
  const used = picks.filter(x => x !== null);
  return used.every(x => Number.isInteger(x) && x >= 0 && x < PAIRS) && new Set(used).size === used.length;
}
export function markRound(perm, picks, late = false) {
  const chosen = picks.map(j => (j === null || late) ? null : perm[j]);   // true answer index chosen for each prompt
  const marks = chosen.map((a, i) => a === i);
  return { chosen, marks, correct: marks.filter(Boolean).length };
}

/** Score, best possible score for these results, and self-awareness %. correct[k] is round k's correct count (worth ×(k+1)). */
export function finalScore(correct) {
  const score = correct.reduce((s, c, k) => s + c * (k + 1), 0);
  const best = correct.slice().sort((a, b) => a - b).reduce((s, c, k) => s + c * (k + 1), 0);
  const aware = best === 0 ? 100 : Math.round((score / best) * 100);
  return { score, best, aware };
}

export function nextStreak(stats, hand) {
  if (!stats || !stats.lastHand) return 1;
  return stats.lastHand === hand - 1 ? (stats.streak || 0) + 1 : (stats.lastHand === hand ? stats.streak || 1 : 1);
}

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{1,19}$/u;
export function cleanName(name) {
  if (typeof name !== "string") return null;
  const n = name.trim().replace(/\s+/g, " ");
  return NAME_RE.test(n) ? n : null;
}
export function defaultName(rnd = randomInt) {
  return "Player " + (1000 + rnd(9000));
}

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no 0/O, 1/I/L
export function groupCode(rnd = randomInt) {
  return Array.from({ length: 6 }, () => CODE_CHARS[rnd(CODE_CHARS.length)]).join("");
}
export function cleanGroupName(name) {
  if (typeof name !== "string") return null;
  const n = name.trim().replace(/\s+/g, " ");
  return n.length >= 2 && n.length <= 30 ? n : null;
}
export const FREE_GROUP_CAP = 10;
/** Symbols a group can wear. The app maps each ID to its glyph. */
export const GROUP_SYMBOLS = ["spade", "heart", "diamond", "club", "joker", "crown", "star", "dice", "trophy", "target",
  "beer", "wine", "coffee", "brain", "owl", "fire", "bolt", "octopus", "fox", "bee"];
export const cleanSymbol = s => (GROUP_SYMBOLS.includes(s) ? s : null);
