#!/usr/bin/env python3
"""
Builds the Speed Duel card list for the Speed Duel game (public/cards/speed.json).

- The pool is every card printed in a Speed Duel product, and nothing else: Konami's own product
  lists (scripts/speed-products.json, from the official card database) plus YGOPRODeck's Speed Duel
  set lists (promos, demo decks), and every Skill Card (YGOPRODeck, plus the newer Skills it lacks in
  scripts/speed-skills-extra.json). YGOPRODeck's "speed duel" format tag is NOT used: it lists
  hundreds of cards Konami never printed for Speed Duel and misses the 2024 products.
- Card data and images come from the YGOPRODeck API.
- Downloads each new card image ONCE (the API asks apps to re-host) as a small WebP
  next to the EDS images in public/cards/img/<id>.webp.
- Never touches public/cards/cards.json (the EDS list).

Runs in GitHub Actions (see .github/workflows/cards.yml).
"""
import io
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

API = "https://db.ygoprodeck.com/api/v7/cardinfo.php"
SETS_API = "https://db.ygoprodeck.com/api/v7/cardsets.php"
IMG = "https://images.ygoprodeck.com/images/cards/{id}.jpg"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "cards" / "speed.json"
SETS_OUT = ROOT / "public" / "cards" / "speedSets.json"
IMG_DIR = ROOT / "public" / "cards" / "img"
REPORT_OUT = ROOT / "public" / "cards" / "speed-sets.json"
PRODUCTS = ROOT / "scripts" / "speed-products.json"
EXTRA_SKILLS = ROOT / "scripts" / "speed-skills-extra.json"
# Konami's spelling -> YGOPRODeck's.
ALIASES = {"Falchionβ": "Falchion Beta"}
# Tokens a Speed Duel card creates (kept for their picture): The Golden Apples.
TOKENS = ["Malus Token"]
IMG_WIDTH = 300
IMG_QUALITY = 72
DELAY = 0.2
UA = "eternal-duelist-soul-remake speed duel snapshot (github actions)"


def get(url: str, retries: int = 4) -> bytes:
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            wait = 2**attempt
            print(f"  retry {attempt + 1} for {url}: {e} (waiting {wait}s)", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"failed to fetch {url}")


def api(query: str) -> list[dict]:
    return json.loads(get(f"{API}?{query}")).get("data", [])


def is_speed_set(name: str) -> bool:
    """Every Speed Duel product: Starter Decks, Speed Duel Decks, booster boxes, GX boxes, Tournament Packs."""
    n = name.lower()
    return "speed duel" in n


def set_list() -> list[dict]:
    sets = json.loads(get(SETS_API))
    return sorted((s for s in sets if is_speed_set(s.get("set_name", ""))), key=lambda s: (s.get("tcg_date") or "9999", s["set_name"]))


def compact(c: dict) -> dict:
    out = {"id": c["id"], "name": c["name"], "type": c.get("type", ""), "frame": c.get("frameType", ""), "desc": c.get("desc", "")}
    for k in ("atk", "def", "level", "race", "attribute", "linkval"):
        if c.get(k) is not None:
            out[k] = c[k]
    if c.get("type") == "Skill Card":
        out["character"] = c.get("race", "")  # the API keeps the Skill's character in "race"
        out.pop("race", None)
    return out


def speed_sets(cards: list[dict], products: list[dict] = (), extra: list[dict] = ()) -> list[dict]:
    """Every real Speed Duel product and the cards printed in it, with their rarity, oldest first."""
    dates = {}
    try:
        for st in json.loads(get(SETS_API)):
            dates[st.get("set_name", "")] = st.get("tcg_date") or ""
    except Exception as e:  # noqa: BLE001
        print(f"  no set dates: {e}", file=sys.stderr)
    sets: dict[str, dict] = {}
    for c in cards:
        for p in c.get("card_sets") or []:
            name = p.get("set_name", "")
            if "Speed Duel" not in name:
                continue
            st = sets.setdefault(name, {"name": name, "code": (p.get("set_code") or "").split("-")[0], "date": dates.get(name, ""), "cards": {}})
            rarity = p.get("set_rarity", "Common")
            prev = st["cards"].get(c["name"])
            # A card printed twice in one set keeps its lower rarity.
            if prev is None or RARITY_ORDER.get(rarity, 9) < RARITY_ORDER.get(prev, 9):
                st["cards"][c["name"]] = rarity
    # Products YGOPRODeck has no set list for (2024 onward): Konami's list, rarities from the product file.
    codes = {st["code"] for st in sets.values()}
    for p in products:
        if p["code"] in codes:
            continue
        rar = p.get("rarity", {})
        st = sets.setdefault(p["name"], {"name": p["name"], "code": p["code"], "date": p["date"], "cards": {}})
        for raw in p["cards"]:
            nm = ALIASES.get(raw, raw)
            st["cards"][nm] = rar.get(raw, "Common")
        for s in extra:
            if p["code"] in s.get("sets", []):
                st["cards"][s["name"] + " (Skill Card)"] = "Common"
    out = []
    for st in sets.values():
        st["cards"] = sorted(st["cards"].items())
        out.append(st)
    out.sort(key=lambda st: (st["date"] or "9999", st["name"]))
    return out


RARITY_ORDER = {"Common": 0, "Rare": 1, "Super Rare": 2, "Ultra Rare": 3, "Secret Rare": 4}


