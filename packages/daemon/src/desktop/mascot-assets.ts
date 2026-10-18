import * as fs from 'node:fs';
import * as path from 'node:path';
import { MASCOT_ASSETS } from './mascot-assets.generated.js';

/**
 * Writes the HUD mascot's art to `<home>/.remote-hands/mascot/` (the Mac and Windows HUD programs load the PNGs from
 * there). A file that already matches is left alone; the HUD still runs without them, just without the mascot.
 */
export function materializeMascotAssets(home: string, assets: Record<string, string> = MASCOT_ASSETS): string {
  const dir = path.join(home, '.remote-hands', 'mascot');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, base64] of Object.entries(assets)) {
    const bytes = Buffer.from(base64, 'base64');
    const target = path.join(dir, name);
    try {
      if (fs.readFileSync(target).equals(bytes)) continue;
    } catch {}
    fs.writeFileSync(target, bytes);
  }
  return dir;
}
