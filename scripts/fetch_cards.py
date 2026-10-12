#!/usr/bin/env python3
"""
Builds the card database the game ships with.

- Pulls every Speed Duel card and every Skill Card from the YGOPRODeck API.
- Downloads each card image ONCE (the API asks apps to re-host images rather
  than hotlink them) and stores a small WebP under public/cards/img/<id>.webp.
- Writes public/cards/cards.json (compact fields only) and public/cards/meta.json.
- scripts/card-overrides.json can add or remove passcodes when the API lags a set.

Runs in GitHub Actions (see .github/workflows/cards.yml). Safe to re-run:
existing images are kept, so a re-run only fetches what is new.
"""
import io
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

from PIL import Image

API = "https://db.ygoprodeck.com/api/v7/cardinfo.php"
IMG = "https://images.ygoprodeck.com/images/cards/{id}.jpg"
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "cards"
IMG_DIR = OUT_DIR / "img"
OVERRIDES = ROOT / "scripts" / "card-overrides.json"
IMG_WIDTH = 300
IMG_QUALITY = 72
DELAY = 0.2  # seconds between image downloads (API limit is 20 requests/s)
UA = "speed-duel-online card snapshot (github actions)"


def get(url: str, retries: int = 4) -> bytes:
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            wait = 2 ** attempt
            print(f"  retry {attempt + 1} for {url}: {e} (waiting {wait}s)", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"failed to fetch {url}")


def api(query: str) -> list[dict]:
    data = json.loads(get(f"{API}?{query}"))
    return data.get("data", [])


def compact(c: dict) -> dict:
    out = {
        "id": c["id"],
        "name": c["name"],
        "type": c.get("type", ""),
        "frame": c.get("frameType", ""),
        "desc": c.get("desc", ""),
    }
    for k in ("atk", "def", "level", "race", "attribute"):
        if c.get(k) is not None:
            out[k] = c[k]
    if c.get("type") == "Skill Card":
        # The API stores the Skill's character in the "race" field.
        out["character"] = c.get("race", "")
        out.pop("race", None)
    return out


def main() -> int:
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    print("Fetching Speed Duel cards…")
    speed = api("format=speed%20duel")
    print(f"  {len(speed)} cards")
    print("Fetching Skill Cards…")
    skills = api("type=Skill%20Card")
    print(f"  {len(skills)} skills")

    cards: dict[int, dict] = {}
    for c in speed + skills:
        cards[c["id"]] = c

    overrides = {"add": [], "remove": []}
    if OVERRIDES.exists():
        overrides.update(json.loads(OVERRIDES.read_text()))
    for cid in overrides.get("add", []):
        if cid not in cards:
            found = api(f"id={cid}")
            if found:
                cards[found[0]["id"]] = found[0]
                print(f"  override added {found[0]['name']}")
    for cid in overrides.get("remove", []):
        if cards.pop(cid, None) is not None:
            print(f"  override removed {cid}")

    out = []
    fetched = 0
    for cid in sorted(cards):
        c = cards[cid]
        entry = compact(c)
        target = IMG_DIR / f"{cid}.webp"
        if not target.exists():
            try:
                raw = get(IMG.format(id=cid))
                img = Image.open(io.BytesIO(raw)).convert("RGB")
                h = round(img.height * IMG_WIDTH / img.width)
                img = img.resize((IMG_WIDTH, h), Image.LANCZOS)
                img.save(target, "WEBP", quality=IMG_QUALITY, method=6)
                fetched += 1
                time.sleep(DELAY)
            except Exception as e:  # noqa: BLE001
                print(f"  no image for {cid} {c['name']}: {e}", file=sys.stderr)
        entry["img"] = target.exists()
        out.append(entry)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "cards.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    prev = {}
    meta_path = OUT_DIR / "meta.json"
    if meta_path.exists():
        prev = json.loads(meta_path.read_text())
    meta = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "cards": len(speed),
        "skills": len(skills),
        "total": len(out),
        "imagesFetchedThisRun": fetched,
        "previousTotal": prev.get("total"),
    }
    meta_path.write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta, indent=2))
    if prev.get("total") and len(out) < prev["total"] * 0.95:
        print("WARNING: card count dropped by more than 5% since the last run", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
