import numpy as np, cv2, json
from scipy import ndimage as ndi
im = cv2.imread('hero-blue-rgba.png', cv2.IMREAD_UNCHANGED)
H, W = im.shape[:2]
bgr = im[...,:3].copy(); a = im[...,3].copy()
b, g, r = [bgr[...,i].astype(int) for i in range(3)]

# 1. wipe the painted eyes and smile off the visor (row interpolation across the cleared area)
cy = (g > 150) & (b > 150) & (r < 170)
roi = np.zeros(a.shape, bool); roi[540:930, 680:1250] = True
m = cv2.dilate((cy & roi).astype(np.uint8)*255, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (95,95))) > 0
m &= roi
out = bgr.astype(np.float32)
for y in range(540, 930):
    row = m[y]
    if not row.any(): continue
    lab, n = ndi.label(row)
    for i in range(1, n+1):
        xs = np.where(lab == i)[0]; x0, x1 = xs.min(), xs.max()
        L = np.median(bgr[y, max(x0-36, 0):max(x0-14, 1)].astype(np.float32), axis=0)
        R = np.median(bgr[y, x1+14:x1+36].astype(np.float32), axis=0)
        if L.sum() - R.sum() > 40: L = R.copy()   # the glare dot must not smear across
        t = (np.arange(x0, x1+1)-x0)/max(x1-x0, 1)
        out[y, x0:x1+1] = L[None]*(1-t[:,None]) + R[None]*t[:,None]
out = out.astype(np.uint8)
soft = cv2.GaussianBlur(out, (0,0), 5)
mm = cv2.GaussianBlur(m.astype(np.float32), (0,0), 7)[...,None]
out = (out*(1-mm) + soft*mm).astype(np.uint8)

# 2. visor bounds from the dark navy screen
navy = (r < 70) & (g < 80) & (b > 40) & (b < 150) & (a > 200)
lab, n = ndi.label(navy)
vis = lab == lab[800, 940]
ys, xs = np.where(vis)
print('visor bbox', xs.min(), ys.min(), xs.max(), ys.max())

# 3. split head / body at the neck, give the body a dark stub for the head to sit on
CUT = 1056
head = np.dstack([out, a]); body = head.copy()
head[CUT:, :, 3] = 0
body[:CUT, :, 3] = 0
stub = np.zeros(a.shape, bool); stub[1004:CUT+4, 892:1124] = True
body[...,:3][stub & (body[...,3] == 0)] = (60, 36, 36)   # BGR dark navy-grey
body[...,3][stub & (body[...,3] == 0)] = 255

# 4. one canvas for both layers, with room for the head to move and tilt
PX0, PX1, PY0, PY1 = 333, 1713, -34, 1960
def crop(img):
    padded = cv2.copyMakeBorder(img, 60, 0, 0, 200, cv2.BORDER_CONSTANT, value=(0,0,0,0))
    return padded[PY0+60:PY1+60, PX0:PX1]
SC = 0.3
head_c, body_c = crop(head), crop(body)
ow, oh = head_c.shape[1], head_c.shape[0]
sw, sh = int(round(ow*SC)), int(round(oh*SC))
head_s = cv2.resize(head_c, (sw, sh), interpolation=cv2.INTER_AREA)
body_s = cv2.resize(body_c, (sw, sh), interpolation=cv2.INTER_AREA)
cv2.imwrite('head.png', head_s); cv2.imwrite('body.png', body_s)
meta = dict(size=[sw, sh], scale=SC, box=[PX0, PY0, PX1, PY1],
            pivot=[(1007-PX0)/ow, (CUT-PY0)/oh],
            visor=[(xs.min()-PX0)/ow, (ys.min()-PY0)/oh, (xs.max()-PX0)/ow, (ys.max()-PY0)/oh],
            eyeL=[(783-PX0)/ow, (686-PY0)/oh], eyeR=[(1087-PX0)/ow, (686-PY0)/oh], eyeSize=[72/ow, 128/oh],
            mouth=[(932-PX0)/ow, (815-PY0)/oh])
json.dump(meta, open('meta.json','w'), indent=1); print(json.dumps(meta))
bg = np.full((sh, sw, 3), (40,40,44), np.float32)
comp = bg.copy()
for L in (body_s, head_s):
    al = (L[...,3:4]/255.); comp = L[...,:3]*al + comp*(1-al)
cv2.imwrite('layers-preview.png', comp.astype(np.uint8))
