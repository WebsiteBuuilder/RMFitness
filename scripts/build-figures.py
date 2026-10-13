"""Builds the 3D figure maps for Speed Duel monsters (dev-only; output is committed).

For every Speed Duel monster picture in public/cards/img it crops the artwork,
estimates depth with Depth Anything V2 (small), cuts the subject out of its
background from that depth, and writes public/cards/fig/<id>.webp (256x256:
RGB = how far each point stands out, alpha = the subject) plus
public/cards/fig/index.json ({id: three main colors of the subject}).

    pip install onnxruntime numpy pillow opencv-python-headless scipy
    curl -L -o depth.onnx https://github.com/fabio-sim/Depth-Anything-ONNX/releases/download/v2.0.0/depth_anything_v2_vits_dynamic.onnx
    python3 scripts/build-figures.py depth.onnx            # all monsters
    python3 scripts/build-figures.py depth.onnx --only 46986414 89631139
    # --out <dir>: write somewhere else (to compare); --cache <dir>: keep the depth maps between runs
"""
import json, os, sys
import cv2
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'cards')
OUT = os.path.join(ROOT, 'fig')
# The artwork box inside a card picture; keep in step with ART_BOX in src/art/depth.ts.
BOX = (0.12, 0.178, 0.76, 0.525)
SIZE = 256


def crop_art(path):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    return im.crop((int(BOX[0] * w), int(BOX[1] * h), int((BOX[0] + BOX[2]) * w), int((BOX[1] + BOX[3]) * h)))


def depth_of(sess, im, size=392):
    x = np.asarray(im.resize((size, size), Image.BICUBIC), np.float32) / 255.0
    x = ((x - np.array([0.485, 0.456, 0.406])) / np.array([0.229, 0.224, 0.225])).transpose(2, 0, 1)[None].astype(np.float32)
    d = np.squeeze(sess.run(None, {sess.get_inputs()[0].name: x})[0]).astype(np.float32)
    d = (d - d.min()) / (d.max() - d.min() + 1e-6)
    return cv2.resize(d, (SIZE, SIZE), interpolation=cv2.INTER_LINEAR)


