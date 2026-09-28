import { describe, expect, it } from 'vitest';
import { ContextService } from './context-service.js';

describe('ContextService', () => {
  it('discovers running apps, browser tabs, and files with hierarchy', async () => {
    const service = new ContextService({
      chromeTabProvider: async () => [
        { id: 'c1', title: 'Google Search', url: 'https://google.com', profile: 'Personal', tabIndex: 0 },
      ],
      appleScriptRunner: async (script) => {
        if (script.includes('Arc')) {
          return 'Arc Tab 1|||https://arc.net\nArc Tab 2|||https://github.com';
        }
        if (script.includes('Brave Browser')) {
          return 'Brave Tab 1|||https://brave.com';
        }
        if (script.includes('Safari')) {
          return 'Apple|||https://apple.com';
        }
        if (script.includes('whose background only is false')) {
          return 'Google Chrome, Arc, Brave Browser, Safari, Visual Studio Code, Terminal';
        }
        return '';
      },
      fileProvider: async () => [
        { id: 'f1', name: 'banner.png', path: '/mock/banner.png', isDir: false },
        { id: 'f2', name: 'report.pdf', path: '/mock/report.pdf', isDir: false },
      ],
    });

    const hierarchy = await service.getHierarchy();

    expect(hierarchy.browsers.length).toBeGreaterThanOrEqual(2);
    const chrome = hierarchy.browsers.find((b) => b.id === 'chrome');
    expect(chrome).toBeDefined();
    expect(chrome?.profiles[0].tabs[0].title).toBe('Google Search');

    const arc = hierarchy.browsers.find((b) => b.id === 'arc');
    expect(arc).toBeDefined();
    expect(arc?.profiles[0].tabs.length).toBe(2);
    expect(arc?.profiles[0].tabs[0].url).toBe('https://arc.net');

    const brave = hierarchy.browsers.find((b) => b.id === 'brave');
    expect(brave).toBeDefined();
    expect(brave?.profiles[0].tabs[0].title).toBe('Brave Tab 1');

    const safari = hierarchy.browsers.find((b) => b.id === 'safari');
    expect(safari).toBeDefined();
    expect(safari?.profiles[0].tabs[0].title).toBe('Apple');

    expect(hierarchy.apps.some((a) => a.name === 'Visual Studio Code')).toBe(true);
    expect(hierarchy.files.some((f) => f.name === 'banner.png')).toBe(true);
  });

  it('filters targets by query', async () => {
    const service = new ContextService({
      chromeTabProvider: async () => [
        { id: 'c1', title: 'Property Details 101', url: 'https://example.com/prop/101', profile: 'Personal' },
        { id: 'c2', title: 'Dashboard', url: 'https://example.com/dash', profile: 'Personal' },
      ],
      appleScriptRunner: async (script) => {
        if (script.includes('Arc')) {
          return 'Meta Ads Manager|||https://adsmanager.facebook.com';
        }
        return '';
      },
      fileProvider: async () => [
        { id: 'f1', name: 'property-banner.png', path: '/mock/property-banner.png', isDir: false },
        { id: 'f2', name: 'other.txt', path: '/mock/other.txt', isDir: false },
      ],
    });

    const filtered = await service.filterTargets('property');
    expect(filtered.browsers.some((b) => b.profiles.some((p) => p.tabs.some((t) => t.title.includes('Property'))))).toBe(true);
    expect(filtered.browsers.every((b) => b.profiles.every((p) => p.tabs.every((t) => !t.title.includes('Dashboard'))))).toBe(true);
    expect(filtered.files.length).toBe(1);
    expect(filtered.files[0].name).toBe('property-banner.png');
  });
});
