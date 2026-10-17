#!/usr/bin/env python3
"""Rasterize the Codex Remote icon as PNG.

Uses only the standard library. The icon consists of rounded rectangles and circles, whose distance
from any point has a closed-form solution. Edge coverage is therefore computed exactly (signed
distance fields plus analytic antialiasing) rather than estimated by supersampling.

After changing public/icon.svg, rerun this script to regenerate the PNGs:
    python3 tools/render-icons.py
"""

import math
import os
import struct
import zlib

BG = (0x14, 0x14, 0x13)
MARK = (0xA7, 0xF3, 0xD0)
CANVAS = 512.0
CORNER = 112.0

# These coordinates match public/icon.svg exactly; update both files when changing the icon.
BARS = [
    {"x0": 132.0, "y0": 149.0, "x1": 380.0, "y1": 195.0, "r": 23.0},
    {"x0": 132.0, "y0": 233.0, "x1": 286.0, "y1": 279.0, "r": 23.0},
    {"x0": 132.0, "y0": 317.0, "x1": 380.0, "y1": 363.0, "r": 23.0},
]
DOT = {"cx": 344.0, "cy": 256.0, "r": 27.0}


def sd_round_rect(px, py, x0, y0, x1, y1, r):
    """Signed distance to a rounded rectangle boundary, negative inside."""
    cx = min(max(px, x0 + r), x1 - r)
    cy = min(max(py, y0 + r), y1 - r)
    dx, dy = px - cx, py - cy
    outside = math.hypot(dx, dy) - r
    if x0 + r <= px <= x1 - r or y0 + r <= py <= y1 - r:
        inside = max(x0 - px, px - x1, y0 - py, py - y1)
        if inside < 0:
            return inside
    return outside


def sd_circle(px, py, cx, cy, r):
    return math.hypot(px - cx, py - cy) - r


def coverage(d, scale):
    """Analytic antialiasing: convert signed distance to pixel coverage from 0 to 1."""
    return min(max(0.5 - d * scale, 0.0), 1.0)


def render(size, rounded):
    step = CANVAS / size
    scale = 1.0 / step
    corner = CORNER if rounded else 0.0
    out = bytearray(size * size * 4)
    i = 0
    for py in range(size):
        y = (py + 0.5) * step
        for px in range(size):
            x = (px + 0.5) * step
            a_bg = coverage(sd_round_rect(x, y, 0.0, 0.0, CANVAS, CANVAS, corner), scale)
            d_mark = min(
                min(sd_round_rect(x, y, b["x0"], b["y0"], b["x1"], b["y1"], b["r"]) for b in BARS),
                sd_circle(x, y, DOT["cx"], DOT["cy"], DOT["r"]),
            )
            a_mark = coverage(d_mark, scale)
            for c in range(3):
                out[i + c] = int(round(MARK[c] * a_mark + BG[c] * (1.0 - a_mark)))
            out[i + 3] = int(round(255 * a_bg))
            i += 4
    return out


def write_png(path, size, rgba):
    raw = bytearray()
    row = size * 4
    for y in range(size):
        raw.append(0)
        raw += rgba[y * row:(y + 1) * row]

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as handle:
        handle.write(png)


TARGETS = [
    ("icon-192.png", 192, True),
    ("icon-512.png", 512, True),
    ("icon-512-maskable.png", 512, False),
]

if __name__ == "__main__":
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public")
    for name, size, rounded in TARGETS:
        path = os.path.normpath(os.path.join(root, name))
        write_png(path, size, render(size, rounded))
        print("%s  %dx%d  %d bytes" % (name, size, size, os.path.getsize(path)))