def otsu(a):
    t, _ = cv2.threshold((a * 255).astype(np.uint8), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return t / 255.0


def border_colors(art):
    """The art's background as seen at its border: Lab image and each pixel's distance to the nearest border color."""
    lab = cv2.cvtColor(np.asarray(art.resize((SIZE, SIZE), Image.BILINEAR)), cv2.COLOR_RGB2LAB).astype(np.float32)
    lab = cv2.GaussianBlur(lab, (0, 0), 1.5)
    ring = np.zeros((SIZE, SIZE), bool)
    k = 4
    ring[:k], ring[-k:], ring[:, :k], ring[:, -k:] = True, True, True, True
    px = lab[ring].reshape(-1, 3)
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
    _, _, cen = cv2.kmeans(px, 8, None, crit, 2, cv2.KMEANS_PP_CENTERS)
    return np.min(np.linalg.norm(lab[:, :, None, :] - cen[None, None], axis=3), axis=2)


# Per-card depth thresholds (0..1 of the normalized depth) where Otsu's split misreads the
# subject: Blue-Eyes' coiled body sits behind its head, the Harpie Ladies' wings and sisters
# stand at mid depth. Ids from public/cards/speed.json.
THRESHOLDS = {
    89631139: 0.4,   # Blue-Eyes White Dragon
    23995346: 0.4,   # Blue-Eyes Ultimate Dragon
    91932350: 0.5,   # Harpie Lady 1
    12206212: 0.5,   # Harpie Lady Sisters
    89558090: 0.6,   # Dark Prisoner: the chains behind him stay out
    17286057: 0.5,   # Helios Trice Megistus: three mummies and their three suns
}

# Pictures whose depth cannot cut a subject (an abstract burst, a painted card, a figure
# inside a wall of fire that the model reads as far away): the figure is a shape cut from
# the art instead ('disc': a soft-edged round medallion; 'panel': the picture as a standee
# with rounded corners), with a mostly rounded relief.
SHAPE_CARD = {
    3806388: 'disc',    # Core of Chaos
    81752019: 'panel',  # Flower Cardian Pine
    52860176: 'disc',   # Possessed Dark Soul
}

# Subjects made of many parts on purpose (the parts check would drop them).
PARTS_CARD = {
    17286057: 6,  # Helios Trice Megistus
}

# Speed Duel monsters the card list files under their classic entry (cards.json, not speed.json).
EXTRA_IDS = {
    83011277,  # Mystic Tomato
}


# Enclosed background holes filled after the cut, per card (smallest hole filled, as a fraction
# of the art). A big window through a coiled subject (the space inside Blue-Eyes' neck) turns the
# figure into a C-shaped cutout; filled, the painted background inside the coil reads as part of
# the dragon. Not a global rule: on ~30 other cards the 2-9 % holes are the gaps between legs,
# arms or wings, and filling those makes a slab of background.
FILL_HOLES_CARD = {
    89631139: 0.02,   # Blue-Eyes White Dragon: inside the coiled neck
    70781052: 0.004,  # Summoned Skull: the notch beside its head
    95231062: 0.02,   # Lost Blue Breaker: coiled body
    96005454: 0.02,   # Hunter Dragon: curled neck and tail
    3657444: 0.02,    # Cyber Valley: coiled body
    23893227: 0.02,   # Cyber Dragon Core: coiled tail
}
# Relief per card: (weight of the depth guess against the rounded pillow, blur of the depth in px).
# Where the depth guess steps hard inside the subject (Dark Magician Girl: her hat brim stands
# far in front of her face and hair), the displaced mesh tears into a sheared slab across the
# face with jagged strands; a softer, mostly pillow-shaped relief keeps the bust whole.
RELIEF_CARD = {
    38033121: (0.2, 6.0),   # Dark Magician Girl: hat brim vs face
    3806388: (0.15, 3.0),   # Core of Chaos (disc)
    81752019: (0.1, 3.0),   # Flower Cardian Pine (panel)
    52860176: (0.25, 3.0),  # Possessed Dark Soul (disc)
}
# Feather (px of the 256 map) where the matte meets the artwork box, so a subject cut by the
# frame fades out instead of ending in a straight edge with square corners.
BORDER_FEATHER = 10.0


def fill_big_holes(m, min_frac):
    """Fill the enclosed holes of a mask that cover at least min_frac of the map."""
    holes, n = ndi.label(ndi.binary_fill_holes(m) & ~m)
    if not n:
        return m
    sizes = ndi.sum(np.ones_like(m), holes, range(1, n + 1))
    big = [i + 1 for i, s in enumerate(sizes) if s >= SIZE * SIZE * min_frac]
    return m | np.isin(holes, big) if big else m


def border_ramp(size=SIZE, px=BORDER_FEATHER):
    """1 inside, easing to 0 over px at the map's border (corners rounded by the product)."""
    x = np.arange(size, dtype=np.float32)
    e = np.minimum(x, size - 1 - x)
    r = np.clip((e - 1.0) / px, 0, 1)
    r = r * r * (3 - 2 * r)
    return np.outer(r, r)


def smooth_mask(m):
    """Clean, smooth outline: close small gaps, blur and re-threshold (no staircase steps)."""
    m = ndi.binary_closing(m, iterations=2)
    return cv2.GaussianBlur(m.astype(np.float32), (0, 0), 1.5) > 0.5


def matte_of(d, art=None, lo_k=0.7, cid=None):
    """The subject: everything clearly in front, plus what is connected to it (hysteresis).

    With the art: parts joined to the subject that stand somewhat forward and look
    nothing like the border's colors join it too (a dragon's body behind its head),
    and enclosed gaps that look like the background stay open (the space between
    a neck and a wing) instead of being filled with a dark slab."""
    d = cv2.GaussianBlur(d, (0, 0), 1.0)
    t = THRESHOLDS.get(cid, otsu(d))
    strong, weak = d > t, d > t * lo_k
    lab, _ = ndi.label(weak)
    keep = np.unique(lab[strong])
    m = np.isin(lab, keep[keep > 0])
    dist = border_colors(art) if art is not None else None
    if dist is not None and m.any():
        base = m.mean()
        cand = ndi.binary_opening((dist > 34) & (d > t * 0.42), iterations=2)
        lab2, _ = ndi.label(cand | m)
        keep2 = np.unique(lab2[m])
        m2 = np.isin(lab2, keep2[keep2 > 0])
        if m2.mean() <= min(0.8, base * 1.6 + 0.03):
            m = m2
    lab, n = ndi.label(m)
    if n:
        sizes = ndi.sum(m, lab, range(1, n + 1))
        m = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= sizes.max() * 0.08])
    filled = ndi.binary_fill_holes(m)
    if dist is not None:
        holes, nh = ndi.label(filled & ~m)
        for i in range(1, nh + 1):
            h = holes == i
            if h.sum() <= SIZE * SIZE * 0.004 or (dist[h] < 22).mean() <= 0.6:
                continue
            # and far behind the subject (not a red panel on a red dragon): the more
            # it looks like the border, the less depth evidence it needs
            r = d[h].mean() / max(t, 1e-3)
            if r < 0.36 or (r < 0.5 and (dist[h] < 14).mean() > 0.55):
                filled &= ~h
    m = smooth_mask(ndi.binary_opening(filled, iterations=1))
    if cid in FILL_HOLES_CARD:
        m = fill_big_holes(m, FILL_HOLES_CARD[cid])
    soft = np.clip((d - (t * lo_k - 0.03)) / 0.08, 0, 1)
    inner = ndi.binary_erosion(m, iterations=3)
    # a ~2 px feather across the smoothed outline
    a = cv2.GaussianBlur(m.astype(np.float32), (0, 0), 1.0) * np.maximum(soft, inner)
    a = cv2.GaussianBlur(a, (0, 0), 0.6) * border_ramp()
    return np.clip(a, 0, 1)


