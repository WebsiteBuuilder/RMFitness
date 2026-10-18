#!/usr/bin/env python3
"""One-off audit dump, round 3: Konami's official card database + Yu-Gi-Oh! Fandom, Speed Duel products."""
import json, re, sys, time, urllib.parse, urllib.request
from pathlib import Path
OUT = Path("audit/raw"); OUT.mkdir(parents=True, exist_ok=True)
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
log = []
def get(url, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en"}), timeout=90) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:
            log.append(f"{url}: {e}"); time.sleep(2 ** i)
    return None
DB = "https://www.db.yugioh-card.com/yugiohdb/"
packs = get(DB + "card_list.action?request_locale=en")
if packs:
    (OUT / "konami-packs.html").write_text(packs)
    # Each product row: a hidden input with the pack link, then the product name.
    found = []
    for m in re.finditer(r'value="(/yugiohdb/card_search\.action\?ope=1&(?:amp;)?sess=1&(?:amp;)?pid=(\d+)[^"]*)"', packs):
        pid = m.group(2)
        tail = packs[m.end(): m.end() + 600]
        nm = re.search(r'<strong>\s*(.*?)\s*</strong>', tail, re.S)
        found.append((pid, re.sub(r"\s+", " ", nm.group(1)) if nm else ""))
    speed = [(p, n) for p, n in found if "speed duel" in n.lower() or "trials of the pharaoh" in n.lower()]
    (OUT / "konami-speed-packs.json").write_text(json.dumps({"all": len(found), "speed": speed}, indent=1))
    for pid, name in speed:
        html = get(DB + f"card_search.action?ope=1&sess=1&pid={pid}&rp=99999&request_locale=en")
        if html:
            (OUT / f"konami-{pid}.html").write_text(html)
        time.sleep(1)
# Fandom (MediaWiki), backup source.
FW = "https://yugioh.fandom.com/api.php?format=json&formatversion=2&"
fl = {}
for t in ["Speed Duel GX: Midterm Destruction", "Speed Duel: Battle City Finals", "Speed Duel Tournament Pack 7", "Speed Duel"]:
    d = get(FW + "action=parse&prop=wikitext&redirects=1&page=" + urllib.parse.quote(t))
    fl[t] = json.loads(d).get("parse", {}).get("wikitext") if d else None
    time.sleep(1)
(OUT / "fandom.json").write_text(json.dumps(fl, indent=1))
(OUT / "log.txt").write_text("\n".join(log) + "\n")
print(len(log), "errors")
