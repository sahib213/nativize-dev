# Codex packet 04 — icon generator

## Goal
Write `icons/generate-icons.js`: a PURE Node script (zero npm deps; built-in
`zlib` only) that emits gradient PNG icons at 16, 48, and 128 px.

## Spec
- Hand-rolled minimal PNG encoder: IHDR (8-bit, color type 6 RGBA, no interlace),
  a single IDAT (`zlib.deflateSync` of filtered scanlines, filter byte 0 = none),
  IEND. Correct CRC-32 per chunk.
- Visual: rounded-square badge (corner radius ≈ 22% of size), diagonal gradient
  from violet `#7C3AED` to blue `#2563EB`, with a white "phone + up arrow" glyph
  centered (a rounded shaft + triangular arrowhead is fine). Pixels outside the
  rounded-square are fully transparent (alpha 0).
- Writes `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png`; logs each.

## Acceptance criteria
- `node icons/generate-icons.js` runs clean.
- `file icons/icon128.png` reports `PNG image data, 128 x 128, 8-bit/color RGBA`.
- Files open as valid PNGs (no corruption) and have transparent corners.
- No dependencies in `package.json` are required to run it.
