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
}


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
    soft = np.clip((d - (t * lo_k - 0.03)) / 0.08, 0, 1)
    inner = ndi.binary_erosion(m, iterations=3)
    # a ~2 px feather across the smoothed outline
    a = cv2.GaussianBlur(m.astype(np.float32), (0, 0), 1.0) * np.maximum(soft, inner)
    a = cv2.GaussianBlur(a, (0, 0), 0.6)
    return np.clip(a, 0, 1)


def relief_of(d, a):
    """Depth inside the subject, blended with a rounded 'pillow' so thin parts still have body."""
    inside = a > 0.5
    if inside.sum() < 10:
        return d
    lo, hi = np.percentile(d[inside], [3, 99])
    rel = np.clip((d - lo) / (hi - lo + 1e-6), 0, 1)
    dist = ndi.distance_transform_edt(inside)
    pillow = cv2.GaussianBlur(((dist / (dist.max() + 1e-6)) ** 0.6).astype(np.float32), (0, 0), 3)
    return np.clip(0.55 * rel + 0.45 * pillow, 0, 1) * (a > 0.02)


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


def usable(a):
    cov = (a > 0.5).mean()
    lab, n = ndi.label(a > 0.5)
    parts = 0
    if n:
        sizes = ndi.sum(a > 0.5, lab, range(1, n + 1))
        parts = int((sizes > sizes.max() * 0.15).sum())
    return 0.06 <= cov <= 0.88 and parts <= 3


def main():
    import onnxruntime as ort
    model = sys.argv[1]
    only = set(int(x) for x in sys.argv[sys.argv.index('--only') + 1:] if x.isdigit()) if '--only' in sys.argv else None
    cards = json.load(open(os.path.join(ROOT, 'speed.json')))
    ids = sorted({c['id'] for c in cards if 'Monster' in c.get('type', '') and c.get('img') and os.path.exists(os.path.join(ROOT, 'img', '%d.webp' % c['id']))})
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
        a = matte_of(d, art, cid=cid)
        if not usable(a):
            done.pop(cid, None)
            continue
        r = (relief_of(d, a) * 255).astype(np.uint8)
        rgba = np.dstack([r, r, r, (a * 255).astype(np.uint8)])
        Image.fromarray(rgba, 'RGBA').save(os.path.join(out, '%d.webp' % cid), 'WEBP', quality=80, alpha_quality=80, method=6)
        done[cid] = palette_of(art, a)
        if n % 100 == 0:
            print(n, len(ids), flush=True)
    json.dump({str(k): done[k] for k in sorted(done)}, open(index_path, 'w'), separators=(',', ':'))
    print('figures:', len(done), 'of', len(ids))


if __name__ == '__main__':
    main()