def relief_of(d, a, cid=None):
    """Depth inside the subject, blended with a rounded 'pillow' so thin parts still have body."""
    inside = a > 0.5
    if inside.sum() < 10:
        return d
    lo, hi = np.percentile(d[inside], [3, 99])
    rel = np.clip((d - lo) / (hi - lo + 1e-6), 0, 1)
    dist = ndi.distance_transform_edt(inside)
    pillow = cv2.GaussianBlur(((dist / (dist.max() + 1e-6)) ** 0.6).astype(np.float32), (0, 0), 3)
    w, blur = RELIEF_CARD.get(cid, (0.55, 0.0))
    if blur > 0:
        # blurred inside the subject only (the background does not bleed into the edge)
        m = inside.astype(np.float32)
        rel = cv2.GaussianBlur(rel * m, (0, 0), blur) / np.maximum(cv2.GaussianBlur(m, (0, 0), blur), 1e-3)
    return np.clip(w * rel + (1 - w) * pillow, 0, 1) * (a > 0.02)


def palette_of(art, a):
    """Three striking colors of the subject (same idea as analyse() in src/art/depth.ts)."""
    px = np.asarray(art.resize((96, 96), Image.BILINEAR), np.int32).reshape(-1, 3)
    w = cv2.resize(a, (96, 96)).reshape(-1) > 0.5
    if w.sum() < 50:
        w[:] = True
    px = px[w]
    mx, mn = px.max(1), px.min(1)
    l = (mx + mn) / 510.0
    d = (mx - mn) / 255.0
    s = np.where(d == 0, 0, d / np.maximum(1e-6, 1 - np.abs(2 * l - 1)))
    key = ((px[:, 0] >> 4) << 8) | ((px[:, 1] >> 4) << 4) | (px[:, 2] >> 4)
    buckets = {}
    for k, (r, g, b), sc in zip(key, px, s * (1 - np.abs(l - 0.55))):
        e = buckets.setdefault(int(k), [0, 0, 0, 0, 0.0])
        e[0] += 1; e[1] += r; e[2] += g; e[3] += b; e[4] += sc
    ranked = sorted(buckets.values(), key=lambda e: -(e[4] + e[0] * 0.02))
    cols = []
    for n, r, g, b, _ in ranked:
        c = (int(r / n) << 16) | (int(g / n) << 8) | int(b / n)
        if all(abs((c >> 16) - (p >> 16)) + abs(((c >> 8) & 255) - ((p >> 8) & 255)) + abs((c & 255) - (p & 255)) > 120 for p in cols):
            cols.append(c)
        if len(cols) == 3:
            break
    while len(cols) < 3:
        cols.append(cols[0] if cols else 0xFFFFFF)
    return cols


