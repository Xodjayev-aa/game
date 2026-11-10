#!/usr/bin/env python3
"""Generate RoFrontier PWA icons without third-party dependencies.

Produces the installable PNG icons used by manifest.json. The artwork is
drawn with a tiny software rasteriser (pure stdlib: zlib + struct).

Usage:  python3 tools/make_icons.py
"""
from __future__ import annotations

import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(ROOT, "icons")

# palette
BG_TOP = (12, 22, 40)
BG_BOTTOM = (5, 10, 20)
HEX_FILL = (17, 33, 55)
HEX_EDGE = (245, 190, 74)
CYAN = (86, 220, 226)
CYAN_DIM = (43, 111, 137)
GOLD = (245, 190, 74)
WHITE = (238, 246, 255)


def lerp(a, b, t):
    return a + (b - a) * t


class Canvas:
    def __init__(self, size: int):
        self.size = size
        self.px = [[(0, 0, 0, 0) for _ in range(size)] for _ in range(size)]

    def blend(self, x: int, y: int, colour, alpha: float = 1.0):
        if x < 0 or y < 0 or x >= self.size or y >= self.size or alpha <= 0:
            return
        r, g, b = colour[:3]
        base = self.px[y][x]
        a = min(1.0, alpha)
        na = a + (base[3] / 255) * (1 - a)
        if na <= 0:
            return
        nr = (r * a + base[0] * (base[3] / 255) * (1 - a)) / na
        ng = (g * a + base[1] * (base[3] / 255) * (1 - a)) / na
        nb = (b * a + base[2] * (base[3] / 255) * (1 - a)) / na
        self.px[y][x] = (int(nr), int(ng), int(nb), int(na * 255))

    def rect(self, x0, y0, x1, y1, colour, alpha=1.0):
        for y in range(int(y0), int(y1)):
            for x in range(int(x0), int(x1)):
                self.blend(x, y, colour, alpha)

    def rounded_rect(self, x0, y0, x1, y1, radius, colour_fn):
        for y in range(int(y0), int(y1)):
            for x in range(int(x0), int(x1)):
                # distance to the rounded-rectangle corner regions
                cx = min(max(x, x0 + radius), x1 - radius)
                cy = min(max(y, y0 + radius), y1 - radius)
                d = math.hypot(x - cx, y - cy)
                if d > radius:
                    continue
                self.blend(x, y, colour_fn(x, y))

    def disc(self, cx, cy, radius, colour, alpha=1.0):
        r2 = radius * radius
        for y in range(int(cy - radius - 1), int(cy + radius + 2)):
            for x in range(int(cx - radius - 1), int(cx + radius + 2)):
                d2 = (x - cx) ** 2 + (y - cy) ** 2
                if d2 <= r2:
                    self.blend(x, y, colour, alpha * min(1.0, (r2 - d2) / max(1, radius * 2)))

    def line(self, x0, y0, x1, y1, colour, width=1.0, alpha=1.0):
        steps = int(max(abs(x1 - x0), abs(y1 - y0)) * 2) + 1
        radius = width / 2
        for i in range(steps + 1):
            t = i / steps
            x = lerp(x0, x1, t)
            y = lerp(y0, y1, t)
            for dy in range(-int(radius) - 1, int(radius) + 2):
                for dx in range(-int(radius) - 1, int(radius) + 2):
                    if dx * dx + dy * dy <= radius * radius + radius * 0.7:
                        self.blend(int(x) + dx, int(y) + dy, colour, alpha)

    def ellipse(self, cx, cy, rx, ry, colour, width=1.0, alpha=1.0):
        steps = max(180, int(rx * 6))
        pts = [
            (cx + rx * math.cos(2 * math.pi * i / steps),
             cy + ry * math.sin(2 * math.pi * i / steps))
            for i in range(steps + 1)
        ]
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            self.line(x0, y0, x1, y1, colour, width, alpha)

    def polygon(self, pts, colour, alpha=1.0):
        ys = [p[1] for p in pts]
        for y in range(int(min(ys)), int(max(ys)) + 1):
            xs = []
            for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
                if (y0 <= y < y1) or (y1 <= y < y0):
                    xs.append(x0 + (y - y0) * (x1 - x0) / (y1 - y0))
            xs.sort()
            for i in range(0, len(xs) - 1, 2):
                for x in range(int(xs[i]), int(xs[i + 1]) + 1):
                    self.blend(x, y, colour, alpha)

    def polyline(self, pts, colour, width=1.0, alpha=1.0):
        for a, b in zip(pts, pts[1:]):
            self.line(a[0], a[1], b[0], b[1], colour, width, alpha)

    def to_png(self, path: str):
        raw = bytearray()
        for row in self.px:
            raw.append(0)  # filter: none
            for r, g, b, a in row:
                raw += bytes((r, g, b, a))

        def chunk(tag, data):
            return (struct.pack(">I", len(data)) + tag + data
                    + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

        ihdr = struct.pack(">IIBBBBB", self.size, self.size, 8, 6, 0, 0, 0)
        png = (b"\x89PNG\r\n\x1a\n"
               + chunk(b"IHDR", ihdr)
               + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
               + chunk(b"IEND", b""))
        with open(path, "wb") as fh:
            fh.write(png)
        print(f"wrote {path} ({len(png)} bytes)")


# 5x7 bitmap font for the small "RF" monogram
FONT = {
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
}


def glyph(canvas, ch, x, y, scale, colour):
    for row, bits in enumerate(FONT[ch]):
        for col, bit in enumerate(bits):
            if bit == "1":
                canvas.rect(x + col * scale, y + row * scale,
                            x + (col + 1) * scale, y + (row + 1) * scale, colour)


def hex_points(cx, cy, radius):
    return [(cx + radius * math.cos(math.radians(60 * i - 30)),
             cy + radius * math.sin(math.radians(60 * i - 30))) for i in range(6)]


def render(size: int, maskable: bool = False) -> Canvas:
    c = Canvas(size)
    s = size / 512.0
    radius = size * 0.19

    def bg(x, y):
        t = y / size
        return tuple(int(lerp(BG_TOP[i], BG_BOTTOM[i], t)) for i in range(3))

    # Full bleed for maskable icons; rounded tile for regular icons.
    if maskable:
        for y in range(size):
            for x in range(size):
                c.blend(x, y, bg(x, y))
    else:
        c.rounded_rect(0, 0, size, size, radius, bg)

    cx = cy = size / 2
    # content stays inside the safe zone on maskable icons
    content = 0.70 if maskable else 1.0
    hr = size * 0.345 * content
    pts = hex_points(cx, cy - size * 0.015, hr)
    inner = [(cx + (x - cx) * 0.90, cy - size * 0.015 + (y - (cy - size * 0.015)) * 0.90)
             for x, y in pts]

    # soft glow behind the crest
    c.disc(cx, cy - size * 0.015, hr * 1.28, CYAN, 0.075)
    c.polygon(pts, HEX_FILL, 0.92)
    c.polygon(inner, (21, 42, 66), 0.55)

    # globe: latitude rings + meridians
    gx, gy = cx, cy - size * 0.075
    gr = hr * 0.62
    c.disc(gx, gy, gr, (12, 30, 49), 0.65)
    c.ellipse(gx, gy, gr, gr, CYAN_DIM, 2.6 * s, 0.95)
    for f in (0.32, 0.68):
        c.ellipse(gx, gy, gr, gr * f, CYAN_DIM, 1.8 * s, 0.85)
    c.ellipse(gx, gy, gr * 0.42, gr, CYAN_DIM, 1.8 * s, 0.85)
    c.line(gx - gr, gy, gx + gr, gy, CYAN_DIM, 1.8 * s, 0.85)

    # small territory nodes
    for a, d in ((28, 0.72), (150, 0.60), (248, 0.80), (325, 0.55)):
        ang = math.radians(a)
        nx, ny = gx + math.cos(ang) * gr * d, gy + math.sin(ang) * gr * d
        c.disc(nx, ny, 5.5 * s, CYAN)
        c.disc(nx, ny, 11 * s, CYAN, 0.20)

    # hex crest border
    c.polyline(pts + [pts[0]], HEX_EDGE, 9 * s)
    c.polyline(inner + [inner[0]], HEX_EDGE, 2 * s, 0.5)

    # "49" signature
    scale = size * 0.026 * content
    digit_w, digit_h = 5 * scale, 7 * scale
    total_w = digit_w * 2 + scale * 1.2
    start_x = cx - total_w / 2
    start_y = cy + size * 0.105
    glyph(c, "4", start_x, start_y, scale, GOLD)
    glyph(c, "9", start_x + digit_w + scale * 1.2, start_y, scale, GOLD)
    c.rect(start_x - scale, start_y + digit_h + scale * 1.4,
           start_x + total_w + scale, start_y + digit_h + scale * 2.0, CYAN, 0.8)

    # monogram above the globe
    mono_scale = size * 0.019 * content
    glyph(c, "R", cx - 6.2 * mono_scale, cy - size * 0.33, mono_scale, WHITE)
    glyph(c, "F", cx + 0.4 * mono_scale, cy - size * 0.33, mono_scale, CYAN)

    # corner accents
    for sx, sy in ((0.12, 0.12), (0.88, 0.12), (0.12, 0.88), (0.88, 0.88)):
        c.disc(sx * size, sy * size, 4 * s, HEX_EDGE, 0.55)
    return c


def main():
    os.makedirs(ICON_DIR, exist_ok=True)
    for size in (192, 512):
        render(size).to_png(os.path.join(ICON_DIR, f"icon-{size}.png"))
    render(512, maskable=True).to_png(os.path.join(ICON_DIR, "icon-maskable-512.png"))
    # 180px iOS touch icon
    render(180).to_png(os.path.join(ICON_DIR, "apple-touch-icon.png"))


if __name__ == "__main__":
    main()
