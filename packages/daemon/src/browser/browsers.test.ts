import { describe, it, expect } from 'vitest';
import { BROWSERS, findBrowser, pickTargetBrowser } from './browsers.js';

describe('browser registry', () => {
  it('lists the supported browsers in preference order', () => {
    expect(BROWSERS.map((b) => b.name)).toEqual(['Google Chrome', 'Brave Browser', 'Arc', 'Microsoft Edge', 'Safari']);
    expect(findBrowser('safari')?.family).toBe('safari');
    expect(findBrowser('Brave')?.name).toBe('Brave Browser');
    expect(findBrowser('  CHROME ')?.name).toBe('Google Chrome');
    expect(findBrowser('Firefox')).toBeUndefined();
  });

  it('prefers a running override, then the frontmost browser, then the first running browser', () => {
    const running = ['Google Chrome', 'Brave Browser', 'Finder'];
    expect(pickTargetBrowser({ frontmost: 'Brave Browser', running })?.name).toBe('Brave Browser');
    expect(pickTargetBrowser({ frontmost: 'Finder', running })?.name).toBe('Google Chrome');
    expect(pickTargetBrowser({ frontmost: 'Finder', running, override: 'brave' })?.name).toBe('Brave Browser');
    expect(pickTargetBrowser({ frontmost: 'Brave Browser', running, override: 'arc' })?.name).toBe('Brave Browser');
    expect(pickTargetBrowser({ frontmost: null, running: ['Finder'] })).toBeUndefined();
  });
});
