"""Draw Courier's app icon (our own artwork): a white paper plane on a teal squircle with a warm trail.
usage: python3 -I scripts/make-icon.py src-tauri/icons/icon-source.png   (then `npx tauri icon` on the result)"""
import sys
from PIL import Image, ImageDraw, ImageFilter

S = 1024
out = sys.argv[1]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


# Background: macOS grid (824 px tile, 100 px margin), diagonal teal gradient.
grad = Image.new("RGB", (S, S))
top, bottom = (22, 160, 160), (14, 92, 122)
px = grad.load()
for y in range(S):
    for x in range(S):
        px[x, y] = lerp(top, bottom, (x + y) / (2 * S))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([100, 100, 924, 924], radius=186, fill=255)
icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
# Soft drop shadow under the tile.
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle([100, 118, 924, 942], radius=186, fill=(0, 0, 0, 70))
icon.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(18)))
tile = Image.new("RGBA", (S, S), (0, 0, 0, 0))
tile.paste(grad, (0, 0), mask)
icon.alpha_composite(tile)

d = ImageDraw.Draw(icon)
# Trail: three warm dashes curving away from the tail.
for i, (x, y, r) in enumerate([(300, 690, 26), (228, 742, 20), (172, 778, 15)]):
    d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 184, 77, 255 - i * 40))
# Plane: upper wing, lower wing, fold.
d.polygon([(232, 498), (792, 268), (470, 596)], fill=(255, 255, 255))
d.polygon([(470, 596), (792, 268), (566, 772)], fill=(214, 233, 240))
d.polygon([(470, 596), (520, 712), (566, 772), (540, 640)], fill=(160, 200, 214))
icon.save(out)
print(out)
