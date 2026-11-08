/*
 * QR decoding off the main thread (ScanDrawer.js).
 *
 * A classic worker so it runs on every browser that has workers at all
 * (module workers need iOS 15+). It loads the vendored ZXing-C++ reader,
 * warms it up, says {ready}, then decodes one transferred RGBA frame per
 * message and answers {seq, text|null, ms}. The main thread keeps at most
 * one frame in flight per worker, so nothing ever queues up here.
 */
/* global ZXingWASM */
const BASE = new URL('../../vendor/zxing/', self.location.href).href;
// Measured on 48 blurred / curved / low-contrast cases: same reads as the
// default, ~25 % faster (ZXing's own downscaling never helped here — the
// main thread already hands over the size that reads best).
const OPTIONS = { formats: ['QRCode'], tryHarder: true, tryRotate: true, tryInvert: false, tryDownscale: false, maxNumberOfSymbols: 1 };

try {
  importScripts(BASE + 'zxing-reader.js');
  ZXingWASM.prepareZXingModule({
    overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? BASE + 'zxing_reader.wasm' : prefix + path) },
    fireImmediately: true,
  });
  ZXingWASM.readBarcodes(new ImageData(8, 8), OPTIONS)
    .then(() => self.postMessage({ ready: true }))
    .catch((error) => self.postMessage({ error: String(error && error.message || error) }));
} catch (error) {
  self.postMessage({ error: String(error && error.message || error) });
}

self.onmessage = async (event) => {
  const { seq, width, height, buffer } = event.data || {};
  if (!buffer) return;
  const started = performance.now();
  let text = null;
  try {
    const results = await ZXingWASM.readBarcodes(new ImageData(new Uint8ClampedArray(buffer), width, height), OPTIONS);
    const hit = (results || []).find((r) => r && r.isValid && r.text);
    text = hit ? hit.text : null;
  } catch {
    text = null;
  }
  self.postMessage({ seq, text, ms: performance.now() - started });
};
