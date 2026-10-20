// A local copy of the server's game rules. Used for the practice hand and demo mode only;
// real hands are always checked by the server (functions/lib/handlers.js).
export const ROUND_CAP_SECONDS = 600;   // no time limit; time (for tie-breaks) counts at most 10 minutes a round
const LEAD_SECONDS = 3;

export function finalScore(correct) {
  const score = correct.reduce((s, c, k) => s + c * (k + 1), 0);
  const best = correct.slice().sort((a, b) => a - b).reduce((s, c, k) => s + c * (k + 1), 0);
  return { score, best, aware: best === 0 ? 100 : Math.round((score / best) * 100) };
}
const shuffle = n => { const p = [...Array(n).keys()]; for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } return p; };
const err = (code, message) => Object.assign(new Error(message), { code });

/**
 * hands: { [n]: { categories:[{slot,label,family,categoryId}], rounds:[{prompts,answers,fact,src}] } }
 * plays: an object the caller may persist; onSave is called after every change.
 */
export function makeEngine({ hands, plays = {}, onSave = () => {}, onFinish = () => {} }) {
  const secrets = {};
  return {
    getPlay: async n => plays[n] ? structuredClone(plays[n]) : null,
    async startHand(n, ranking) {
      const h = hands[n];
      if (!h) throw err("not-found", "That hand doesn't exist.");
      if (plays[n]) return { order: plays[n].order, skipped: plays[n].skipped, resumed: true };
      const order = ranking.slice(0, 4).reverse(), skipped = ranking[4];
      plays[n] = { hand: n, ranking, order, skipped, categories: h.categories, rounds: {}, status: "playing", startedAt: Date.now() };
      onSave(); return { order, skipped };
    },
    async startRound(n, bonus) {
      const p = plays[n];
      if (!p) throw err("failed-precondition", "Rank your hand first.");
      if (p.current && (p.current.key === "bonus") === !!bonus) return { ...p.current, now: Date.now(), capSeconds: ROUND_CAP_SECONDS };
      let key = null;
      if (bonus) key = p.status === "done" && !p.bonus ? "bonus" : null;
      else for (let k = 0; k < 4; k++) if (!p.rounds[k]) { key = String(k); break; }
      if (!key) throw err("failed-precondition", "Nothing left to play.");
      const slot = key === "bonus" ? p.skipped : p.order[+key];
      const r = hands[n].rounds[slot], cat = p.categories[slot], perm = shuffle(6);
      secrets[n] = perm;
      p.current = { key, slot, mult: key === "bonus" ? 0 : +key + 1, label: cat.label, family: cat.family,
        prompts: r.prompts, answers: perm.map(j => r.answers[j]), startsAt: Date.now() + LEAD_SECONDS * 1000 };
      onSave();
      return { ...p.current, now: Date.now(), capSeconds: ROUND_CAP_SECONDS };
    },
    async submitRound(n, key, picks, timeMs) {
      const p = plays[n], cur = p && p.current;
      if (!cur || cur.key !== key) throw err("failed-precondition", "That round isn't in play.");
      const perm = secrets[n] || cur.answers.map(a => hands[n].rounds[cur.slot].answers.indexOf(a));
      const chosen = picks.map(j => (j === null ? null : perm[j]));
      const marks = chosen.map((a, i) => a === i);
      const r = hands[n].rounds[cur.slot], cat = p.categories[cur.slot];
      const result = { slot: cur.slot, mult: cur.mult, label: cat.label, family: cat.family, categoryId: cat.categoryId,
        correct: marks.filter(Boolean).length, marks, late: false, timeMs,
        review: { prompts: r.prompts, answers: r.answers, chosen, fact: r.fact, src: r.src } };
      delete p.current;
      let final;
      if (key === "bonus") p.bonus = result;
      else {
        p.rounds[key] = result;
        if (key === "3") {
          final = finalScore([0, 1, 2, 3].map(k => p.rounds[k].correct));
          final.time = [0, 1, 2, 3].reduce((t, k) => t + Math.min(ROUND_CAP_SECONDS * 1000, p.rounds[k].timeMs || 0), 0);
          Object.assign(p, final, { status: "done", finishedAt: Date.now() });
          onFinish(n, p);
        }
      }
      onSave();
      return final ? { result, final } : { result };
    },
  };
}
