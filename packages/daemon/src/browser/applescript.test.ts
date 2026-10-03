import { describe, it, expect } from 'vitest';
import { findBrowser } from './browsers.js';
import { classifyOsascriptError, buildEvalScript, buildTabsScript, buildOpenScript } from './applescript.js';

const brave = findBrowser('brave')!;
const safari = findBrowser('safari')!;

describe('classifyOsascriptError', () => {
  it('maps a disabled JavaScript-from-Apple-Events setting with the browser-specific menu path', () => {
    const err = classifyOsascriptError(
      brave,
      '71:93: execution error: Brave Browser got an error: Executing JavaScript through AppleScript is turned off. To turn it on, from the menu bar, go to View > Developer > Allow JavaScript from Apple Events. (12)',
      1,
    );
    expect(err.code).toBe('js_disabled');
    expect(err.message).toContain('View > Developer > Allow JavaScript from Apple Events');
    expect(err.message).toContain('Brave Browser');
  });

  it('maps Safari wording to Safari instructions', () => {
    const err = classifyOsascriptError(safari, 'Safari got an error: You must enable the Develop menu "Allow JavaScript from Apple Events" (4)', 1);
    expect(err.code).toBe('js_disabled');
    expect(err.message).toContain('Develop');
  });

  it('maps -1743 to automation_denied with the System Settings path', () => {
    const err = classifyOsascriptError(brave, '44:60: execution error: Not authorized to send Apple events to Brave Browser. (-1743)', 1);
    expect(err.code).toBe('automation_denied');
    expect(err.message).toContain('System Settings');
    expect(err.message).toContain('Automation');
  });

  it('maps the script-raised markers and unknown errors', () => {
    expect(classifyOsascriptError(brave, 'execution error: rh:not_running (-2700)', 1).code).toBe('not_running');
    expect(classifyOsascriptError(brave, 'execution error: rh:no_window (-2700)', 1).code).toBe('no_window');
    expect(classifyOsascriptError(brave, 'execution error: rh:no_tab (-2700)', 1).code).toBe('no_tab');
    const other = classifyOsascriptError(brave, 'something odd\n'.repeat(100), 1);
    expect(other.code).toBe('script_error');
    expect(other.message.length).toBeLessThan(600);
    expect(classifyOsascriptError(brave, '', null).code).toBe('timeout');
  });
});

describe('script builders', () => {
  it('never interpolates user data and guards on the app running', () => {
    const lines = buildEvalScript(brave);
    const text = lines.join('\n');
    expect(text).toContain('on run argv');
    expect(text).toContain('item 1 of argv');
    expect(text).toContain('application "Brave Browser" is running');
    expect(text).not.toContain('${');
    expect(text).toContain('rh:not_running');
  });

  it('builds distinct chromium and safari eval scripts', () => {
    expect(buildEvalScript(safari).join('\n')).toContain('do JavaScript');
    expect(buildEvalScript(brave).join('\n')).toContain('execute');
  });

  it('tabs and open scripts guard on running and use argv for the URL', () => {
    expect(buildTabsScript(brave).join('\n')).toContain('is running');
    const open = buildOpenScript(brave).join('\n');
    expect(open).toContain('item 1 of argv');
    expect(open).toContain('is running');
  });
});
