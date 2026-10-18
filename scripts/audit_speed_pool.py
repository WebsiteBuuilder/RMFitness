#!/usr/bin/env python3
"""One-off audit dump, round 4: every Speed Duel product's card list from Konami's official card database."""
import json, time, urllib.request
from pathlib import Path
OUT = Path("audit/konami"); OUT.mkdir(parents=True, exist_ok=True)
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
PACKS = [["2000001416000", "SPEED DUEL: BATTLE CITY FINALS", "2024/12/13"], ["2000001337000", "SPEED DUEL TOURNAMENT PACK 7", "2024/04/03"], ["2000001338000", "SPEED DUEL GX: MIDTERM DESTRUCTION", "2024/03/29"], ["2000001280000", "SPEED DUEL TOURNAMENT PACK 6", "2023/09/06"], ["2000001261000", "SPEED DUEL: STREETS OF BATTLE CITY", "2023/08/25"], ["2000001221000", "SPEED DUEL GX: DUELISTS OF SHADOWS", "2023/03/31"], ["2000001236000", "SPEED DUEL TOURNAMENT PACK 5", "2023/03/08"], ["2000001169000", "SPEED DUEL GX: MIDTERM PARADOX", "2022/10/10"], ["2000001205000", "SPEED DUEL TOURNAMENT PACK 4", "2022/09/16"], ["2000001150000", "SPEED DUEL GX: DUEL ACADEMY BOX", "2022/03/18"], ["2000001158000", "SPEED DUEL TOURNAMENT PACK 3", "2022/03/10"], ["1202002002", "Speed Duel: Battle City Box", "2020/11/26"], ["1202002000", "SPEED DUEL STARTER DECKS: MATCH OF THE MILLENNIUM", "2020/05/15"], ["1202002001", "SPEED DUEL STARTER DECKS: TWISTED NIGHTMARES", "2020/05/15"], ["1202001007", "SPEED DUEL: TRIALS OF THE KINGDOM", "2019/12/06"], ["1202001006", "SPEED DUEL: TRIALS OF THE KINGDOM Sneak Peak", "2019/11/30"], ["1202001005", "SPEED DUEL TOURNAMENT PACK 02", "2019/10/11"], ["1202001002", "Event Pack Speed Duel", "2019/08/02"], ["1202001003", "SPEED DUEL: SCARS OF BATTLE", "2019/08/02"], ["1202001004", "SPEED DUEL STARTER DECKS: ULTIMATE PREDATORS", "2019/08/02"], ["1202001001", "SPEED DUEL: ATTACK FROM THE DEEP", "2019/05/31"], ["2000000923000", "SPEED DUEL TOURNAMENT PACK 01", "2019/04/18"], ["11118003", "SPEED DUEL: ARENA OF LOST SOULS", "2019/03/29"], ["13317000", "SPEED DUEL STARTER DECK: DESTINY MASTERS", "2019/01/25"], ["13317001", "SPEED DUEL STARTER DECK: DUELISTS OF TOMORROW", "2019/01/25"]]
log = []
for pid, name, date in PACKS:
    url = f"https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=1&sess=1&pid={pid}&rp=99999&request_locale=en"
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en"}), timeout=120) as r:
                (OUT / f"{pid}.html").write_bytes(r.read())
            break
        except Exception as e:
            log.append(f"{name}: {e}"); time.sleep(2 ** i)
    time.sleep(1.5)
(OUT / "packs.json").write_text(json.dumps(PACKS, indent=1))
(OUT / "log.txt").write_text("\n".join(log) + "\n")
