import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MASCOT_ASSETS } from './mascot-assets.generated.js';
import { materializeMascotAssets } from './mascot-assets.js';

const assetDir = path.join(__dirname, '..', '..', 'assets', 'mascot');

/** Width and height from a PNG's header. */
function pngSize(base64: string): [number, number] {
  const bytes = Buffer.from(base64, 'base64');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe('HUD mascot art', () => {
  it('has the body and the head, drawn on the same canvas so the head sits on the neck', () => {
    expect(Object.keys(MASCOT_ASSETS).sort()).toEqual(['body.png', 'head.png']);
    expect(pngSize(MASCOT_ASSETS['head.png']!)).toEqual(pngSize(MASCOT_ASSETS['body.png']!));
  });

  it('embeds exactly what is in assets/mascot (run `npm run build -w @remote-hands/daemon` after changing a picture)', () => {
    for (const [name, data] of Object.entries(MASCOT_ASSETS)) expect(fs.readFileSync(path.join(assetDir, name)).toString('base64')).toBe(data);
    expect(fs.readdirSync(assetDir).filter((f) => f.endsWith('.png')).sort()).toEqual(Object.keys(MASCOT_ASSETS).sort());
  });

  it('materializeMascotAssets writes the files, repairs a changed one and leaves the rest untouched', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-mascot-'));
    try {
      const assets = { 'base.png': Buffer.from('one').toString('base64'), 'face_happy.png': Buffer.from('two').toString('base64') };
      const dir = materializeMascotAssets(home, assets);
      expect(dir).toBe(path.join(home, '.remote-hands', 'mascot'));
      expect(fs.readFileSync(path.join(dir, 'base.png'), 'utf-8')).toBe('one');
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(path.join(dir, 'base.png'), old, old);
      fs.writeFileSync(path.join(dir, 'face_happy.png'), 'damaged');
      materializeMascotAssets(home, assets);
      expect(fs.statSync(path.join(dir, 'base.png')).mtimeMs).toBeLessThan(Date.now() - 30_000);
      expect(fs.readFileSync(path.join(dir, 'face_happy.png'), 'utf-8')).toBe('two');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
