import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

  it('stays identical to the repo skill file', () => {
    const file = fileURLToPath(new URL('../../../../.agents/skills/remote-hands-operator/SKILL.md', import.meta.url));
    expect(REMOTE_HANDS_OPERATOR_SKILL_MD).toBe(readFileSync(file, 'utf8'));
  });

  it('documents the stable-id browser tools and keeps the zero-discovery and zero-screenshot mandates', () => {
    const md = REMOTE_HANDS_OPERATOR_SKILL_MD;
    for (const tool of ['browser_find', 'browser_do', 'browser_extract']) expect(md).toContain(`\`${tool}\``);
    expect(md).toContain('stable');
    expect(md).toContain('never call `browser_snapshot` again after an action');
    expect(md).toContain('note: fast browser path unavailable');
    expect(md).toContain('rh browser setup');
    expect(md).toContain('## Speed Mandate: Zero Discovery');
    expect(md).toContain('ZERO SCREENSHOTS');
    expect(md).toContain('Never take screenshots');
  });
});
