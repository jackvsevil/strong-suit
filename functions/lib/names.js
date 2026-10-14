// Checks nicknames and group names before they're saved. Runs only on the server, so it can't be bypassed.
// A filter is a first line of defence, not a guarantee: the Moderate workflow cleans up anything that slips through.
import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from "obscenity";

const dataset = englishDataset.build();
const matcher = new RegExpMatcher({
  ...dataset,
  ...englishRecommendedTransformers,
  // the dataset's own exceptions, plus innocent words it would otherwise catch
  whitelistedTerms: [...(dataset.whitelistedTerms || []), "penistone", "pussycat", "pussy cat", "pussy willow"],
});

// Extra words the dataset misses (mostly British), plus names that could pass for us. Matched as whole words.
const EXTRA = ["bellend", "tosser", "bollocks", "minge", "nonce", "paedo", "pedo", "phuck", "phuk", "fuk", "nazi", "nazis", "hitler", "kkk", "kys"];
const RESERVED = ["admin", "administrator", "moderator", "mod", "official", "staff", "support", "system", "strongsuit"];

const squash = w => w.replace(/(.)\1+/g, "$1");   // "fuuuk" → "fuk"
const BLOCKED_WORDS = new Set([...EXTRA, ...RESERVED].map(squash));
const blocked = w => { const q = squash(w); return BLOCKED_WORDS.has(q) || (q.endsWith("s") && BLOCKED_WORDS.has(q.slice(0, -1))); };   // plurals too

function plain(s) {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[0-9@$]/g, c => ({ 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s" }[c] ?? c));
}
/** "f u c k" or "f.u.c.k" → "fuck": joins runs of single characters. */
function joinSpelledOut(s) {
  const out = [];
  for (const t of s.split(/[^\p{L}\p{N}@$]+/u).filter(Boolean)) {
    if (t.length === 1 && out.length && out.at(-1).single) out.at(-1).w += t;
    else out.push({ w: t, single: t.length === 1 });
  }
  return out.map(x => x.w).join(" ");
}

/** True if the name can be shown to other players. */
export function allowedName(name) {
  const variants = [name, joinSpelledOut(name)];
  if (variants.some(v => matcher.hasMatch(v))) return false;
  for (const v of variants) {
    const p = plain(v);
    const words = p.split(/[^a-z]+/).filter(Boolean);
    if (words.some(blocked)) return false;
    if (words.some((w, i) => i && blocked(words[i - 1] + w))) return false;   // "bell end"
    if (p.replace(/[^a-z]/g, "").includes("strongsuit")) return false;
  }
  return true;
}
