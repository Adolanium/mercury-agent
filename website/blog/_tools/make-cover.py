#!/usr/bin/env python3
"""Generate an abstract cover for a Mercury Blog post.

    python3 make-cover.py <seed> <out.jpg> [--style rings|orbit|grid|aurora] [--tone dark|light]

The seed (use the post slug) picks colours and positions, so the same slug
always gives the same image and different posts look different. Output is
1600x900 JPEG, ~50-80 KB, in the site palette (teal, amber, violet).
Needs Pillow: pip install pillow
"""
import argparse
import hashlib
import random

from PIL import Image, ImageDraw, ImageFilter

W, H = 1600, 900
TEAL = (64, 170, 200)
CYAN = (125, 211, 224)
AMBER = (240, 178, 106)
VIOLET = (124, 92, 214)
DARK = (11, 14, 18)
LIGHT = (240, 238, 232)


def blob(img, xy, radius, color, alpha, blur):
    layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x, y = xy
    d.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(*color, alpha))
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('seed')
    ap.add_argument('out')
    ap.add_argument('--style', choices=['rings', 'orbit', 'grid', 'aurora'])
    ap.add_argument('--tone', choices=['dark', 'light'])
    a = ap.parse_args()

    rnd = random.Random(int(hashlib.sha256(a.seed.encode()).hexdigest(), 16))
    style = a.style or rnd.choice(['rings', 'orbit', 'grid', 'aurora'])
    tone = a.tone or rnd.choice(['dark', 'light'])
    base = DARK if tone == 'dark' else LIGHT
    line = (255, 255, 255, 34) if tone == 'dark' else (40, 50, 60, 70)
    palette = rnd.sample([TEAL, CYAN, AMBER, VIOLET], 3)

    img = Image.new('RGBA', (W, H), (*base, 255))
    for i, c in enumerate(palette):
        blob(img, (rnd.randint(200, W - 200), rnd.randint(150, H - 150)), rnd.randint(260, 460), c, 210 - i * 40, 150)

    overlay = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    cx, cy = rnd.randint(500, 1100), rnd.randint(330, 570)
    if style == 'rings':
        for r in range(90, 900, rnd.choice([54, 70, 90])):
            d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=line, width=2)
    elif style == 'orbit':
        r = rnd.randint(220, 300)
        gap = rnd.randint(140, 220)
        for dx in (-gap // 2, gap // 2):
            d.ellipse((cx + dx - r, cy - r, cx + dx + r, cy + r), outline=line, width=2)
    elif style == 'grid':
        step = rnd.choice([60, 80, 100])
        for x in range(0, W, step):
            d.line((x, 0, x, H), fill=line, width=1)
        for y in range(0, H, step):
            d.line((0, y, W, y), fill=line, width=1)
    else:  # aurora: wide arcs rising from below the frame
        ay = H + rnd.randint(150, 420)
        for r in range(520, 1500, rnd.choice([48, 64])):
            d.ellipse((cx - r, ay - r, cx + r, ay + r), outline=line, width=2)

    img.alpha_composite(overlay)
    noise = Image.effect_noise((W, H), 10).convert('RGBA')
    noise.putalpha(10)
    img.alpha_composite(noise)
    img.convert('RGB').save(a.out, quality=84, optimize=True, progressive=True)
    print(f'{a.out}: {style}, {tone}')


if __name__ == '__main__':
    main()
