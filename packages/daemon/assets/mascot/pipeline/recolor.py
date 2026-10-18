import numpy as np, cv2
im = cv2.imread('hero-rgba.png', cv2.IMREAD_UNCHANGED)
bgr = im[...,:3]; a = im[...,3]
hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)   # H 0..180, S,V 0..255
h,s,v = hsv[...,0],hsv[...,1],hsv[...,2]
shell = (h>95)&(h<125)&(s>25)&(s<170)&(v>70)&(a>0)     # steel-blue shell tones only (hue 190-250 deg)
h2 = np.where(shell, np.clip(h+4, 0, 180), h)
s2 = np.where(shell, np.clip(s*1.55+14, 0, 235), s)
v2 = np.where(shell, np.clip(v*1.02, 0, 255), v)
out = cv2.cvtColor(np.dstack([h2,s2,v2]).astype(np.uint8), cv2.COLOR_HSV2BGR)
cv2.imwrite('hero-blue-rgba.png', np.dstack([out, a]))
for name,src in (('orig',bgr),('blue',out)):
    bg=np.full(src.shape,(40,40,44),np.float32); al=(a/255.)[...,None]
    p=(src*al+bg*(1-al)).astype(np.uint8)
    cv2.imwrite(f'cmp-{name}.png', cv2.resize(p,(700,700),interpolation=cv2.INTER_AREA))
both=np.hstack([cv2.imread('cmp-orig.png'),cv2.imread('cmp-blue.png')]); cv2.imwrite('cmp.png',both)
