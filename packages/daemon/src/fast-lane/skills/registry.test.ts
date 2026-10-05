import { describe, expect, it, vi } from 'vitest';
import { SkillRegistry } from './registry.js';
import type { Skill, SkillContext } from './types.js';

const ctx = {} as SkillContext;
const skill = (id: string, accepts: (q: string) => Record<string, string> | null): Skill => ({
  id,
  description: id,
  extract: async (q) => accepts(q),
  run: async () => ({ ok: true, summary: id }),
});

describe('SkillRegistry', () => {
  it('returns the first skill whose extractor succeeds, in registration order', async () => {
    const reg = new SkillRegistry();
    reg.register(skill('a', (q) => (q.includes('x') ? { n: 'a' } : null)));
    reg.register(skill('b', (q) => (q.includes('x') || q.includes('y') ? { n: 'b' } : null)));
    expect((await reg.match('x y', ctx))?.skill.id).toBe('a');
    expect((await reg.match('y', ctx))?.skill.id).toBe('b');
    expect((await reg.match('x', ctx))?.slots).toEqual({ n: 'a' });
  });

  it('returns null when nothing matches', async () => {
    const reg = new SkillRegistry();
    reg.register(skill('a', () => null));
    expect(await reg.match('anything', ctx)).toBeNull();
    expect(await new SkillRegistry().match('anything', ctx)).toBeNull();
  });

  it('treats a throwing extractor as no match and keeps looking', async () => {
    const reg = new SkillRegistry();
    reg.register({ id: 'boom', description: '', extract: async () => { throw new Error('bad'); }, run: async () => ({ ok: true, summary: '' }) });
    reg.register(skill('ok', () => ({ k: 'v' })));
    expect((await reg.match('q', ctx))?.skill.id).toBe('ok');
  });

  it('does not even try the extractors on a very long request (pattern matching stays cheap)', async () => {
    const reg = new SkillRegistry();
    const extract = vi.fn(async () => ({ q: 'x' }));
    reg.register({ id: 'a', description: 'a', extract, run: async () => ({ ok: true, summary: '' }) });
    expect(await reg.match('open '.padEnd(600, 'x'), ctx)).toBeNull();
    expect(extract).not.toHaveBeenCalled();
    expect(await reg.match('open it', ctx)).not.toBeNull();
  });

  it('rejects duplicate ids', () => {
    const reg = new SkillRegistry();
    reg.register(skill('a', () => null));
    expect(() => reg.register(skill('a', () => null))).toThrow('already registered');
  });

  it('lists registered skills', () => {
    const reg = new SkillRegistry();
    reg.register(skill('a', () => null));
    reg.register(skill('b', () => null));
    expect(reg.list().map((s) => s.id)).toEqual(['a', 'b']);
  });
});
