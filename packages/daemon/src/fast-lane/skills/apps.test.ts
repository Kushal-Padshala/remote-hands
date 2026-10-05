import { describe, expect, it } from 'vitest';
import { createAppCatalog } from './apps.js';

const fsWith = (dirs: Record<string, string[] | Error>) => ({
  readdirSync: (dir: string) => {
    const v = dirs[dir];
    if (v === undefined || v instanceof Error) throw v ?? new Error('ENOENT');
    return v;
  },
});

describe('createAppCatalog', () => {
  const catalog = createAppCatalog({
    dirs: ['/A', '/B', '/missing'],
    fs: fsWith({
      '/A': ['Notes.app', 'Notes Helper.app', 'Google Chrome.app', 'Google Earth.app', 'readme.txt', 'Safari.app'],
      '/B': ['Spotify.app', 'Notes.app', 'Arc.app'],
    }) as never,
  });

  it('lists app names without the suffix, ignoring other entries, duplicates and unreadable folders', () => {
    expect(catalog.names()).toEqual(['Arc', 'Google Chrome', 'Google Earth', 'Notes', 'Notes Helper', 'Safari', 'Spotify']);
  });

  it('resolves an exact name case-insensitively, preferring it over longer names', () => {
    expect(catalog.resolve('notes')).toEqual({ name: 'Notes' });
    expect(catalog.resolve('  SPOTIFY ')).toEqual({ name: 'Spotify' });
    expect(catalog.resolve('the Notes')).toEqual({ name: 'Notes' });
  });

  it('resolves a unique prefix or substring', () => {
    expect(catalog.resolve('saf')).toEqual({ name: 'Safari' });
    expect(catalog.resolve('chrome')).toEqual({ name: 'Google Chrome' });
  });

  it('returns candidates when several apps match', () => {
    expect(catalog.resolve('google')).toEqual({ candidates: ['Google Chrome', 'Google Earth'] });
  });

  it('returns null for an unknown or empty name', () => {
    expect(catalog.resolve('pod bay doors')).toBeNull();
    expect(catalog.resolve('')).toBeNull();
    expect(catalog.resolve('   ')).toBeNull();
  });

  it('caps candidates at 8', () => {
    const many = createAppCatalog({ dirs: ['/A'], fs: fsWith({ '/A': Array.from({ length: 20 }, (_, i) => `Tool ${i}.app`) }) as never });
    const r = many.resolve('tool') as { candidates: string[] };
    expect(r.candidates).toHaveLength(8);
  });
});
