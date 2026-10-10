# Generated image fixtures

All six fixtures use a synthetic 32 by 24 RGB pattern; no external image is used.
Pixel (x, y) is ((17*x) mod 256, (23*y) mod 256, (13*(x+y)) mod 256).
JPEG quality is 80, including baseline, progressive and grayscale variants.
WebP includes quality 80 lossy and lossless variants.
These positive fixtures are encoded images. Deliberately malformed marker
mutations in image-bounds.test.ts test only the pre-decoder resource guard,
not native/browser decoder behavior. Generation script is in the handoff.

`loopback.png` is a separate synthetic 128 by 128 RGB image used by the
loopback HTTP integration test. It contains no external artwork or model output.
The test transfers the actual encoded file rather than a header-only PNG.
