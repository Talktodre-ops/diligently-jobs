# Diligently logo

The logo is the product name set in Fraunces SemiBold, with the full stop drawn
as a persimmon dot. The mark is the same "d" and dot on an aubergine tile, so
the app icon, the favicon and the wordmark all say the same thing. The dot is
the one piece of persimmon in the logo; keep it that colour on every coloured
version.

Every file here is pure vector outlines (no font needed to open them). The
letters come from Fraunces (SIL Open Font License 1.1), the same font the app
uses for headings.

## Files

| File | Use |
| --- | --- |
| `mark.svg` | App icon, avatars, anywhere square. The default. |
| `mark-light.svg` | Square icon on a dark or busy background. |
| `mark-plain.svg` | The "d." without a tile, on paper. |
| `mark-black.svg`, `mark-white.svg` | One-colour print, embossing, stamps. |
| `wordmark.svg` | The name on light backgrounds. |
| `wordmark-on-dark.svg` | The name on aubergine or other dark backgrounds. |
| `wordmark-black.svg`, `wordmark-white.svg` | One-colour versions. |
| `lockup.svg`, `lockup-on-dark.svg` | Mark and name together, for headers and decks. |
| `social.svg` | Source of `web/public/og.png`, the link preview image. |
| `maskable.svg`, `apple-touch-icon.svg` | Sources of the full-bleed app icons. |

The app's served icons live in `web/public/`: `favicon.svg`, `favicon.ico`
(16, 32 and 48 px), `apple-touch-icon.png` (180), `icon-192.png`,
`icon-512.png`, `icon-maskable-512.png`, `og.png` (1200 x 630) and
`site.webmanifest`.

## Colours

| Name | Hex | Role |
| --- | --- | --- |
| Aubergine | `#3B1C32` | Tile, wordmark on light |
| Butter | `#F6E7A6` | Letter on the tile, wordmark on dark |
| Persimmon | `#E8603C` | The dot, nothing else |
| Paper | `#FCF8EC` | The usual background |

## Rules

- Clear space: keep at least the dot's diameter times two empty around the
  wordmark, and an eighth of the tile's width around the mark.
- Smallest sizes: the wordmark 80 px wide on screen (20 mm in print); the mark
  16 px. At 32 px and below use `favicon.svg`, whose letter is drawn larger so
  it still reads.
- Do not recolour the dot, stretch, rotate, outline, add shadows, retype the
  name in another font, or put the wordmark on a background where it falls
  below 4.5:1 contrast.

## Rebuilding

The files are generated, not drawn by hand, so changes stay exact:

```sh
python3 -m venv /tmp/brand && /tmp/brand/bin/pip install fonttools brotli
/tmp/brand/bin/python docs/brand/source/extract_glyphs.py \
  web/node_modules/@fontsource/fraunces/files/fraunces-latin-600-normal.woff2 /tmp/fraunces600.json
/tmp/brand/bin/python docs/brand/source/build_logo.py /tmp/fraunces600.json docs/brand
```

The PNG icons are rendered from these SVGs in a browser at their exact pixel
sizes, and `favicon.ico` is packed from the 16, 32 and 48 px renders.
