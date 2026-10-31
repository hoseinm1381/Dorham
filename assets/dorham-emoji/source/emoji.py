"""DorHam emoji — Soft Bubble style, 64×64 grid.

Rules: no black outlines. Every shape is outlined (3px) in a darker shade of its own fill, shaded with a
bottom-right crescent of a mid tone, and lit with a soft white highlight. Facial features are cocoa brown.
"""
from core import n, star, sparkle, round_poly, squircle

EMOJI = []
COCOA = "#5B3417"
PLUM = "#3B2370"
BLUSH = "#FF8FA3"
TONGUE = "#FF7A8A"

# (main, shade, line)
TONES = {
    "yellow": ("#FFD45C", "#FFB938", "#E9962E"),
    "orange": ("#FF8B5E", "#F2683A", "#D9502A"),
    "red": ("#FF5C7A", "#E83E5F", "#C22A4B"),
    "coral": ("#FF7A6B", "#F25A4A", "#D8443A"),
    "lilac": ("#B79CFF", "#9B7BF2", "#7C5CDB"),
    "blue": ("#7CD4FF", "#4FB8EE", "#2E95D0"),
    "green": ("#5ED6B4", "#36BE98", "#1F9C79"),
    "fire": ("#FF8B3D", "#F06A1E", "#D2501A"),
    "steel": ("#E8EDF5", "#C9D2E2", "#7D88A3"),
    "wood": ("#D9955F", "#B87444", "#8A532C"),
    "ghost": ("#F7F4FF", "#E2DAF7", "#9B7BF2"),
    "glass": ("#EEF6FF", "#D7E6F7", "#7D88A3"),
}

_ctx = {"name": "", "i": 0}


def _uid():
    _ctx["i"] += 1
    return f"dh-{_ctx['name']}-{_ctx['i']}"


class Emoji:
    def __init__(self, name, cat, tags, body):
        self.name, self.cat, self.tags, self.body = name, cat, tags, body


def E(name, cat, tags, build):
    _ctx["name"], _ctx["i"] = name, 0
    EMOJI.append(Emoji(name, cat, tags.split(), build()))


