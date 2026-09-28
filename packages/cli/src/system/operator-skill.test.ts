import { describe, it, expect, vi } from 'vitest';
import { ensureRemoteHandsOperatorSkill, REMOTE_HANDS_OPERATOR_SKILL_MD } from './operator-skill.js';
import type { FileSystemAdapter } from '../cloudflare/project.js';

describe('ensureRemoteHandsOperatorSkill', () => {
  it('installs skill into project and global runtime locations', async () => {
    const writtenFiles: Record<string, string> = {};
    const mockFs: FileSystemAdapter = {
      readFile: vi.fn().mockImplementation(async (p: string) => writtenFiles[p] || ''),
      writeFile: vi.fn().mockImplementation(async (p: string, c: string) => {
        writtenFiles[p] = c;
      }),
      exists: vi.fn().mockImplementation(async (p: string) => Boolean(writtenFiles[p])),
      mkdir: vi.fn().mockResolvedValue(undefined),
    };

    const res = await ensureRemoteHandsOperatorSkill(mockFs, '/mock/project');
    expect(res).toBe(true);

    const paths = Object.keys(writtenFiles);
    expect(paths.some((p) => p.includes('.agents/skills/remote-hands-operator/SKILL.md'))).toBe(true);
    expect(paths.some((p) => p.includes('.gemini/config/skills/remote-hands-operator/SKILL.md'))).toBe(true);
    expect(paths.some((p) => p.includes('.claude/skills/remote-hands-operator/SKILL.md'))).toBe(true);

    const sample = Object.values(writtenFiles)[0];
    expect(sample).toContain('name: remote-hands-operator');
    expect(sample).toContain('rh browser tabs');
    expect(sample).toContain('rh desktop window list');
  });
});
