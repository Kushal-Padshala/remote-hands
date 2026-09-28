import { describe, expect, it } from 'vitest';
import { contextCommand } from './context.js';
import { ContextService } from '@remote-hands/daemon';

describe('contextCommand', () => {
  it('outputs json hierarchy with --json flag', async () => {
    let output = '';
    const mockService = new ContextService({
      chromeTabProvider: async () => [
        { id: 'c1', title: 'Example Domain', url: 'https://example.com', profile: 'Personal' },
      ],
      appleScriptRunner: async () => 'Google Chrome, Notes',
      fileProvider: async () => [
        { id: 'f1', name: 'banner.png', path: '/mock/banner.png', isDir: false },
      ],
    });

    const code = await contextCommand(['list', '--json'], {
      stdout: (msg) => {
        output += msg + '\n';
      },
      contextService: mockService,
    } as any);

    expect(code).toBe(0);
    const parsed = JSON.parse(output.trim());
    expect(parsed.browsers.length).toBeGreaterThanOrEqual(1);
    expect(parsed.browsers[0].profiles[0].tabs[0].title).toBe('Example Domain');
    expect(parsed.files[0].name).toBe('banner.png');
  });

  it('filters targets when query flag is provided', async () => {
    let output = '';
    const mockService = new ContextService({
      chromeTabProvider: async () => [
        { id: 'c1', title: 'Special Property Page', url: 'https://example.com/prop', profile: 'Personal' },
        { id: 'c2', title: 'Dashboard', url: 'https://example.com/dash', profile: 'Personal' },
      ],
      appleScriptRunner: async () => '',
      fileProvider: async () => [],
    });

    const code = await contextCommand(['list', '--json', '--query=property'], {
      stdout: (msg) => {
        output += msg + '\n';
      },
      contextService: mockService,
    } as any);

    expect(code).toBe(0);
    const parsed = JSON.parse(output.trim());
    expect(parsed.browsers[0].profiles[0].tabs.length).toBe(1);
    expect(parsed.browsers[0].profiles[0].tabs[0].title).toBe('Special Property Page');
  });
});