def svg(body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" stroke-linecap="round" stroke-linejoin="round">{body}</svg>'


# ── primitives ─────────────────────────────────────────────────
def rect_d(x, y, w, h, r):
    return (f"M{n(x + r)} {n(y)}h{n(w - 2 * r)}a{n(r)} {n(r)} 0 0 1 {n(r)} {n(r)}v{n(h - 2 * r)}a{n(r)} {n(r)} 0 0 1 {n(-r)} {n(r)}"
            f"h{n(-(w - 2 * r))}a{n(r)} {n(r)} 0 0 1 {n(-r)} {n(-r)}v{n(-(h - 2 * r))}a{n(r)} {n(r)} 0 0 1 {n(r)} {n(-r)}z")


def circle_d(cx, cy, r):
    return f"M{n(cx - r)} {n(cy)}a{n(r)} {n(r)} 0 1 0 {n(2 * r)} 0a{n(r)} {n(r)} 0 1 0 {n(-2 * r)} 0z"


def st(d, w=3, col=COCOA, extra=""):
    return f'<path d="{d}" fill="none" stroke="{col}" stroke-width="{n(w)}"{extra}/>'


def fl(d, col, extra=""):
    return f'<path d="{d}" fill="{col}"{extra}/>'


def ell(cx, cy, rx, ry, col, extra=""):
    return f'<ellipse cx="{n(cx)}" cy="{n(cy)}" rx="{n(rx)}" ry="{n(ry)}" fill="{col}"{extra}/>'


def circ(cx, cy, r, col, stroke=None, sw=2):
    s = f' stroke="{stroke}" stroke-width="{n(sw)}"' if stroke else ""
    return f'<circle cx="{n(cx)}" cy="{n(cy)}" r="{n(r)}" fill="{col}"{s}/>'


def hl(cx, cy, rx, ry, rot=-30, op=.6):
    return ell(cx, cy, rx, ry, "#fff", f' transform="rotate({rot} {n(cx)} {n(cy)})" opacity="{op}"')


def obj(d, tone, sw=3, off=2.4):
    """Any closed shape in the Soft Bubble treatment: shade base, offset main fill clipped inside, tonal outline."""
    m, s, l = TONES[tone]
    uid = _uid()
    return (f'<clipPath id="{uid}"><path d="{d}"/></clipPath>'
            f'<path d="{d}" fill="{s}"/>'
            f'<g clip-path="url(#{uid})"><path d="{d}" fill="{m}" transform="translate({-off} {-off})"/></g>'
            f'<path d="{d}" fill="none" stroke="{l}" stroke-width="{sw}"/>')


def drop(x, y, fill="#8ADBFF", stroke="#3FA9E0", sw=2):
    return (f'<path d="M{n(x)} {n(y)}c-2.4 3.2-3.8 5.4-3.8 7.2a3.8 3.8 0 0 0 7.6 0c0-1.8-1.4-4-3.8-7.2z" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')


HEART = "M32 54C18 45 8 36 8 24.5 8 17 13.5 11.5 20.5 11.5c4.8 0 8.8 2.6 11.5 6.5 2.7-3.9 6.7-6.5 11.5-6.5C50.5 11.5 56 17 56 24.5 56 36 46 45 32 54z"


def heart_at(cx, cy, s, col):
    return fl(HEART, col, f' transform="translate({n(cx - 32 * s)} {n(cy - 32.75 * s)}) scale({s})"')


# ── face building blocks ───────────────────────────────────────
def face(tone="yellow", under=""):
    m, s, l = TONES[tone]
    return (f'<circle cx="32" cy="32" r="25" fill="{s}"/><circle cx="30.5" cy="30" r="23" fill="{m}"/>'
            + hl(21, 17.5, 7, 4) + circ(31, 12.2, 1.8, "#fff").replace("/>", ' opacity=".6"/>') + under +
            f'<circle cx="32" cy="32" r="25" fill="none" stroke="{l}" stroke-width="3"/>')


def eyes(y=28.5, dx=8, rx=3, ry=4.3, col=COCOA, glint=True, sx=0):
    out = ell(32 - dx + sx, y, rx, ry, col) + ell(32 + dx + sx, y, rx, ry, col)
    if glint:
        g = max(1, rx * .42)
        out += circ(32 - dx + sx + rx * .33, y - ry * .4, g, "#fff") + circ(32 + dx + sx + rx * .33, y - ry * .4, g, "#fff")
    return out


def happy_eyes(y=28.5, w=3.2):
    return st(f"M18.5 {n(y)}c2-3.8 7-3.8 9 0M36.5 {n(y)}c2-3.8 7-3.8 9 0", w)


def closed_eyes(y=29.5):
    return st(f"M19 {n(y)}c2.3 2.2 6.2 2.2 8.5 0M36.5 {n(y)}c2.3 2.2 6.2 2.2 8.5 0")


def lidded(y=28.5, sx=1.5, col=COCOA):
    return (st(f"M18.5 {n(y)}h9M36.5 {n(y)}h9", 3, col) +
            fl(f"M{n(19.5 + sx)} {n(y)}a3.4 3.4 0 0 0 6.8 0z", col) + fl(f"M{n(37.5 + sx)} {n(y)}a3.4 3.4 0 0 0 6.8 0z", col))


def blush(y=37, dx=16, rx=4.5, ry=2.8, col=BLUSH, op=.55):
    return ell(32 - dx, y, rx, ry, col, f' opacity="{op}"') + ell(32 + dx, y, rx, ry, col, f' opacity="{op}"')


def grin(dy=0, col=COCOA, tongue=TONGUE):
    g = f' transform="translate(0 {n(dy)})"' if dy else ""
    return (f'<g{g}>' + fl("M19.5 36c1 8.5 6.2 13 12.5 13s11.5-4.5 12.5-13c-4 1.4-8.2 2-12.5 2s-8.5-.6-12.5-2z", col,
                           f' stroke="{col}" stroke-width="2.5"')
            + fl("M25.5 46.3c1.8-2.6 11.2-2.6 13 0-1.9 1.6-4.2 2.6-6.5 2.6s-4.6-1-6.5-2.6z", tongue) + "</g>")


def big_laugh(col=COCOA):
    return (fl("M17 36h30c0 9-6.7 14.5-15 14.5S17 45 17 36z", col, f' stroke="{col}" stroke-width="2.5"')
            + fl("M19.5 36.6h25v2.2a1.8 1.8 0 0 1-1.8 1.8H21.3a1.8 1.8 0 0 1-1.8-1.8z", "#fff")
            + fl("M24 47.5c2-3.4 14-3.4 16 0-2.4 1.9-5.1 2.9-8 2.9s-5.6-1-8-2.9z", TONGUE))


def smile(y=39, w=16):
    h = w / 2
    return st(f"M{n(32 - h)} {n(y)}c{n(w * .26)} {n(w * .31)} {n(w * .74)} {n(w * .31)} {w} 0")


def mini_face(cx, cy, r, tone, expr):
    """Small face for group emoji, drawn directly in 64-space so outlines keep the system weight."""
    m, s, l = TONES[tone]
    k = r / 25
    ex, ey = r * .32, cy - r * .12
    out = (circ(cx, cy, r, s) + circ(cx - 1.2 * k, cy - 1.6 * k, r - 1.6 * k - 0.6, m)
           + hl(cx - r * .42, cy - r * .55, r * .26, r * .15)
           + f'<circle cx="{n(cx)}" cy="{n(cy)}" r="{n(r)}" fill="none" stroke="{l}" stroke-width="2.6"/>')
    out += ell(cx - r * .62, cy + r * .22, r * .18, r * .11, BLUSH, ' opacity=".6"') + ell(cx + r * .62, cy + r * .22, r * .18, r * .11, BLUSH, ' opacity=".6"')
    if expr == "happy":
        a = r * .34
        out += st(f"M{n(cx - ex - a / 2)} {n(ey)}c{n(a * .2)} {n(-a * .45)} {n(a * .8)} {n(-a * .45)} {n(a)} 0"
                  f"M{n(cx + ex - a / 2)} {n(ey)}c{n(a * .2)} {n(-a * .45)} {n(a * .8)} {n(-a * .45)} {n(a)} 0", 2.6)
    else:
        out += ell(cx - ex, ey, r * .11, r * .16, COCOA) + ell(cx + ex, ey, r * .11, r * .16, COCOA)
    mw, my = r * .62, cy + r * .3
    if expr in ("grin", "happy"):
        out += fl(f"M{n(cx - mw / 2)} {n(my)}h{n(mw)}c0 {n(mw * .55)} {n(-mw * .22)} {n(mw * .75)} {n(-mw / 2)} {n(mw * .75)}"
                  f"s{n(-mw / 2)} {n(-mw * .2)} {n(-mw / 2)} {n(-mw * .75)}z", COCOA, f' stroke="{COCOA}" stroke-width="2"')
        out += ell(cx, my + mw * .55, mw * .24, mw * .12, TONGUE)
    else:
        out += st(f"M{n(cx - mw / 2)} {n(my)}c{n(mw * .26)} {n(mw * .32)} {n(mw * .74)} {n(mw * .32)} {n(mw)} 0", 2.6)
    return out


def party_hat(cx, top, base, tone, w=7):
    m, s, l = TONES[tone]
    return (obj(f"M{n(cx - w)} {n(base)}L{n(cx)} {n(top)}L{n(cx + w)} {n(base)}Q{n(cx)} {n(base + 2.5)} {n(cx - w)} {n(base)}z", tone, 2.5, 1.6)
            + st(f"M{n(cx - w * .55)} {n(base - (base - top) * .3)}l{n(w * 1.1)} -2", 2, "#fff") + circ(cx, top - 1.5, 2.6, "#FFD45C", "#E9962E", 2))


def confetti(items):
    out = ""
    for kind, x, y, col, rot in items:
        if kind == "r":
            out += f'<rect x="{n(x - 1.6)}" y="{n(y - 3.2)}" width="3.2" height="6.4" rx="1.4" fill="{col}" transform="rotate({rot} {n(x)} {n(y)})"/>'
        else:
            out += circ(x, y, 2.2, col)
    return out


# ══════════════════════ EXPRESSIONS ══════════════════════
c = "expressions"
E("emoji-happy", c, "smile joy glad", lambda: face() + eyes() + blush() + smile())
E("emoji-laughing", c, "lol haha joy tears", lambda: face() + happy_eyes() + blush(37, 16.5, 4, 2.6) + grin()
  + drop(10, 29) + drop(54, 29))
E("emoji-crying", c, "sob tears wail", lambda: face() + st("M18 23l8-3.5M46 23l-8-3.5") + closed_eyes(29.5)
  + st("M20.5 32.5c-.6 5-.4 10 .8 15M43.5 32.5c.6 5 .4 10-.8 15", 4.5, "#8ADBFF")
  + fl("M23 47c0-5 4-8.5 9-8.5s9 3.5 9 8.5c0 1.2-1 2-2.2 1.6-2.2-.7-4.5-1.1-6.8-1.1s-4.6.4-6.8 1.1C24 49 23 48.2 23 47z", COCOA)
  + fl("M27.3 46.7c1.4-1.8 8-1.8 9.4 0-1.5.5-3.1.7-4.7.7s-3.2-.2-4.7-.7z", TONGUE))
E("emoji-angry", c, "mad rage furious", lambda: face("orange") + st("M18.5 22l8.5 3.8M45.5 22l-8.5 3.8")
  + eyes(31.5, 7.5, 2.8, 3.3) + blush(39, 15.5, 4.5, 2.8, "#D7263D", .3) + st("M25.5 45.5c2.5-3.2 10.5-3.2 13 0")
  + fl("M46 14.5a3.5 3.5 0 0 1 2.2-6.2 4.6 4.6 0 0 1 8.6 1.2 3.3 3.3 0 0 1-.8 6.5h-8a3.4 3.4 0 0 1-2-1.5z", "#fff", ' stroke="#D9502A" stroke-width="2"'))
E("emoji-confused", c, "huh puzzled what", lambda: face() + st("M18.5 22.5c2-1.6 5-1.9 7.5-1M37.5 24.5l7.5.6")
  + ell(24, 29, 3, 4.3, COCOA) + ell(40, 29.5, 2.4, 3.2, COCOA) + circ(25, 27.3, 1.3, "#fff") + circ(40.8, 28.3, 1, "#fff")
  + st("M23 44c2-2 4-2 6 0s4 2 6 0 4-2 6 0") + st("M50 8.5c0-2 1.5-3.5 3.5-3.5s3.5 1.4 3.5 3.3c0 2.6-3.5 2.8-3.5 5.2", 2.8, "#9B7BF2")
  + circ(53.5, 18, 1.7, "#9B7BF2"))
E("emoji-shocked", c, "surprised wow omg gasp", lambda: face() + st("M18 19c2-2.2 6-2.6 9-1.5M46 19c-2-2.2-6-2.6-9-1.5")
  + circ(24, 29, 5.6, "#fff", COCOA, 2.5) + circ(40, 29, 5.6, "#fff", COCOA, 2.5) + circ(24, 29.5, 2.6, COCOA) + circ(40, 29.5, 2.6, COCOA)
  + ell(32, 44.5, 4.5, 6, COCOA))
E("emoji-love", c, "heart eyes adore crush", lambda: face() + heart_at(23.5, 28.5, .22, "#FF5C7A") + heart_at(40.5, 28.5, .22, "#FF5C7A")
  + circ(20.8, 26, 1.2, "#fff") + circ(37.8, 26, 1.2, "#fff") + blush(38) + smile(39.5) + heart_at(54, 10, .14, "#FF5C7A"))
E("emoji-sleepy", c, "sleep tired zzz", lambda: face() + closed_eyes(30) + ell(32, 43.5, 3, 3.6, COCOA)
  + circ(40.5, 40.5, 3.4, "#CFF0FF", "#3FA9E0", 1.5) + st("M47 3.5h6l-6 7h6", 2.6, "#9B7BF2") + st("M56 13h4l-4 4.5h4", 2.2, "#9B7BF2"))
E("emoji-thinking", c, "hmm wonder ponder", lambda: face() + st("M19 23.5l7.5-.5M37 20.5c2.5-1.8 6-2 8.5-.5")
  + ell(24.5, 28, 3, 4.3, COCOA) + ell(40.5, 27, 3, 4.3, COCOA) + circ(25.7, 26, 1.3, "#fff") + circ(41.7, 25, 1.3, "#fff")
  + st("M31 43c3 .4 6-.3 8.5-1.8")
  + fl("M25.5 44V37.5a2 2 0 0 1 4 0V44", "#FFD45C", ' stroke="#E9962E" stroke-width="2.5"')
  + fl("M17 49.5c0-3 2.4-5.5 5.5-5.5h8c1.7 0 3 1.3 3 3s-1.3 3-3 3h-2.5c1.4 0 2.5 1.1 2.5 2.5S29.4 55 28 55h-5.5c-3 0-5.5-2.5-5.5-5.5z",
       "#FFD45C", ' stroke="#E9962E" stroke-width="2.5"'))
E("emoji-suspicious", c, "side eye doubt sus", lambda: face() + st("M18.5 23.5l9 1.5M45.5 23.5l-9 1.5") + lidded(28.5)
  + st("M26 43.5l11-1.5"))
E("emoji-embarrassed", c, "blush shy flustered", lambda: face() + happy_eyes(29, 3) + blush(37.5, 16, 6, 3.6, "#FF6B81", .7)
  + st("M12 37.5l2.5-2.5M16 38l2.5-2.5M45.5 38l2.5-2.5M49.5 37.5l2.5-2.5", 1.8, "#E83E5F")
  + st("M27 44c1.7-1.5 3.3-1.5 5 0s3.3 1.5 5 0") + drop(48, 8))
E("emoji-excited", c, "starstruck hype wow", lambda: face() + fl(star(24, 28.5, 6.2, 2.9, t=.25), "#FF7A6B") + fl(star(40, 28.5, 6.2, 2.9, t=.25), "#FF7A6B")
  + circ(22.6, 26.6, 1.1, "#fff") + circ(38.6, 26.6, 1.1, "#fff") + grin(1) + fl(sparkle(7, 12, 5), "#A78BFA")
  + fl(sparkle(57, 9, 4), "#5ED6B4") + fl(sparkle(58, 50, 3.5), "#FFB938"))
E("emoji-nervous", c, "anxious grimace eek", lambda: face() + st("M18 23l8-3M46 23l-8-3") + eyes(29.5, 8, 2.6, 3.6)
  + f'<rect x="22" y="40" width="20" height="8" rx="4" fill="#fff" stroke="{COCOA}" stroke-width="2.5"/>'
  + st("M22.5 44h19M27 40.5v7M32 40.5v7M37 40.5v7", 1.8) + drop(50, 10))
E("emoji-proud", c, "smug pleased confident", lambda: face() + st("M18.5 21c2.5-1.5 6-1.6 8.5-.5M45.5 21c-2.5-1.5-6-1.6-8.5-.5")
  + closed_eyes(29) + blush() + st("M24.5 40.5c3.5 3 10.5 3 14.5-1.5") + fl(sparkle(53, 11, 5), "#FFB938") + fl(sparkle(59, 21, 2.6), "#FFB938"))
E("emoji-sad", c, "unhappy down blue", lambda: face() + st("M18.5 23.5l7.5-3M45.5 23.5l-7.5-3") + eyes(30, 8, 3, 4)
  + st("M24.5 45.5c4-4 11-4 15 0") + drop(21, 35.5))
E("emoji-silly", c, "goofy tongue crazy", lambda: face() + circ(24, 28, 5.2, "#fff", COCOA, 2.5) + circ(25.4, 29.4, 2.4, COCOA)
  + st("M37 25l6.5 3.5-6.5 3.5", 3.2) + blush() + st("M22 39c5 4.5 15 4.5 20 0")
  + fl("M28.5 41.5v4.5a3.5 3.5 0 0 0 7 0v-4.5", TONGUE, f' stroke="{COCOA}" stroke-width="2.5"') + st("M32 42.5v3", 1.8, "#D9506A"))
E("emoji-wink", c, "flirt playful joke", lambda: face() + ell(24, 28.5, 3, 4.3, COCOA) + circ(25, 26.8, 1.3, "#fff")
  + st("M36.5 29.5c2-3.4 6.5-3.4 8.5 0", 3.2) + blush() + st("M23 39c4.5 5.5 13.5 5.5 18 0") + fl(sparkle(52, 19, 3.6), "#FFB938"))
E("emoji-cool", c, "sunglasses chill swag", lambda: face()
  + fl("M13.5 24h37v3c0 4.5-3.5 7.5-7.5 7.5h-4c-3.5 0-6-2.5-6.8-5.8h-.4c-.8 3.3-3.3 5.8-6.8 5.8h-4c-4 0-7.5-3-7.5-7.5z", "#2B2340")
  + st("M13.5 25l-5-1.5M50.5 25l5-1.5", 2.5, "#2B2340") + st("M18.5 28.5l3-3M23 30l4.5-4.5M37.5 28.5l3-3", 1.8, "#fff")
  + st("M25 43c4 2.5 10 2 14-1.5"))
E("emoji-tired", c, "exhausted weary drained", lambda: face() + lidded(28.5, 1) + st("M19.5 34.5c2 1.2 5.5 1.2 7.5 0M37 34.5c2 1.2 5.5 1.2 7.5 0", 2.2, "#A78BFA")
  + st("M26 45c2-1.2 4-1.2 6 0s4 1.2 6 0"))
E("emoji-disappointed", c, "let down meh sigh", lambda: face() + st("M18.5 25l7.5-2.5M45.5 25l-7.5-2.5")
  + st("M19 30.5c2.3 1.8 6.2 1.8 8.5 0M36.5 30.5c2.3 1.8 6.2 1.8 8.5 0") + st("M26.5 45.5c3.2-2.4 7.8-2.4 11 0"))
E("emoji-evil-grin", c, "devil mischief villain", lambda:
  fl("M14.5 17c-2.5-4-2.5-9 0-12.5 1 3.5 3.5 6 7 7.5z", "#9B7BF2", ' stroke="#7C5CDB" stroke-width="2.5"')
  + fl("M49.5 17c2.5-4 2.5-9 0-12.5-1 3.5-3.5 6-7 7.5z", "#9B7BF2", ' stroke="#7C5CDB" stroke-width="2.5"')
  + face("lilac") + st("M18 23l9 4M46 23l-9 4", 3, PLUM) + ell(24.5, 31, 2.6, 2.8, PLUM) + ell(39.5, 31, 2.6, 2.8, PLUM)
  + fl("M18 37c4 6.5 9 9.5 14 9.5s10-3 14-9.5c-4.7 1.5-9.3 2.2-14 2.2S22.7 38.5 18 37z", PLUM, f' stroke="{PLUM}" stroke-width="2"')
  + fl("M24.5 39.4l1.6 3.4 1.6-2.8zM36.3 40l1.6 2.8 1.6-3.4z", "#fff"))
E("emoji-facepalm", c, "ugh smh embarrassed", lambda: face() + st("M36.5 30c2.3 1.6 6.2 1.6 8.5 0") + st("M30 45.5h8")
  + '<g transform="rotate(-28 21 30)">' + obj(rect_d(11, 15, 19, 27, 9.5), "yellow", 2.8, 1.8)
  + st("M16.5 16.5v8M20.5 15.5v9M24.5 16.5v8", 2, "#E9962E") + "</g>")

# ══════════════════════ REACTIONS ══════════════════════
c = "reactions"
CUFF = rect_d(9, 30, 11, 23, 3)
HAND = "M20 30l8-13c1.3-2.2 3.2-4 5.5-4 2.6 0 4.2 2.3 3.7 4.9L36 24h11.5c3 0 5.2 2.8 4.5 5.7l-3.6 16.6c-.7 3.9-4 6.7-8 6.7H20z"


def thumb():
    return obj(CUFF, "blue") + obj(HAND, "yellow") + st("M41 33h8.5M40 40h7.5M39 46.5h7", 2.5, "#E9962E")


FIRE = "M32 58c-11 0-19-7.5-19-18 0-8 5-13.5 9-18 .5 4 2.5 7 5 8-1-7 2-15 10-21 0 7 4 11 8 15.5 3.5 4 6 8.5 6 15.5 0 10.5-8 18-19 18z"
E("emoji-thumbs-up", c, "like yes approve +1", lambda: thumb() + hl(30.5, 19.5, 3, 1.8, -50))
E("emoji-thumbs-down", c, "dislike no -1", lambda: f'<g transform="rotate(180 32 32)">{thumb()}</g>' + hl(25, 22, 4, 2))
E("emoji-heart", c, "love like red", lambda: obj(HEART, "red") + hl(19.5, 22, 6, 3.5, -40) + circ(28, 16.5, 1.6, "#fff"))
E("emoji-broken-heart", c, "heartbreak sad breakup", lambda: obj(HEART, "red") + st("M32 18.5l-4 9 6 5-5 8 3 7.5", 6, "#C22A4B")
  + st("M32 18.5l-4 9 6 5-5 8 3 7.5", 2.4, "#FFE3E8") + hl(19.5, 22, 6, 3.5, -40))
E("emoji-fire", c, "lit hot flame", lambda: obj(FIRE, "fire")
  + fl("M32 56c-5.5 0-9.5-3.7-9.5-9 0-4.5 3-7.5 5.5-10 .5 2.5 2 4 3.5 4.5-.5-4 1.5-8 5-10.5.3 4 2 6 3.5 8 1.5 2 2 4 2 6.5 0 5.8-4.3 10.5-10 10.5z", "#FFD45C")
  + hl(20, 32, 2.5, 4.5, 20))
E("emoji-sparkles", c, "shiny magic new clean", lambda: obj(sparkle(27, 35, 20, .18), "yellow") + obj(sparkle(49, 14, 9.5, .2), "lilac")
  + obj(sparkle(51, 47, 6.5, .2), "blue") + hl(22, 30, 2, 4, 40))


def mitt(cx, rot):
    return (f'<g transform="rotate({rot} {n(cx)} 36)">' + obj(rect_d(cx - 8.5, 16, 17, 30, 8.5), "yellow", 2.8, 2)
            + st(f"M{n(cx - 4)} 17v8M{n(cx)} 16v9M{n(cx + 4)} 17v8", 2, "#E9962E") + "</g>")


E("emoji-clap", c, "applause bravo congrats", lambda: mitt(24, -18) + mitt(40, 18)
  + st("M32 4v6M21 7l3 5M43 7l-3 5", 3, "#FFB938"))
E("emoji-party", c, "celebrate tada popper", lambda: obj("M8 57l9.5-27.5 18 18z", "lilac")
  + st("M12 45.5l7.5 7.5M15 37l13 13", 2.5, "#fff") + st("M27 29c1-6 7-7 8-13", 3, "#FF7A6B") + st("M36 38.5c6-1 8-6 14-6", 3, "#5ED6B4")
  + confetti([("r", 42.5, 13, "#FF7A6B", 25), ("c", 52, 26, "#5ED6B4", 0), ("c", 29, 10, "#FFB938", 0), ("r", 54, 44, "#A78BFA", -30),
              ("r", 22, 19, "#7CD4FF", 50), ("c", 45, 52, "#FFB938", 0), ("r", 57, 14, "#FFB938", 10)]))
E("emoji-star", c, "favorite gold rating", lambda: obj(star(32, 34, 26, 12.5, t=.2), "yellow") + hl(26, 24, 3.5, 2.2)
  + ell(27.5, 34, 1.8, 2.6, COCOA) + ell(36.5, 34, 1.8, 2.6, COCOA) + st("M29 39.5c1.8 1.6 4.2 1.6 6 0", 2.2))
E("emoji-rocket", c, "launch fast ship", lambda: obj("M20 36l-8 7v9l8-4z", "coral") + obj("M44 36l8 7v9l-8-4z", "coral")
  + obj("M25 47c0 6 3 10 7 13 4-3 7-7 7-13z", "fire") + fl("M28.5 48c0 3.5 1.5 6 3.5 8 2-2 3.5-4.5 3.5-8z", "#FFD45C")
  + obj("M32 5c8 6 12 15 12 25v14c0 2-1.5 3.5-3.5 3.5h-17c-2 0-3.5-1.5-3.5-3.5V30c0-10 4-19 12-25z", "steel")
  + circ(32, 25, 5.5, "#7CD4FF", "#7D88A3", 3) + circ(30.2, 23.4, 1.5, "#fff") + st("M21 38h22", 2.5, "#C9D2E2") + hl(26, 18, 1.8, 4, 25))
E("emoji-crown", c, "king queen royal best", lambda: obj(round_poly([(8, 22), (20, 32), (32, 12), (44, 32), (56, 22), (51, 51), (13, 51)], .15), "yellow")
  + circ(8, 19.5, 3.2, "#FFD45C", "#E9962E", 2.5) + circ(32, 9.5, 3.2, "#FFD45C", "#E9962E", 2.5) + circ(56, 19.5, 3.2, "#FFD45C", "#E9962E", 2.5)
  + st("M14 44.5h36", 2.5, "#E9962E") + circ(32, 35, 4, "#FF7A6B", "#D8443A", 2) + circ(20.5, 38.5, 2.8, "#5ED6B4", "#1F9C79", 2)
  + circ(43.5, 38.5, 2.8, "#5ED6B4", "#1F9C79", 2))
E("emoji-trophy", c, "win champion cup", lambda: st("M18 16h-5a6 6 0 0 0 0 12h6.5M46 16h5a6 6 0 0 1 0 12h-6.5", 4, "#E9962E")
  + obj("M17 9h30v13c0 9.5-6.7 17-15 17s-15-7.5-15-17z", "yellow") + obj(rect_d(28.5, 38, 7, 8, 2), "yellow")
  + obj(rect_d(18, 45, 28, 10, 3.5), "wood") + fl(star(32, 21.5, 6.5, 3, t=.2), "#FFF4C2") + hl(23, 15, 3, 2))
E("emoji-gift", c, "present surprise reward", lambda: obj(rect_d(12, 29, 40, 26, 4), "coral") + obj(rect_d(9, 20, 46, 11, 3.5), "coral")
  + obj(rect_d(28, 20, 8, 35, 1.5), "yellow", 2.5, 1.2)
  + obj("M32 20c-4-8-14-11-15-5-1 5 9 6 15 5z", "yellow", 2.5, 1.5) + obj("M32 20c4-8 14-11 15-5 1 5-9 6-15 5z", "yellow", 2.5, 1.5)
  + circ(32, 19.5, 3, "#FFD45C", "#E9962E", 2.5))
E("emoji-lightning", c, "zap power energy fast", lambda: obj(round_poly([(38, 5), (13, 37), (29, 37), (25, 59), (51, 25), (35, 25)], .1), "yellow")
  + hl(29, 22, 1.8, 6, 40))
E("emoji-checkmark", c, "done yes correct ok", lambda: obj(circle_d(32, 32, 24), "green") + st("M21 33l8 8 15-17", 7, "#fff") + hl(21, 18, 5, 3))
Q = "M22.5 22c0-6 4.3-10 9.5-10s9.5 3.8 9.5 9.3c0 4.4-2.8 6.6-6.3 8.8-2.4 1.5-3.2 3.2-3.2 6.4"
E("emoji-question", c, "what ask unknown", lambda: st(Q, 13, "#7C5CDB") + st(Q, 8, "#B79CFF") + st("M24.6 19.6c.6-1.8 1.7-3 3-3.7", 2.4, "#fff")
  + circ(32, 51, 5.5, "#B79CFF", "#7C5CDB", 2.5))
E("emoji-exclamation", c, "important alert wow", lambda: st("M32 12v25", 13, "#D8443A") + st("M32 12v25", 8, "#FF7A6B")
  + st("M30.5 14v6", 2.4, "#fff") + circ(32, 51, 5.5, "#FF7A6B", "#D8443A", 2.5))

# ══════════════════════ COMMUNITY & GAMING ══════════════════════
c = "gaming"
E("emoji-game-controller", c, "gamepad play games", lambda: obj("M18 20h28c6.5 0 11 5 12 11l2 11c.9 5-2.5 9-7 9-3 0-5.3-1.7-6.7-4.2L44 43H20l-2.3 3.8C16.3 49.3 14 51 11 51c-4.5 0-7.9-4-7-9l2-11c1-6 5.5-11 12-11z", "lilac")
  + st("M18 28v10M13 33h10", 4, "#fff") + circ(45, 28.5, 2.5, "#FF7A6B") + circ(50.5, 33.5, 2.5, "#5ED6B4") + circ(45, 38.5, 2.5, "#FFD45C")
  + circ(39.5, 33.5, 2.5, "#7CD4FF") + hl(14, 24, 3.5, 1.8, -20))
DL = "#7D88A3"
E("emoji-dice", c, "roll luck random", lambda: fl("M32 8l20 10-20 10-20-10z", "#fff", f' stroke="{DL}" stroke-width="3"')
  + fl("M12 18l20 10v24L12 42z", "#E8EDF5", f' stroke="{DL}" stroke-width="3"') + fl("M52 18 32 28v24l20-10z", "#C9D2E2", f' stroke="{DL}" stroke-width="3"')
  + circ(32, 18, 2.6, "#FF7A6B") + circ(17, 27.5, 2.4, "#FF7A6B") + circ(22, 35, 2.4, "#FF7A6B") + circ(27, 42.5, 2.4, "#FF7A6B")
  + circ(37.5, 37.5, 2.4, "#FF7A6B") + circ(46.5, 32.5, 2.4, "#FF7A6B"))
E("emoji-sword", c, "attack fight blade", lambda: '<g transform="rotate(45 32 32)">' + obj("M32 4l5 6v28h-10V10z", "steel")
  + st("M32 10v25", 1.8, "#fff") + obj(rect_d(21, 37, 22, 5.5, 2.75), "yellow", 2.5, 1.5) + obj(rect_d(28.5, 42.5, 7, 10, 2.5), "wood", 2.5, 1.5)
  + obj(circle_d(32, 56, 3.8), "yellow", 2.5, 1.2) + "</g>")
E("emoji-shield", c, "defend protect guard", lambda: obj("M32 6 52 13v15c0 13-8.5 23-20 29-11.5-6-20-16-20-29V13z", "blue")
  + fl(star(32, 29, 9.5, 4.5, t=.2), "#FFD45C", ' stroke="#E9962E" stroke-width="2"') + hl(21, 18, 2.5, 4.5, 20))
E("emoji-treasure-chest", c, "loot reward box", lambda: obj(rect_d(8, 30, 48, 24, 4), "wood")
  + obj("M8 30v-6c0-7 5-12 12-12h24c7 0 12 5 12 12v6z", "wood") + st("M20 13v40.5M44 13v40.5", 5.5, "#E9962E") + st("M20 13v40.5M44 13v40.5", 2.5, "#FFD45C")
  + obj(rect_d(26.5, 25, 11, 13, 3), "yellow", 2.5, 1.5) + ell(32, 30.5, 1.8, 2.2, COCOA) + st("M32 31.5v3", 1.8)
  + fl(sparkle(55, 8, 4.5), "#FFD45C") + fl(sparkle(8, 9, 3), "#FFD45C"))
E("emoji-gem", c, "diamond jewel rare", lambda: obj(round_poly([(20, 10), (44, 10), (56, 24), (32, 56), (8, 24)], .08), "blue")
  + st("M9 24h46M20 10.5l6 13.5 6-13.5 6 13.5 6-13.5M26 24l6 31 6-31", 2, "#2E95D0") + hl(17, 20, 2, 4, 40, .8))
E("emoji-coin", c, "money gold currency dal", lambda: obj(circle_d(32, 32, 23), "yellow")
  + '<circle cx="32" cy="32" r="16" fill="none" stroke="#E9962E" stroke-width="2.5"/>'
  + st("M27 22.5c3.5 1 7 3.5 8 7 .8 3-1 6.5-4 6.5h-6", 4, "#E9962E") + hl(21, 19, 3.5, 2) + fl(sparkle(54, 9, 4), "#FFD45C"))
E("emoji-level-up", c, "upgrade xp rank up", lambda: obj(squircle(32, 32, 24), "green") + st("M32 46V19M21 30l11-11 11 11", 6, "#fff")
  + hl(18, 17, 4, 2.4) + fl(sparkle(55, 7, 4), "#FFD45C"))
E("emoji-victory", c, "win flag gg success", lambda: st("M17 58V8", 4, "#8A532C") + obj("M19 9.5h30l-6.5 9 6.5 9H19z", "coral")
  + fl(star(30, 18.5, 5, 2.4, t=.2), "#fff") + circ(17, 7, 3.2, "#FFD45C", "#E9962E", 2) + fl(sparkle(48, 44, 6), "#FFD45C")
  + fl(sparkle(34, 52, 3.5), "#5ED6B4"))
E("emoji-defeat", c, "lose skull dead rip", lambda: obj("M32 8c-12 0-21 8.5-21 20 0 6.5 3 11.5 7.5 14.5V50c0 2 1.6 3.5 3.5 3.5h20c2 0 3.5-1.6 3.5-3.5v-7.5C50 39.5 53 34.5 53 28 53 16.5 44 8 32 8z", "ghost")
  + st("M20 26.5l7 7M27 26.5l-7 7M37 26.5l7 7M44 26.5l-7 7", 3.5, PLUM) + fl("M30.3 40l1.7-3.2 1.7 3.2z", PLUM, f' stroke="{PLUM}" stroke-width="1.5"')
  + st("M27 47v5M32 47v5M37 47v5", 2.2, "#9B7BF2") + hl(20, 18, 4, 2.2))
E("emoji-magic", c, "wand spell wizard", lambda: st("M13 52 39 26", 7, PLUM) + st("M36.5 28.5l2.5-2.5", 7, "#fff")
  + obj(star(45, 18, 11, 5.2), "yellow") + fl(sparkle(15, 16, 5.5), "#A78BFA") + fl(sparkle(55, 41, 4.5), "#5ED6B4") + fl(sparkle(27, 8, 3), "#FF7A6B"))
FLASK = "M27 11h10v9.5c7.2 2.2 12.5 8.9 12.5 16.8 0 9.7-7.8 17.7-17.5 17.7s-17.5-8-17.5-17.7c0-7.9 5.3-14.6 12.5-16.8z"
E("emoji-potion", c, "elixir mana brew", lambda: obj(FLASK, "glass")
  + fl("M15 38.5c5.5 2.5 11.5 2.5 17 0s11.5-2.5 17 0c-.6 9-7.9 16-17 16s-16.4-7-17-16z", "#B79CFF")
  + circ(26, 45, 2, "#fff") + circ(35, 48.5, 1.5, "#fff") + circ(37.5, 42, 1.2, "#fff")
  + f'<path d="{FLASK}" fill="none" stroke="#7D88A3" stroke-width="3"/>' + obj(rect_d(25.5, 5, 13, 7.5, 2.5), "wood", 2.5, 1.2) + hl(22, 32, 2, 4.5, 30, .8))
E("emoji-headset", c, "voice gaming audio mic", lambda: st("M12 38v-8a20 20 0 0 1 40 0v8", 7, "#7C5CDB") + st("M12 38v-8a20 20 0 0 1 40 0v8", 3, "#B79CFF")
  + obj(rect_d(7, 31, 13, 21, 6.5), "lilac") + obj(rect_d(44, 31, 13, 21, 6.5), "lilac") + st("M13.5 50c0 5 4 8 10 8h4", 3, PLUM)
  + circ(29.5, 58, 3, PLUM) + circ(50.5, 41.5, 2.4, "#5ED6B4"))
E("emoji-joystick", c, "arcade retro stick", lambda: obj("M10 45c0-4 10-7 22-7s22 3 22 7v5c0 4-10 7-22 7s-22-3-22-7z", "lilac")
  + st("M10 45c0 4 10 7 22 7s22-3 22-7", 2.5, "#7C5CDB") + st("M32 45V22", 5, "#7D88A3") + obj(circle_d(32, 17, 9), "red")
  + hl(28.5, 13.5, 2.6, 1.6) + obj(circle_d(18, 46.5, 2.8), "yellow", 2, 1))
E("emoji-robot", c, "bot ai machine", lambda: st("M32 18v-8", 3, "#7D88A3") + obj(circle_d(32, 8, 3.8), "coral", 2.5, 1.2)
  + obj(rect_d(6, 28, 6, 13, 3), "steel", 2.5, 1.2) + obj(rect_d(52, 28, 6, 13, 3), "steel", 2.5, 1.2) + obj(rect_d(11, 18, 42, 34, 11), "steel")
  + f'<rect x="17" y="25" width="30" height="19" rx="7" fill="#2B2340"/>' + st("M23.5 36c1.6-3 4.9-3 6.5 0M34 36c1.6-3 4.9-3 6.5 0", 3, "#5ED6B4")
  + hl(18, 21.5, 3.5, 1.5, -10))
E("emoji-ghost", c, "boo spooky afk", lambda: obj("M32 8c-11 0-19 8.5-19 19v26c0 2 2.4 3 3.8 1.6l3-3 3.6 3.6c1.1 1.1 2.9 1.1 4 0L31 51.6c.6-.6 1.5-.6 2 0l3.6 3.6c1.1 1.1 2.9 1.1 4 0l3.6-3.6 3 3c1.4 1.4 3.8.4 3.8-1.6V27c0-10.5-8-19-19-19z", "ghost")
  + ell(25, 29, 3, 4.3, PLUM) + ell(39, 29, 3, 4.3, PLUM) + circ(26, 27.3, 1.3, "#fff") + circ(40, 27.3, 1.3, "#fff")
  + ell(32, 40, 2.6, 3.2, PLUM) + ell(19.5, 36.5, 3.5, 2.2, "#B79CFF", ' opacity=".6"') + ell(44.5, 36.5, 3.5, 2.2, "#B79CFF", ' opacity=".6"')
  + hl(21, 16, 4, 2.4) + st("M6 22c2-1 3-3 3-5M58 26c-2-1-3-3-3-5", 2.5, "#B79CFF"))

# ══════════════════════ DORHAM EXCLUSIVES ══════════════════════
c = "dorham-exclusive"
E("dorham-hangout", c, "together chill couch dorham hang out", lambda: obj(rect_d(4, 30, 56, 20, 8), "wood")
  + mini_face(14.5, 33, 11, "coral", "smile") + mini_face(49.5, 33, 11, "green", "happy") + mini_face(32, 31, 12.5, "yellow", "grin")
  + obj(rect_d(3, 47, 58, 12, 6), "wood") + heart_at(32, 9.5, .13, "#FF5C7A") + heart_at(21, 14, .08, "#FF8FA3") + heart_at(43, 14, .08, "#FF8FA3"))
E("dorham-friend-joined", c, "join hype welcome arrived +1", lambda: face() + fl(star(24, 29, 6.2, 2.9, t=.25), "#FF7A6B")
  + fl(star(40, 29, 6.2, 2.9, t=.25), "#FF7A6B") + circ(22.6, 27.1, 1.1, "#fff") + circ(38.6, 27.1, 1.1, "#fff") + grin(1.5)
  + fl(sparkle(7, 13, 4.5), "#A78BFA") + fl(sparkle(8, 52, 3.2), "#FFB938")
  + obj(rect_d(38, 3, 23, 14, 7), "green", 2.5, 1.5) + st("M43.5 10h5M46 7.5v5M53 7.5l2.5-1.5v8.5", 2.6, "#fff"))
E("dorham-awkward-silence", c, "awkward quiet cringe crickets voice", lambda: face()
  + ell(21.5, 29, 2.6, 3.8, COCOA) + ell(37.5, 29, 2.6, 3.8, COCOA) + circ(21, 27.6, 1, "#fff") + circ(37, 27.6, 1, "#fff")
  + st("M18 23.5l7-1M35 22.5l7 1") + st("M26 43.5h12") + drop(49, 13)
  + obj("M10 2.5h12a5 5 0 0 1 5 5v3a5 5 0 0 1-5 5h-7l-4 3.5v-3.5h-1a5 5 0 0 1-5-5v-3a5 5 0 0 1 5-5z", "ghost", 2.5, 1.5)
  + circ(11, 9, 1.6, "#9B8FB5") + circ(16, 9, 1.6, "#9B8FB5") + circ(21, 9, 1.6, "#9B8FB5"))
E("dorham-dying-laughing", c, "rofl dead crying laughing can't breathe", lambda: '<g transform="rotate(-22 32 32)">' + face()
  + st("M18.5 24.5l7 4-7 4M45.5 24.5l-7 4 7 4", 3.2) + big_laugh() + "</g>"
  + drop(5.5, 33) + drop(57, 20) + drop(13, 47, sw=2) + st("M7 13l4 2.5M54 48l4.5 1.5M50 55l3 3", 2.6, "#FFB938"))
E("dorham-teasing", c, "tease poke banter jk", lambda: face() + st("M18.5 21.5c2.5-1.8 6-2 8.5-.8M37 24.5l8-1")
  + lidded(28.5, 2.2) + st("M24 41c4 3.5 11 3.5 15-.5") + fl("M33.5 42.5c.5 3 2.5 5 5 4.5s3-3 2-5.5", TONGUE, f' stroke="{COCOA}" stroke-width="2.2"')
  + f'<g transform="rotate(35 46 44.5)">' + obj(rect_d(45, 41, 17, 7, 3.5), "yellow", 2.5, 1.2) + "</g>"
  + st("M40.5 46.5l-2.5 1.5M41.5 50.5l-1.5 2.5", 2, "#E9962E") + fl(sparkle(10, 10, 4.5), "#A78BFA"))
E("dorham-late-night", c, "gaming night owl 3am grind", lambda: st("M8 30a24 24 0 0 1 48 0", 6, "#7C5CDB") + st("M8 30a24 24 0 0 1 48 0", 2.5, "#B79CFF")
  + face("yellow", ell(32, 52, 13, 4.5, "#BFE9FF", ' opacity=".55"'))
  + lidded(28.5, 1) + st("M19.5 34.5c2 1.2 5.5 1.2 7.5 0M37 34.5c2 1.2 5.5 1.2 7.5 0", 2.2, "#A78BFA") + ell(36, 44, 2.5, 3, COCOA)
  + obj(rect_d(2.5, 25, 9, 17, 4.5), "lilac", 2.5, 1.2) + obj(rect_d(52.5, 25, 9, 17, 4.5), "lilac", 2.5, 1.2)
  + st("M7 41.5c0 6 5 9 12 9", 2.5, PLUM) + circ(20.5, 50.5, 2.2, PLUM)
  + fl("M57.5 2.5a6 6 0 1 0 5 9.3 4.8 4.8 0 0 1-5-9.3z", "#FFD45C", ' stroke="#E9962E" stroke-width="1.6"') + fl(sparkle(6, 8, 3.5), "#FFD45C"))
E("dorham-group-celebration", c, "party squad celebrate win together", lambda: mini_face(15, 41, 11, "coral", "grin") + mini_face(49, 41, 11, "green", "happy")
  + mini_face(32, 38, 13, "yellow", "grin") + party_hat(15, 18, 31.5, "blue", 6) + party_hat(49, 18, 31.5, "lilac", 6) + party_hat(32, 9, 26.5, "coral", 7)
  + confetti([("r", 5, 12, "#FF7A6B", 20), ("c", 24, 8, "#5ED6B4", 0), ("r", 41, 6, "#FFB938", -30), ("c", 59, 12, "#A78BFA", 0),
              ("r", 4, 28, "#FFB938", 60), ("r", 60, 26, "#7CD4FF", -20)]))
E("dorham-group-hug", c, "hug love friends support", lambda: mini_face(22, 33, 14.5, "yellow", "happy") + mini_face(43, 36, 14.5, "coral", "smile")
  + st("M11 44c5 8 18 10 30 4", 6.5, "#E9962E") + st("M11 44c5 8 18 10 30 4", 3.5, "#FFD45C")
  + st("M54 46c-4 7-14 9-23 5", 6.5, "#D8443A") + st("M54 46c-4 7-14 9-23 5", 3.5, "#FF7A6B")
  + heart_at(33, 9.5, .15, "#FF5C7A") + heart_at(52, 15, .08, "#FF8FA3"))


def tea():
    glass = "M36 38h16c-.8 3-1.6 5.5-1.6 8.5s1 5.5.6 7.3c-.3 1.4-1.5 2.2-3 2.2h-6c-1.5 0-2.7-.8-3-2.2-.4-1.8.6-4.3.6-7.3S36.8 41 36 38z"
    uid = _uid()
    return (face() + closed_eyes(29) + blush(37, 16) + st("M23 41c2.5 2.2 6.5 2.2 9 0")
            + ell(44, 57, 12, 3, "#FFD45C", ' stroke="#E9962E" stroke-width="2.5"')
            + fl(glass, "#F2F8FF", ' opacity=".9"') + f'<clipPath id="{uid}"><path d="{glass}"/></clipPath>'
            + f'<rect x="34" y="43" width="20" height="14" fill="#D9772E" clip-path="url(#{uid})"/>'
            + st(glass, 2.5, "#7D88A3") + st("M38 40v4", 1.6, "#fff")
            + st("M41 34c-1.5-2 1.5-3.5 0-5.5M47 34c-1.5-2 1.5-3.5 0-5.5", 2.2, "#B7AAC9"))


E("dorham-tea-time", c, "chai tea cozy estekan break", tea)
