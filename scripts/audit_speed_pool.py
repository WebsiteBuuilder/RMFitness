#!/usr/bin/env python3
"""One-off audit dump, round 2: Yugipedia set card lists for every Speed Duel product."""
import json, sys, time, urllib.parse, urllib.request
from pathlib import Path
OUT = Path("audit"); OUT.mkdir(exist_ok=True)
UA = "Mozilla/5.0 (compatible; EDSRemakeAudit/1.0; +https://github.com/WebsiteBuuilder/RMFitness) python-urllib"
log = []
def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"}), timeout=90) as r:
                return r.read()
        except Exception as e:
            log.append(f"{url}: {e}"); time.sleep(2 ** i)
    return None
SETS = ["Speed Duel Starter Decks: Destiny Masters", "Speed Duel Starter Decks: Duelists of Tomorrow", "Speed Duel: Arena of Lost Souls",
 "Yu-Gi-Oh! Day April 2019 promotional card", "Speed Duel Tournament Pack 1", "Speed Duel: Attack from the Deep", "Speed Duel Demo Deck",
 "Speed Duel Starter Decks: Ultimate Predators", "Speed Duel: Scars of Battle", "Event Pack Speed Duel", "Speed Duel: Scars of Battle Launch Event participation card",
 "Speed Duel Tournament Pack 2", "Speed Duel: Trials of the Kingdom Sneak Peek participation cards", "Speed Duel: Trials of the Kingdom",
 "Trials of the Pharaoh - Trials of the Kingdom promotional card", "Speed Duel Demo Deck 2020", "SJ Jump Pack Spring 2020 promotional card",
 "Speed Duel Starter Decks: Twisted Nightmares", "Speed Duel Starter Decks: Match of the Millennium",
 "Trials of the Pharaoh - Match of the Millennium & Twisted Nightmares promotional card", "Speed Duel: Battle City Box",
 "Trials of the Pharaoh - Speed Duel: Battle City Box promotional card", "Speed Duel GX: Duel Academy Box", "Speed Duel Tournament Pack 3",
 "Trials of the Pharaoh - Speed Duel GX: Duel Academy Box promotional card", "Speed Duel Tournament Pack 4", "Speed Duel GX: Midterm Paradox",
 "Trials of the Pharaoh - Speed Duel GX: Midterm Paradox promotional card", "Speed Duel Tournament Pack 5", "Speed Duel GX: Duelists of Shadows",
 "Speed Duel: Streets of Battle City", "Speed Duel Tournament Pack 6", "Speed Duel GX: Midterm Destruction", "Speed Duel Tournament Pack 7",
 "Speed Duel: Battle City Finals"]
API = "https://yugipedia.com/api.php?format=json&formatversion=2&"
out = {}
# The Speed Duel page itself (to catch any product newer than this list).
for t in ["Speed Duel"] + SETS:
    d = get(API + "action=parse&prop=wikitext&redirects=1&page=" + urllib.parse.quote(t))
    out[t] = json.loads(d).get("parse", {}).get("wikitext", "") if d else None
    time.sleep(1.5)
# Every "Set Card Lists:" page whose title mentions Speed Duel or the promo sets.
lists = {}
for prefix in ["Speed Duel", "Yu-Gi-Oh! Day April 2019", "Event Pack Speed Duel", "Trials of the Pharaoh", "SJ Jump Pack Spring 2020"]:
    d = get(API + "action=query&list=allpages&apnamespace=0&aplimit=500&apprefix=" + urllib.parse.quote("Set Card Lists:" + prefix))
    titles = [p["title"] for p in json.loads(d)["query"]["allpages"]] if d else []
    for t in titles:
        d2 = get(API + "action=parse&prop=wikitext&page=" + urllib.parse.quote(t))
        lists[t] = json.loads(d2).get("parse", {}).get("wikitext", "") if d2 else None
        time.sleep(1.5)
(OUT / "yugipedia-sets.json").write_text(json.dumps(out, indent=1))
(OUT / "yugipedia-lists.json").write_text(json.dumps(lists, indent=1))
(OUT / "log.txt").write_text("\n".join(log))
print(len(out), len(lists), len(log))
