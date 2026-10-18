#!/usr/bin/env python3
"""One-off audit dump: fresh Speed Duel product lists from YGOPRODeck (and Yugipedia, best effort)."""
import json, sys, time, urllib.parse, urllib.request
from pathlib import Path
OUT = Path("audit"); OUT.mkdir(exist_ok=True)
UA = "eternal-duelist-soul-remake speed duel audit (github actions)"
def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=90) as r:
                return r.read()
        except Exception as e:
            print("retry", url, e, file=sys.stderr); time.sleep(2 ** i)
    raise RuntimeError(url)
API = "https://db.ygoprodeck.com/api/v7/"
sets = json.loads(get(API + "cardsets.php"))
speed_sets = [s for s in sets if "speed duel" in s["set_name"].lower()]
(OUT / "sets.json").write_text(json.dumps(speed_sets, indent=1))
members = {}
for s in speed_sets:
    try:
        d = json.loads(get(API + "cardinfo.php?cardset=" + urllib.parse.quote(s["set_name"]))).get("data", [])
    except Exception as e:
        print("fail", s["set_name"], e, file=sys.stderr); d = []
    members[s["set_name"]] = [{"id": c["id"], "name": c["name"], "type": c.get("type"),
        "prints": [p for p in c.get("card_sets") or [] if p.get("set_name") == s["set_name"]],
        "alt": [i["id"] for i in c.get("card_images") or []]} for c in d]
    time.sleep(0.2)
(OUT / "members.json").write_text(json.dumps(members, indent=1))
allc = json.loads(get(API + "cardinfo.php?misc=yes")).get("data", [])
slim = []
for c in allc:
    fm = (c.get("misc_info") or [{}])[0].get("formats", [])
    sp = [p for p in c.get("card_sets") or [] if "speed duel" in p.get("set_name", "").lower()]
    slim.append({"id": c["id"], "name": c["name"], "type": c.get("type"), "formats": fm, "speedPrints": sp,
                 "alt": [i["id"] for i in c.get("card_images") or []]})
(OUT / "all.json").write_text(json.dumps(slim))
print(len(speed_sets), "sets", len(slim), "cards")
# Yugipedia, best effort: every Speed Duel set card list page.
try:
    yp = {}
    q = "https://yugipedia.com/api.php?action=query&list=allpages&apprefix=Set%20Card%20Lists:Speed%20Duel&aplimit=500&format=json"
    pages = [p["title"] for p in json.loads(get(q))["query"]["allpages"]]
    q2 = "https://yugipedia.com/api.php?action=query&list=search&srsearch=intitle:%22Set%20Card%20Lists%22%20%22Speed%20Duel%22&srlimit=500&format=json"
    try: pages += [p["title"] for p in json.loads(get(q2))["query"]["search"]]
    except Exception as e: print("yp search", e, file=sys.stderr)
    for t in sorted(set(pages)):
        txt = json.loads(get("https://yugipedia.com/api.php?action=parse&prop=wikitext&format=json&page=" + urllib.parse.quote(t)))
        yp[t] = txt.get("parse", {}).get("wikitext", {}).get("*", "")
        time.sleep(1)
    (OUT / "yugipedia.json").write_text(json.dumps(yp, indent=1))
    print(len(yp), "yugipedia pages")
except Exception as e:
    print("yugipedia failed", e, file=sys.stderr)
