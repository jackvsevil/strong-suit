# Slow preflights (a server waking up) on the three round functions, split into:
#  "background": all three woke within 3s of each other (the app's wake-up call, made on the home or ranking screen)
#  "player wait": a function woke on its own, so a player's real request waited for it
import collections, json, datetime as dt
P = lambda s: dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
ROUND = ("starthand", "startround", "submitround")
rows = json.load(open("req.json"))
periods = [("Before #12 (17-20 Oct)", "2026-10-17T00:00:00Z", "2026-10-20T13:27:00Z"), ("After #13 (20-23 Oct)", "2026-10-20T14:21:00Z", "2099-01-01T00:00:00Z")]
for name, a, b in periods:
    ev = [e for e in rows if a <= e["timestamp"] < b and e["resource"]["labels"]["service_name"] in ROUND]
    pre = [(P(e["timestamp"]), e["resource"]["labels"]["service_name"], float(e["httpRequest"].get("latency", "0s")[:-1])) for e in ev if str(e.get("httpRequest", {}).get("status")) == "204"]
    slow = [(t, s) for t, s, l in pre if l > 1]
    c = collections.Counter(); bg = collections.Counter()
    for t, s in slow:
        others = {s2 for t2, s2 in slow if s2 != s and abs((t2 - t).total_seconds()) <= 3}
        (bg if len(others) == 2 else c)[s] += 1
    tot = collections.Counter(s for _, s, _ in pre)
    days = (min(P(b), max(t for t, _, _ in pre)) - max(P(a), min(t for t, _, _ in pre))).total_seconds() / 86400 if pre else 0
    hands = sum(1 for e in ev if e["resource"]["labels"]["service_name"] == "starthand" and str(e["httpRequest"].get("status")) == "200")
    print(f"{name}: about {days:.1f} days, {hands} starthand calls (incl. wake-ups)")
    for s in ROUND:
        print(f"   {s}: {tot[s]} calls; player waited for a wake-up {c[s]}x ({100*c[s]/max(1,tot[s]):.0f}%), background wake-ups {bg[s]}x")
