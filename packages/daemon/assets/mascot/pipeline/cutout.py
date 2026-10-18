import numpy as np, cv2
from scipy import ndimage as ndi
im = cv2.imread('concept.png', cv2.IMREAD_COLOR)  # BGR
h, w = im.shape[:2]
f = im.astype(np.float32)
# background = near-white connected to the border
nearwhite = (f.min(axis=2) > 236)
lab, n = ndi.label(nearwhite)
border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:,0], lab[:,-1]]))) - {0}
bg = np.isin(lab, list(border))
fg = ~bg
fg = ndi.binary_opening(fg, iterations=1)
# keep largest component
lab2, n2 = ndi.label(fg)
sizes = ndi.sum(fg, lab2, range(1, n2+1))
fg = lab2 == (1 + int(np.argmax(sizes)))
fg = ndi.binary_fill_holes(fg)
# soft edge: alpha ramps over a thin band using distance to bg
dist_in = ndi.distance_transform_edt(fg)
alpha = np.clip(dist_in / 2.0, 0, 1)
# decontaminate edge colour: pull from pixels 3px inside
core = ndi.binary_erosion(fg, iterations=4)
idx = ndi.distance_transform_edt(~core, return_distances=False, return_indices=True)
filled = im[idx[0], idx[1]]
band = (~core)
out = im.copy()
out[band] = filled[band]
rgba = np.dstack([out, (alpha*255).astype(np.uint8)])
cv2.imwrite('hero-rgba.png', rgba)
ys, xs = np.where(alpha > 0.5)
print('bbox', xs.min(), ys.min(), xs.max(), ys.max())
# preview on dark bg
bgc = np.full((h, w, 3), (30, 30, 30), np.uint8)
a = alpha[..., None]
prev = (out * a + bgc * (1 - a)).astype(np.uint8)
cv2.imwrite('preview-dark.png', cv2.resize(prev, (900, 900), interpolation=cv2.INTER_AREA))
