// Reads a picture's pixels at n×n away from the page: fetch, decode and shrink all
// happen here, so a figure's measurements never block a tap or a cinematic.
self.onmessage = async (e: MessageEvent<{ id: number; url: string; n: number }>) => {
  const { id, url, n } = e.data;
  try {
    const blob = await (await fetch(url)).blob();
    const bmp = await createImageBitmap(blob, { resizeWidth: n, resizeHeight: n, resizeQuality: 'medium' });
    const g = new OffscreenCanvas(n, n).getContext('2d', { willReadFrequently: true })!;
    g.drawImage(bmp, 0, 0);
    bmp.close();
    const px = g.getImageData(0, 0, n, n).data;
    (self as unknown as Worker).postMessage({ id, px }, [px.buffer]);
  } catch {
    (self as unknown as Worker).postMessage({ id, px: null });
  }
};
