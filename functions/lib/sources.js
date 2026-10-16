// Where a new player came from, recorded once when their profile is made (first touch wins).
// Order: a ?ref= tag on the link, then the referring site, then "direct".
// Only the referring site's name is kept, never the page path or anything else about the visit.

// Sites we know, by host (a subdomain matches too: old.reddit.com counts as reddit.com).
const KNOWN = {
  "dailydle.org": "dailydle",
  "dles.gg": "dlesgg",
  "dlehunt.com": "dlehunt",
  "dles.aukspot.com": "thedles",
  "reddit.com": "reddit",
  "lemmy.zip": "lemmy",
  "lemmy.world": "lemmy",
  "instagram.com": "instagram",
  "facebook.com": "facebook",
  "t.co": "x",
  "x.com": "x",
  "twitter.com": "x",
  "bsky.app": "bluesky",
  "linkedin.com": "linkedin",
  "producthunt.com": "producthunt",
  "peerpush.com": "peerpush",
  "news.ycombinator.com": "hackernews",
  "roomescapeartist.com": "roomescapeartist",
  "adoryvo.github.io": "adoryvo",
  "jackvsevil.github.io": "prototype",
  "bing.com": "bing",
  "duckduckgo.com": "duckduckgo",
  "com.google.android.googlequicksearchbox": "google",   // the Google app on Android (android-app:// referrer)
};
// Our own sites and the sign-in pages: arriving from these says nothing about where someone came from.
const IGNORE = ["strongsuitgame.com", "strong-suit.web.app", "strong-suit.firebaseapp.com", "accounts.google.com"];

const TAG = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const HOST = /^[a-z0-9.-]{1,100}$/;
const under = (host, site) => host === site || host.endsWith("." + site);

/** The host of a referrer URL, lowercased and without "www.", or null. */
export function refHost(referrer) {
  if (typeof referrer !== "string" || !referrer || referrer.length > 2000) return null;
  let h;
  try { h = new URL(referrer).hostname.toLowerCase(); } catch (_) { return null; }
  h = h.replace(/^www\./, "").replace(/\.$/, "");
  if (!HOST.test(h) || !h.includes(".")) return null;
  if (IGNORE.some(s => under(h, s))) return null;
  return h;
}

/** The tag for a referring host: a known name, "google" for any Google search domain, or the host itself. */
export function hostTag(host) {
  for (const [site, tag] of Object.entries(KNOWN)) if (under(host, site)) return tag;
  if (/^(google|m\.google|news\.google)\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host)) return "google";
  return host;
}

/** What the server stores, from what the page sent: { ref, referrer }. Bad input is ignored, never an error. */
export function cleanSource(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const ref = typeof s.ref === "string" ? s.ref.trim().toLowerCase() : "";
  const host = refHost(s.referrer);
  if (TAG.test(ref)) return { tag: ref, via: "ref", ...(host ? { host } : {}) };
  if (host) return { tag: hostTag(host), via: "referrer", host };
  return { tag: "direct", via: "direct" };
}
