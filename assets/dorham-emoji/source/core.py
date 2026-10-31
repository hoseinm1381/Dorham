"""Shared geometry helpers and design tokens for the DorHam (دور هم) Soft Bubble icon system."""
import math

# ── Brand palette ──────────────────────────────────────────────
PALETTE = {
    "brand": {
        "coral": {"value": "#FF7A6B", "role": "Primary brand"},
        "coral-deep": {"value": "#E8584A", "role": "Primary pressed / on-light text"},
        "lilac": {"value": "#A78BFA", "role": "Secondary"},
        "butter": {"value": "#FFD45C", "role": "Accent / emoji base"},
        "seafoam": {"value": "#5ED6B4", "role": "Accent"},
        "sky": {"value": "#7CD4FF", "role": "Accent"},
    },
    "status": {
        "success": {"value": "#2FBF8F", "role": "Online / success"},
        "warning": {"value": "#FFB938", "role": "Idle / warning"},
        "error": {"value": "#F2545B", "role": "Do not disturb / error"},
        "info": {"value": "#4FB8EE", "role": "Information"},
    },
    "neutral-light": {
        "bg": {"value": "#FFFBF7", "role": "App background (light)"},
        "surface": {"value": "#F6F0EA", "role": "Panels (light)"},
        "line": {"value": "#EADFD6", "role": "Dividers (light)"},
        "icon": {"value": "#3A2E2A", "role": "Icon default (light)"},
        "muted": {"value": "#8A7D76", "role": "Icon inactive (light)"},
    },
    "neutral-dark": {
        "bg": {"value": "#1C1820", "role": "App background (dark)"},
        "surface": {"value": "#26212C", "role": "Panels (dark)"},
        "line": {"value": "#3A3342", "role": "Dividers (dark)"},
        "icon": {"value": "#F4EEEA", "role": "Icon default (dark)"},
        "muted": {"value": "#A79CA6", "role": "Icon inactive (dark)"},
    },
}

# ── Interface icon spec ────────────────────────────────────────
UI_GRID = 24
UI_STROKE = 2
TINT_OFFSET = 1.1
TINT_OPACITY = 0.22


def n(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def round_poly(pts, t):
    """Closed polygon with each corner softened by a quadratic curve (t = share of each edge used)."""
    d = []
    for i, p in enumerate(pts):
        a, b = pts[i - 1], pts[(i + 1) % len(pts)]
        s = (p[0] + (a[0] - p[0]) * t, p[1] + (a[1] - p[1]) * t)
        e = (p[0] + (b[0] - p[0]) * t, p[1] + (b[1] - p[1]) * t)
        d.append(f"{'M' if i == 0 else 'L'}{n(s[0])} {n(s[1])}Q{n(p[0])} {n(p[1])} {n(e[0])} {n(e[1])}")
    return "".join(d) + "Z"


def gear(teeth, ro, ri, tw, tb, t, rot=0.0, cx=12, cy=12):
    pts = []
    for i in range(teeth):
        th = rot + 2 * math.pi * i / teeth
        for ang, r in ((th - tb, ri), (th - tw, ro), (th + tw, ro), (th + tb, ri), (th + math.pi / teeth, ri)):
            pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    return round_poly(pts, t)


def star(cx, cy, ro, ri, t=0.22, points=5, rot=-math.pi / 2):
    pts = []
    for i in range(points * 2):
        r = ro if i % 2 == 0 else ri
        a = rot + math.pi * i / points
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return round_poly(pts, t)


def squircle(cx, cy, s):
    m, k = s * 0.765, s - s * 0.765
    return (f"M{n(cx)} {n(cy - s)}c{n(m)} 0 {n(s)} {n(k)} {n(s)} {n(s)}s{n(-k)} {n(s)} {n(-s)} {n(s)} "
            f"{n(-s)} {n(-k)} {n(-s)} {n(-s)} {n(k)} {n(-s)} {n(s)} {n(-s)}z")


def sparkle(cx, cy, r, k=0.2):
    q = r * k
    return (f"M{n(cx)} {n(cy - r)}Q{n(cx + q)} {n(cy - q)} {n(cx + r)} {n(cy)}Q{n(cx + q)} {n(cy + q)} {n(cx)} {n(cy + r)}"
            f"Q{n(cx - q)} {n(cy + q)} {n(cx - r)} {n(cy)}Q{n(cx - q)} {n(cy - q)} {n(cx)} {n(cy - r)}z")


def rays(cx, cy, r1, r2, count, rot=0.0):
    out = []
    for i in range(count):
        a = rot + 2 * math.pi * i / count
        out.append(f"M{n(cx + r1 * math.cos(a))} {n(cy + r1 * math.sin(a))}L{n(cx + r2 * math.cos(a))} {n(cy + r2 * math.sin(a))}")
    return "".join(out)
