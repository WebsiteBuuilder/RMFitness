#!/usr/bin/env python3
"""
Builds the card database for the Eternal Duelist Soul remake.

- Reads src/eds/data/eds-cards.json (the 819-card list with numbers and passwords).
- Looks each card up in the YGOPRODeck API by name (exact, then fuzzy, then the
  manual map in scripts/card-overrides.json) to get type, stats and text.
- Downloads each card image ONCE (the API asks apps to re-host) as a small WebP.
- Writes public/cards/cards.json and public/cards/meta.json (including any names
  that could not be matched, so they can be added to the overrides file).

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
IMG = "https://images.ygoprodeck.com/images/cards/{id}.jpg"
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "eds" / "data" / "eds-cards.json"
OUT_DIR = ROOT / "public" / "cards"
IMG_DIR = OUT_DIR / "img"
OVERRIDES = ROOT / "scripts" / "card-overrides.json"
IMG_WIDTH = 300
IMG_QUALITY = 72
DELAY = 0.15
UA = "eternal-duelist-soul-remake card snapshot (github actions)"


def get(url: str, retries: int = 4) -> bytes | None:
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:  # type: ignore[attr-defined]
            if e.code == 400:
                return None  # no such card
            wait = 2**attempt
            print(f"  retry {attempt + 1} for {url}: {e} (waiting {wait}s)", file=sys.stderr)
            time.sleep(wait)
        except Exception as e:  # noqa: BLE001
            wait = 2**attempt
            print(f"  retry {attempt + 1} for {url}: {e} (waiting {wait}s)", file=sys.stderr)
            time.sleep(wait)
    return None


def api(params: dict) -> list[dict]:
    raw = get(f"{API}?{urllib.parse.urlencode(params)}")
    if not raw:
        return []
    try:
        return json.loads(raw).get("data", [])
    except json.JSONDecodeError:
        return []


def norm(s: str) -> str:
    return " ".join(s.lower().replace("’", "'").split())


def compact(c: dict, entry: dict) -> dict:
    out = {
        "id": c["id"],
        "name": c["name"],
        "type": c.get("type", ""),
        "frame": c.get("frameType", ""),
        "desc": c.get("desc", ""),
        "n": entry["n"],
        "password": entry.get("password"),
    }
    for k in ("atk", "def", "level", "race", "attribute"):
        if c.get(k) is not None:
            out[k] = c[k]
    if norm(c["name"]) != norm(entry["name"]):
        out["alias"] = entry["name"]  # keep the EDS-era name usable in decks
    return out


entry_password: dict = {}


def lookup(name: str, overrides: dict, cache: dict) -> dict | None:
    key = norm(name)
    if key in cache:
        return cache[key]
    found = None
    pw = entry_password.get(key)
    if pw and pw.isdigit():
        # The 8-digit password printed on the card is the passcode YGOPRODeck uses as its id,
        # which survives every rename (Bell of Destruction -> Ring of Destruction, etc.).
        res = api({"id": int(pw)})
        found = res[0] if res else None
    if not found and name in overrides:
        ov = overrides[name]
        found = (api({"id": ov}) if isinstance(ov, int) else api({"name": ov})) or []
        found = found[0] if found else None
    if not found:
        res = api({"name": name})
        found = res[0] if res else None
    if not found:
        res = api({"fname": name})
        exact = [c for c in res if norm(c["name"]) == key]
        found = exact[0] if exact else (res[0] if len(res) == 1 else None)
    time.sleep(0.06)
    cache[key] = found
    return found


WIKI = "https://yugipedia.com/api.php"
TICKET_TEXT = "A Ticket card from Duelist Kingdom. It is a keepsake and cannot be used in a Duel."


def wiki(params: dict) -> dict:
    raw = get(f"{WIKI}?{urllib.parse.urlencode({**params, 'format': 'json'})}")
    try:
        return json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return {}


def crop_card(im: "Image.Image") -> "Image.Image":
    """Yugipedia's EDS images are whole GBA screens; keep just the card on the left."""
    w, h = im.size
    if w <= h:
        return im
    olive = lambda p: p[0] > 120 and p[1] > 120 and p[2] < 110
    cols = [x for x in range(w // 2) if sum(olive(im.getpixel((x, y))) for y in range(h)) > h // 5]
    rows = [y for y in range(h) if sum(olive(im.getpixel((x, y))) for x in range(w // 2)) > w // 15]
    if not cols or not rows:
        return im
    return im.crop((max(0, cols[0] - 2), max(0, rows[0] - 2), min(w, cols[-1] + 3), min(h, rows[-1] + 3)))


def ticket_card(entry: dict) -> tuple[dict, bytes | None]:
    """EDS-only Ticket cards are not in YGOPRODeck: take their art from yugipedia's EDS page."""
    page = f"{entry['name']} (EDS)"
    data = wiki({"action": "query", "titles": page, "prop": "images", "imlimit": "50"})
    files = []
    for p in data.get("query", {}).get("pages", {}).values():
        files += [i["title"] for i in p.get("images", [])]
    files = [f for f in files if "EDS" in f and f.lower().endswith((".png", ".jpg"))] or files
    raw = None
    if files:
        info = wiki({"action": "query", "titles": files[0], "prop": "imageinfo", "iiprop": "url"})
        for p in info.get("query", {}).get("pages", {}).values():
            for ii in p.get("imageinfo", []):
                raw = get(ii["url"])
    card = {
        "id": 99000000 + int(entry["n"]),
        "name": entry["name"],
        "type": "Ticket Card",
        "frame": "ticket",
        "desc": TICKET_TEXT,
        "n": entry["n"],
        "password": entry.get("password"),
    }
    return card, raw


def main() -> int:
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    entries = json.loads(SRC.read_text())
    overrides = json.loads(OVERRIDES.read_text()) if OVERRIDES.exists() else {}
    cards: list[dict] = []
    missing: list[str] = []
    cache: dict = {}
    seen_ids: set[int] = set()
    for entry in entries:
        if entry.get("password"):
            entry_password[norm(entry["name"])] = entry["password"]
    for i, entry in enumerate(entries):
        name = entry["name"]
        found = lookup(name, overrides, cache)
        if not found:
            card, raw = ticket_card(entry)
            path = IMG_DIR / f"{card['id']}.webp"
            if raw and not path.exists():
                try:
                    im = crop_card(Image.open(io.BytesIO(raw)).convert("RGB"))
                    h = round(im.height * IMG_WIDTH / im.width)
                    im.resize((IMG_WIDTH, h), Image.LANCZOS).save(path, "WEBP", quality=IMG_QUALITY, method=6)
                except Exception as e:  # noqa: BLE001
                    print(f"  ticket image failed for {name}: {e}", file=sys.stderr)
            if path.exists():
                card["img"] = True
                cards.append(card)
                print(f"  ticket card {name} taken from yugipedia")
                continue
            missing.append(name)
            print(f"  !! no match for {name}", file=sys.stderr)
            continue
        c = compact(found, entry)
        if found["id"] in seen_ids:
            continue  # alternate artwork entry: keep one record per card
        seen_ids.add(found["id"])
        cards.append(c)
        if (i + 1) % 50 == 0:
            print(f"  {i + 1}/{len(entries)} looked up")
    print(f"{len(cards)} cards matched, {len(missing)} missing")

    # Images
    done = 0
    for c in cards:
        if c.get("frame") == "ticket":
            continue
        path = IMG_DIR / f"{c['id']}.webp"
        if path.exists():
            c["img"] = True
            continue
        raw = get(IMG.format(id=c["id"]))
        if not raw:
            c["img"] = False
            continue
        try:
            im = Image.open(io.BytesIO(raw)).convert("RGB")
            h = round(im.height * IMG_WIDTH / im.width)
            im = im.resize((IMG_WIDTH, h), Image.LANCZOS)
            im.save(path, "WEBP", quality=IMG_QUALITY, method=6)
            c["img"] = True
            done += 1
        except Exception as e:  # noqa: BLE001
            print(f"  image failed for {c['name']}: {e}", file=sys.stderr)
            c["img"] = False
        time.sleep(DELAY)
    print(f"{done} new images")

    cards.sort(key=lambda c: c["n"])
    (OUT_DIR / "cards.json").write_text(json.dumps(cards, ensure_ascii=False, separators=(",", ":")))
    (OUT_DIR / "meta.json").write_text(
        json.dumps({"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "count": len(cards), "missing": missing, "source": "YGOPRODeck API v7 + yugipedia EDS card list"}, indent=2)
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
