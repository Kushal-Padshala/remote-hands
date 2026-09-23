import { describe, it, expect } from 'vitest';
import {
  BROWSER_OVERLAY_SCRIPT,
  generateShowGuideScript,
  generateDismissGuideScript,
} from './browser-overlay-script.js';

describe('Browser Overlay Script', () => {
  it('exports valid JavaScript runtime script', () => {
    expect(BROWSER_OVERLAY_SCRIPT).toBeDefined();
    expect(BROWSER_OVERLAY_SCRIPT).toContain('window.__rhGuide');
    expect(BROWSER_OVERLAY_SCRIPT).toContain('SVG_NS');
    expect(BROWSER_OVERLAY_SCRIPT).toContain('evenodd');
  });

  it('generates executable script for showGuide with selector', () => {
    const script = generateShowGuideScript({
      selector: 'button#upload',
      text: 'Click here to upload',
      step: 1,
      totalSteps: 3,
    });
    expect(script).toContain('window.__rhGuide.show');
    expect(script).toContain('button#upload');
    expect(script).toContain('Click here to upload');
    expect(script).toContain('step: 1');
    expect(script).toContain('totalSteps: 3');
  });

  it('generates executable script for showGuide with indexed element id', () => {
    const script = generateShowGuideScript({
      index: 5,
      text: 'Select file',
    });
    expect(script).toContain('window.__rhGuide.show');
    expect(script).toContain('index: 5');
    expect(script).toContain('Select file');
  });

  it('generates executable script for dismissGuide', () => {
    const script = generateDismissGuideScript();
    expect(script).toContain('window.__rhGuide.dismiss');
  });
});
