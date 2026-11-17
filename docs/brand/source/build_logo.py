import json, sys, os
F = json.load(open(sys.argv[1])); OUT = sys.argv[2]
G = F["glyphs"]; K = F["kern"]
AUB, BUT, PER, PAPER, INK = "#3B1C32", "#F6E7A6", "#E8603C", "#FCF8EC", "#3B1C32"
TRACK = -40  # -0.02em at 2000 upm, same as the app's wordmark CSS
DOT_R = 178  # the period's own size, drawn as a true circle

def word(text="diligently"):
    """Glyph paths laid out in font units (y up). Returns (paths, dot_center, x_end)."""
    x = 0; parts = []
    for i, ch in enumerate(text):
        g = G[ch]
        parts.append((x, g["d"]))
        nxt = text[i+1] if i+1 < len(text) else "."
        x += g["adv"] + K.get(ch+nxt, 0) + TRACK
    pb = G["."]["bounds"]
    dot = (x + (pb[0]+pb[2])/2, (pb[1]+pb[3])/2 + 4)
    return parts, dot, x

def glyph_group(parts, fill, s, tx, ty):
    paths = "".join(f'<path transform="translate({x} 0)" d="{d}"/>' for x, d in parts)
    return f'<g transform="translate({tx:.2f} {ty:.2f}) scale({s} {-s})" fill="{fill}">{paths}</g>'

def svg(w, h, body, title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{title}">'
            f'<title>{title}</title>{body}</svg>\n')

def write(name, s):
    open(os.path.join(OUT, name), "w").write(s)

# ---- wordmark, font units -> px at 1 unit = 0.05px (2000 upm -> 100px em)
parts, dot, xend = word()
s = 0.05
left = 71; right = dot[0] + DOT_R; top = 1487; bottom = -490
pad = 0
W = (right - left) * s; H = (top - bottom) * s
def wordmark(text_fill, dot_fill, title="Diligently"):
    tx = -left * s; ty = top * s
    body = glyph_group(parts, text_fill, s, tx, ty)
    body += f'<circle cx="{tx + dot[0]*s:.2f}" cy="{ty - dot[1]*s:.2f}" r="{DOT_R*s:.2f}" fill="{dot_fill}"/>'
    return svg(round(W, 2), round(H, 2), body, title)
write("wordmark.svg", wordmark(AUB, PER))
write("wordmark-on-dark.svg", wordmark(BUT, PER))
write("wordmark-black.svg", wordmark("#000000", "#000000"))
write("wordmark-white.svg", wordmark("#FFFFFF", "#FFFFFF"))

# ---- the mark: Fraunces "d" and the full stop, on a rounded tile
d = G["d"]; db = d["bounds"]
GAP = 70
dot_cx = db[2] + GAP + DOT_R; dot_cy = DOT_R - 22  # sits on the baseline like the period
gl, gr = db[0], dot_cx + DOT_R; gt, gb = db[3], db[1]

def mark(size, content, radius, tile, letter, stop, title="Diligently", tile_stroke=None):
    s = content / (gr - gl)
    tx = size/2 - (gl + gr)/2 * s
    ty = size/2 + (gt + gb)/2 * s
    body = ""
    if tile:
        stroke = f' stroke="{tile_stroke}" stroke-width="{size/64:.2f}"' if tile_stroke else ""
        inset = size/128 if tile_stroke else 0
        body += f'<rect x="{inset:.2f}" y="{inset:.2f}" width="{size-2*inset:.2f}" height="{size-2*inset:.2f}" rx="{radius}" fill="{tile}"{stroke}/>'
    body += glyph_group([(0, d["d"])], letter, round(s, 5), tx, ty)
    body += f'<circle cx="{tx + dot_cx*s:.2f}" cy="{ty - dot_cy*s:.2f}" r="{DOT_R*s:.2f}" fill="{stop}"/>'
    return svg(size, size, body, title)

write("mark.svg", mark(512, 300, 116, AUB, BUT, PER))
write("mark-light.svg", mark(512, 300, 116, BUT, AUB, PER))
write("mark-plain.svg", mark(512, 400, 0, None, AUB, PER))
write("mark-black.svg", mark(512, 400, 0, None, "#000000", "#000000"))
write("mark-white.svg", mark(512, 400, 0, None, "#FFFFFF", "#FFFFFF"))
# small sizes get a bigger letter so it still reads at 16px
write("favicon.svg", mark(32, 24, 7, AUB, BUT, PER))
write("maskable.svg", mark(512, 250, 0, AUB, BUT, PER))  # full bleed, content inside the 80% safe zone

# ---- lockup: mark tile beside the wordmark, centred on the ascender-to-baseline band
asc_px = 1487 * s
tile = round(asc_px * 1.3)
gap = round(tile * 0.3)
band_mid = top * s - asc_px / 2          # y of the band's middle, wordmark coordinates
ty_tile = band_mid - tile / 2
y0 = min(0, ty_tile); y1 = max(H, ty_tile + tile)
lw = tile + gap + W; lh = y1 - y0
def lockup(text_fill, dot_fill, tile_fill, letter_fill, title="Diligently"):
    m = mark(tile, tile*0.586, round(tile*0.2266, 2), tile_fill, letter_fill, PER)
    inner = m[m.index('>')+1:m.rindex('</svg>')].replace(f'<title>{title}</title>', '')
    body = f'<g transform="translate(0 {ty_tile - y0:.2f})">{inner}</g>'
    tx = tile + gap - left*s; base = top*s - y0
    body += glyph_group(parts, text_fill, s, tx, base)
    body += f'<circle cx="{tx + dot[0]*s:.2f}" cy="{base - dot[1]*s:.2f}" r="{DOT_R*s:.2f}" fill="{dot_fill}"/>'
    return svg(round(lw, 2), round(lh, 2), body, title)
write("lockup.svg", lockup(AUB, PER, AUB, BUT))
write("lockup-on-dark.svg", lockup(BUT, PER, BUT, AUB))

# ---- social card 1200x630: lockup large on aubergine, one line under it
def social():
    sc = 1.6
    body = f'<rect width="1200" height="630" fill="{AUB}"/>'
    lock = lockup(BUT, PER, BUT, AUB)
    inner = lock[lock.index('>')+1:lock.rindex('</svg>')].replace('<title>Diligently</title>', '')
    x = (1200 - lw*sc)/2; y = 272 - lh*sc/2
    body += f'<g transform="translate({x:.2f} {y:.2f}) scale({sc})">{inner}</g>'
    body += ('<text x="600" y="440" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="38" '
             f'fill="{BUT}" opacity="0.92">Paste a job. Get a tailored CV, a match score and a cover letter.</text>')
    return svg(1200, 630, body, "Diligently")
write("social.svg", social())
print("wordmark", round(W,1), "x", round(H,1), "lockup", round(lw,1), "x", round(lh,1), "tile", tile)
# iOS rounds the corners itself and needs an opaque square
write("apple-touch-icon.svg", mark(180, 108, 0, AUB, BUT, PER))
