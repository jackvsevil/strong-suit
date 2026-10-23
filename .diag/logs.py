# Server time per function since #13 went live, compared with the 20 Oct baseline.
import collections, json
SINCE = "2026-10-20T14:21:00Z"
rows = [e for e in json.load(open("req.json")) if e["timestamp"] >= SINCE]
first, seen = {}, set()
by = collections.defaultdict(lambda: {"first": [], "later": [], "pre": [], "err": collections.Counter()})
days = set()
for e in sorted(rows, key=lambda e: e["timestamp"]):
    svc = e["resource"]["labels"]["service_name"]; hr = e.get("httpRequest", {})
    lat = float(hr.get("latency", "0s")[:-1]); st = str(hr.get("status")); inst = e.get("labels", {}).get("instanceId", "?")
    days.add(e["timestamp"][:10])
    if st == "204": by[svc]["pre"].append(lat); continue
    if st != "200": by[svc]["err"][st] += 1; continue
    k = (svc, inst)
    by[svc]["first" if k not in first else "later"].append(lat); first[k] = 1
med = lambda v: sorted(v)[len(v)//2] if v else 0
p90 = lambda v: sorted(v)[int(len(v)*.9)] if v else 0
print(f"Since {SINCE}: {len(rows)} log lines over {len(days)} days")
for svc, d in sorted(by.items()):
    slow = sum(1 for x in d["pre"] if x > 1)
    print(f"{svc}: wake-ups {slow}/{len(d['pre'])} | first call {len(d['first'])}x median {med(d['first']):.2f}s | later {len(d['later'])}x median {med(d['later']):.3f}s p90 {p90(d['later']):.2f}s | errors {dict(d['err']) or 0}")