def shape_matte(kind):
    """A matte cut as a shape: a round medallion or a rounded standee (SHAPE_CARD)."""
    y, x = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32) / (SIZE - 1) * 2 - 1
    if kind == 'disc':
        r = np.sqrt((x / 0.86) ** 2 + (y / 0.9) ** 2)
        a = np.clip((1 - r) / 0.06, 0, 1)
    else:
        q = np.maximum(np.abs(x) - 0.78, 0) ** 2 + np.maximum(np.abs(y) - 0.8, 0) ** 2
        a = np.clip((0.12 - np.sqrt(q)) / 0.04, 0, 1)
    return (a * a * (3 - 2 * a)).astype(np.float32)


def usable(a, cid=None):
    cov = (a > 0.5).mean()
    lab, n = ndi.label(a > 0.5)
    parts = 0
    if n:
        sizes = ndi.sum(a > 0.5, lab, range(1, n + 1))
        parts = int((sizes > sizes.max() * 0.15).sum())
    return 0.06 <= cov <= 0.88 and parts <= PARTS_CARD.get(cid, 3)


def main():
    import onnxruntime as ort
    model = sys.argv[1]
    only = set(int(x) for x in sys.argv[sys.argv.index('--only') + 1:] if x.isdigit()) if '--only' in sys.argv else None
    cards = json.load(open(os.path.join(ROOT, 'speed.json')))
    ids = sorted({c['id'] for c in cards if 'Monster' in c.get('type', '') and c.get('img') and os.path.exists(os.path.join(ROOT, 'img', '%d.webp' % c['id']))} | {i for i in EXTRA_IDS if os.path.exists(os.path.join(ROOT, 'img', '%d.webp' % i))})
    if only:
        ids = [i for i in ids if i in only]
    sess = ort.InferenceSession(model, providers=['CPUExecutionProvider'])
    cache = sys.argv[sys.argv.index('--cache') + 1] if '--cache' in sys.argv else None
    if cache:
        os.makedirs(cache, exist_ok=True)
    out = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else OUT
    os.makedirs(out, exist_ok=True)
    index_path = os.path.join(out, 'index.json')
    done = {int(k): v for k, v in json.load(open(index_path)).items()} if os.path.exists(index_path) else {}
    for n, cid in enumerate(ids):
        art = crop_art(os.path.join(ROOT, 'img', '%d.webp' % cid))
        cp = os.path.join(cache, '%d.npy' % cid) if cache else None
        if cp and os.path.exists(cp):
            d = np.load(cp)
        else:
            d = depth_of(sess, art)
            if cp:
                np.save(cp, d)
        a = shape_matte(SHAPE_CARD[cid]) if cid in SHAPE_CARD else matte_of(d, art, cid=cid)
        if not usable(a, cid):
            done.pop(cid, None)
            continue
        r = (relief_of(d, a, cid) * 255).astype(np.uint8)
        rgba = np.dstack([r, r, r, (a * 255).astype(np.uint8)])
        Image.fromarray(rgba, 'RGBA').save(os.path.join(out, '%d.webp' % cid), 'WEBP', quality=80, alpha_quality=80, method=6)
        done[cid] = palette_of(art, a)
        if n % 100 == 0:
            print(n, len(ids), flush=True)
    json.dump({str(k): done[k] for k in sorted(done)}, open(index_path, 'w'), separators=(',', ':'))
    print('figures:', len(done), 'of', len(ids))


if __name__ == '__main__':
    main()