def main() -> int:
    products = json.loads(PRODUCTS.read_text())["products"]
    skills = api("type=Skill%20Card")
    print(f"{len(skills)} Skills, {len(products)} Konami products")
    cards = {c["id"]: c for c in skills}
    set_report = []
    in_set: dict[int, list[str]] = {}
    # 1. YGOPRODeck's Speed Duel set lists (they carry rarities, promos and demo decks).
    for st in set_list():
        name = st["set_name"]
        try:
            members = api("cardset=" + urllib.parse.quote(name))
        except Exception as e:  # noqa: BLE001
            print(f"  could not list {name}: {e}", file=sys.stderr)
            members = []
        for c in members:
            cards.setdefault(c["id"], c)
            in_set.setdefault(c["id"], []).append(st.get("set_code") or name)
        set_report.append({"name": name, "code": st.get("set_code"), "date": st.get("tcg_date"), "cards": len(members), "source": "YGOPRODeck"})
        print(f"  {name} ({st.get('set_code')}, {st.get('tcg_date')}): {len(members)} cards")
        time.sleep(DELAY)
    # 2. Konami's product lists: every card in them, looked up by name when YGOPRODeck's sets miss it.
    by_name = {c["name"]: c for c in cards.values()}
    missing = []
    for p in products:
        added = []
        for raw in p["cards"]:
            nm = ALIASES.get(raw, raw)
            c = by_name.get(nm)
            if c is None:
                try:
                    hit = api("name=" + urllib.parse.quote(nm))
                except Exception as e:  # noqa: BLE001
                    print(f"  no card data for {nm}: {e}", file=sys.stderr)
                    hit = []
                time.sleep(DELAY)
                if not hit:
                    missing.append(nm)
                    continue
                c = hit[0]
                cards[c["id"]] = c
                by_name[nm] = c
                added.append(nm)
            codes = in_set.setdefault(c["id"], [])
            if p["code"] not in codes:
                codes.append(p["code"])
        set_report.append({"name": p["name"], "code": p["code"], "date": p["date"], "cards": len(p["cards"]), "source": "Konami", "addedBySet": added})
    for nm in TOKENS:
        for c in api("name=" + urllib.parse.quote(nm)):
            cards.setdefault(c["id"], c)
    if missing:
        print(f"Konami cards YGOPRODeck has no data for: {missing}", file=sys.stderr)
    prev = json.loads(OUT.read_text()) if OUT.exists() else []
    konami = {ALIASES.get(n, n) for p in products for n in p["cards"]}
    got = {c["name"] for c in cards.values()}
    if len(konami - got) > 5:
        print(f"{len(konami - got)} Konami cards missing from the fetch: keeping the old list.", file=sys.stderr)
        return 0
    REPORT_OUT.write_text(json.dumps(set_report, ensure_ascii=False, indent=1))
    # Only Konami's cards (and Skills, and the Tokens above) make the pool: a card YGOPRODeck lists
    # in a Speed Duel set by mistake never gets in.
    konami_low = {n.lower() for n in konami}
    tokens = set(TOKENS)
    dropped = sorted(c["name"] for c in cards.values() if c.get("type") != "Skill Card" and c["name"] not in tokens and c["name"].lower() not in konami_low)
    if dropped:
        print(f"Left out (in a YGOPRODeck Speed Duel set but not in Konami's lists): {dropped}", file=sys.stderr)
    cards = {cid: c for cid, c in cards.items() if c.get("type") == "Skill Card" or c["name"] in tokens or c["name"].lower() in konami_low}
    # Skills keep the name they already have in the game (saves and scripts use it).
    prev_names = {c["id"]: c["name"] for c in prev if c.get("type") == "Skill Card"}
    out, fetched = [], 0
    for cid, c in cards.items():
        entry = compact(c)
        if cid in prev_names:
            entry["name"] = prev_names[cid]
        target = IMG_DIR / f"{cid}.webp"
        if not target.exists():
            try:
                img = Image.open(io.BytesIO(get(IMG.format(id=cid)))).convert("RGB")
                img.resize((IMG_WIDTH, round(img.height * IMG_WIDTH / img.width)), Image.LANCZOS).save(target, "WEBP", quality=IMG_QUALITY, method=6)
                fetched += 1
                time.sleep(DELAY)
            except Exception as e:  # noqa: BLE001
                print(f"  no image for {cid} {c['name']}: {e}", file=sys.stderr)
        entry["img"] = target.exists()
        if cid in in_set:
            entry["sets"] = sorted(set(in_set[cid]))
        out.append(entry)
    # The newer Skills YGOPRODeck lacks. If it adds one later (any spelling), its entry takes the
    # name the game's script uses instead of becoming a second copy.
    extra = json.loads(EXTRA_SKILLS.read_text()) if EXTRA_SKILLS.exists() else []
    key = lambda n: "".join(ch for ch in n.lower().replace(" (skill card)", "") if ch.isalnum())
    have = {key(c["name"]): c for c in out if c.get("type") == "Skill Card"}
    for s in extra:
        hit = have.get(key(s["name"]))
        if hit:
            hit["name"] = s["name"]
            hit["sets"] = sorted(set(hit.get("sets", [])) | set(s.get("sets", [])))
        else:
            out.append(s)
    out.sort(key=lambda c: c["name"])
    sets = speed_sets(list(cards.values()), products, extra)
    if sets:
        SETS_OUT.write_text(json.dumps(sets, ensure_ascii=False, separators=(",", ":")))
        print(f"wrote {len(sets)} Speed Duel sets")
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {len(out)} entries, {fetched} new images")
    return 0


if __name__ == "__main__":
    sys.exit(main())
