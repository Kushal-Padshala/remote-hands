# Mascot art pipeline

The HUD mascot is a small blue robot: a body (`body.png`) and a head (`head.png`) on one shared canvas.
The face is not a picture: the HUD draws the eyes and mouth in code on the head's dark screen (see `FaceLayer`
in `spotlight-hud.swift` and `MascotForm` in `windows-hud/Hud.cs`), so the head can follow the cursor and every
expression is crisp. Where the screen, eyes and neck are on the picture is in `meta.json` (as fractions of the
picture); the HUD code repeats those numbers (`Face` in the Swift file).

1. `concept.png`: the character, generated once on a plain white background (nano_banana_pro, 1:1, 2k). Prompt:
   a tiny chibi robot boy, rounded-square monitor head with a large dark navy visor, small ear caps and an antenna with
   an orange tip, stocky body with a navy chest screen showing a terminal prompt, mitten hands, chunky boots; steel
   blue, deep navy, cyan glow; bold dark-navy outlines, simple shapes, soft shading; no fur, no tail; whole body.
2. `cutout.py`: removes the white background (`concept.png` -> `hero-rgba.png`).
3. `recolor.py`: shifts the steel-grey shell to a stronger blue (`hero-rgba.png` -> `hero-blue-rgba.png`).
4. `layers.py`: wipes the painted face off the screen, splits head from body at the neck, adds a dark neck stub
   to the body, crops both to one canvas with room for the head to move, writes `head.png`, `body.png`, `meta.json`.

The scripts read and write their files in the current directory (paths inside them are relative to it) and need
`opencv-python`, `numpy`, `scipy`, `Pillow`. `npm run build -w @remote-hands/daemon` embeds the PNGs into the CLI
(`mascot-assets.generated.ts`).
