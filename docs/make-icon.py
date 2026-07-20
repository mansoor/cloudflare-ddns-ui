from PIL import Image, ImageDraw

S = 2048            # draw big, downsample for antialiasing
R = S // 5          # corner radius
ORANGE_TOP = (246, 130, 31)
ORANGE_BOT = (214, 99, 12)
WHITE = (255, 255, 255)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# --- background: vertical gradient inside a rounded square -------------------
grad = Image.new("RGBA", (S, S))
gd = ImageDraw.Draw(grad)
for y in range(S):
    t = y / (S - 1)
    gd.line([(0, y), (S, y)], fill=tuple(
        int(a + (b - a) * t) for a, b in zip(ORANGE_TOP, ORANGE_BOT)
    ) + (255,))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=R, fill=255)
img.paste(grad, (0, 0), mask)

# --- cloud -------------------------------------------------------------------
# union of circles + a flat base, in white
def circle(cx, cy, r, fill):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)

CY = int(S * 0.46)
circle(int(S * 0.36), CY + int(S * 0.03), int(S * 0.135), WHITE)   # left puff
circle(int(S * 0.52), CY - int(S 	* 0.04), int(S * 0.175), WHITE)  # top puff
circle(int(S * 0.68), CY + int(S * 0.02), int(S * 0.125), WHITE)   # right puff
d.rounded_rectangle(
    [int(S * 0.24), CY + int(S * 0.015), int(S * 0.76), CY + int(S * 0.165)],
    radius=int(S * 0.075), fill=WHITE,
)

# --- "+" badge, bottom-right -------------------------------------------------
BX, BY, BR = int(S * 0.70), int(S * 0.685), int(S * 0.155)
# knock a gap out of the cloud so the badge reads as separate
circle(BX, BY, BR + int(S * 0.028), (0, 0, 0, 0))
grad_patch = grad.crop((BX - BR - 80, BY - BR - 80, BX + BR + 80, BY + BR + 80))
gap = Image.new("L", grad_patch.size, 0)
ImageDraw.Draw(gap).ellipse([0, 0, grad_patch.size[0] - 1, grad_patch.size[1] - 1], fill=255)
img.paste(grad_patch, (BX - BR - 80, BY - BR - 80), gap)
circle(BX, BY, BR, WHITE)
arm, th = int(BR * 0.54), int(BR * 0.185)
rad = int(th * 0.30)
d.rounded_rectangle([BX - arm, BY - th, BX + arm, BY + th], radius=rad, fill=ORANGE_TOP)
d.rounded_rectangle([BX - th, BY - arm, BX + th, BY + arm], radius=rad, fill=ORANGE_TOP)

for size in (512, 256, 128):
    out = img.resize((size, size), Image.LANCZOS)
    name = "docs/icon.png" if size == 512 else f"docs/icon-{size}.png"
    out.save(name)
    print("wrote", name, out.size)
