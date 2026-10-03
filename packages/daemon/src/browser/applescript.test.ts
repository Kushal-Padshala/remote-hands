import { describe, it, expect } from 'vitest';
import { findBrowser } from './browsers.js';
import { classifyOsascriptError, buildEvalScript, buildTabsScript, buildOpenScript, buildRunningScript } from './applescript.js';

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

describe('fix round 1', () => {
  const edge = findBrowser('edge')!;

  it('running script derives the frontmost name without info for', () => {
    const text = buildRunningScript().join('\n');
    expect(text).not.toContain('info for');
    expect(text).toContain('path to frontmost application');
  });

  it('only matches script markers in their exact raised form', () => {
    expect(classifyOsascriptError(brave, '618:629: execution error: rh:no_tab (-2700)\n', 1).code).toBe('no_tab');
    const pageLike =
      '600:620: execution error: Can’t make {"rh:no_tab", "rh:not_running", "Allow JavaScript from Apple Events", "(-1743)"} into type text. (-1700)';
    expect(classifyOsascriptError(brave, pageLike, 1).code).toBe('script_error');
    const pageLike2 =
      'execution error: Can’t make "Executing JavaScript through AppleScript is turned off Not authorized to send Apple events to Brave Browser. (-1743)" into type text. (-1700)';
    expect(classifyOsascriptError(brave, pageLike2, 1).code).toBe('script_error');
  });

  it('still maps the real js_disabled and -1743 shapes', () => {
    expect(
      classifyOsascriptError(brave, '648:676: execution error: Brave Browser got an error: Executing JavaScript through AppleScript is turned off. To turn it on ... (12)\n', 1).code,
    ).toBe('js_disabled');
    expect(classifyOsascriptError(brave, '44:60: execution error: Not authorized to send Apple events to Brave Browser. (-1743)', 1).code).toBe(
      'automation_denied',
    );
  });

  it('maps an uninstalled browser to not_running with an install hint', () => {
    for (const stderr of [
      '318:321: syntax error: Expected end of line but found property. (-2741)\n',
      '12:30: syntax error: Expected class name but found identifier. (-2740)',
      'execution error: Can’t get application "Microsoft Edge". (-1728)',
    ]) {
      const err = classifyOsascriptError(edge, stderr, 1);
      expect(err.code).toBe('not_running');
      expect(err.message).toBe('Microsoft Edge is not installed or not running.');
    }
    expect(classifyOsascriptError(brave, 'execution error: Brave Browser got an error: Can’t get window id 1. (-1728)', 1).code).toBe(
      'script_error',
    );
  });

  it('treats only a null status as timeout', () => {
    expect(classifyOsascriptError(brave, '', null).code).toBe('timeout');
    const err = classifyOsascriptError(brave, '', 3);
    expect(err.code).toBe('script_error');
    expect(err.message).toContain('osascript exited with status 3');
  });
});
