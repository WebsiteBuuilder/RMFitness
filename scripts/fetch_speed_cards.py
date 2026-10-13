#!/usr/bin/env python3
"""
Builds the Speed Duel card list for the Speed Duel game (public/cards/speed.json).

- Pulls every Speed Duel card and every Skill Card from the YGOPRODeck API.
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
IMG_DIR = ROOT / "public" / "cards" / "img"
SETS_OUT = ROOT / "public" / "cards" / "speed-sets.json"
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


def speed_sets() -> list[dict]:
    sets = json.loads(get(SETS_API))
    return sorted((s for s in sets if is_speed_set(s.get("set_name", ""))), key=lambda s: (s.get("tcg_date") or "9999", s["set_name"]))


def compact(c: dict) -> dict:
    out = {"id": c["id"], "name": c["name"], "type": c.get("type", ""), "frame": c.get("frameType", ""), "desc": c.get("desc", "")}
    for k in ("atk", "def", "level", "race", "attribute"):
        if c.get(k) is not None:
            out[k] = c[k]
    if c.get("type") == "Skill Card":
        out["character"] = c.get("race", "")  # the API keeps the Skill's character in "race"
        out.pop("race", None)
    return out


def main() -> int:
    speed = api("format=speed%20duel")
    skills = api("type=Skill%20Card")
    print(f"{len(speed)} Speed Duel cards, {len(skills)} Skills")
    cards = {c["id"]: c for c in speed + skills}
    # Every card printed in a Speed Duel product, even if the API's "speed duel" format misses it.
    set_report = []
    in_set: dict[int, list[str]] = {}
    for st in speed_sets():
        name = st["set_name"]
        try:
            members = api("cardset=" + urllib.parse.quote(name))
        except Exception as e:  # noqa: BLE001
            print(f"  could not list {name}: {e}", file=sys.stderr)
            members = []
        added = [c["name"] for c in members if c["id"] not in cards]
        for c in members:
            cards.setdefault(c["id"], c)
            in_set.setdefault(c["id"], []).append(st.get("set_code") or name)
        set_report.append({"name": name, "code": st.get("set_code"), "date": st.get("tcg_date"), "cards": len(members), "addedBySet": added})
        print(f"  {name} ({st.get('set_code')}, {st.get('tcg_date')}): {len(members)} cards, {len(added)} not in the format list")
        time.sleep(DELAY)
    SETS_OUT.write_text(json.dumps(set_report, ensure_ascii=False, indent=1))
    prev = json.loads(OUT.read_text()) if OUT.exists() else []
    if prev and len(cards) < len(prev) * 0.95:
        print(f"Card count dropped from {len(prev)} to {len(cards)}: keeping the old list.", file=sys.stderr)
        return 0
    out, fetched = [], 0
    for cid, c in cards.items():
        entry = compact(c)
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
    out.sort(key=lambda c: c["name"])
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {len(out)} entries, {fetched} new images")
    return 0


if __name__ == "__main__":
    sys.exit(main())
