import { describe, it, expect, vi } from 'vitest';
import { MacOsDriver } from './macos-driver.js';

describe('MacOsDriver', () => {
  it('instantiates with default options without error', () => {
    const driver = new MacOsDriver();
    expect(driver).toBeDefined();
    expect(typeof driver.exec).toBe('function');
  });

  it('formats open application command', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    await driver.openApp('Slack');
    expect(execMock).toHaveBeenCalledWith('open', ['-a', 'Slack']);
  });

  it('formats open application command with spaces', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    await driver.openApp('Google Chrome');
    expect(execMock).toHaveBeenCalledWith('open', ['-a', 'Google Chrome']);
  });

  it('parses window list from jxa execution', async () => {
    const mockOutput = JSON.stringify([
      { app: 'Google Chrome', title: 'GitHub - Remote Hands', id: 101 },
      { app: 'Visual Studio Code', title: 'macos-driver.ts', id: 102 },
    ]);
    const execMock = vi.fn().mockReturnValue({ stdout: mockOutput, stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    const windows = await driver.listWindows();
    expect(windows.length).toBe(2);
    expect(windows[0]?.app).toBe('Google Chrome');
    expect(windows[0]?.title).toBe('GitHub - Remote Hands');
    expect(windows[0]?.id).toBe(101);
    expect(windows[1]?.app).toBe('Visual Studio Code');
    expect(execMock).toHaveBeenCalledWith('osascript', expect.arrayContaining(['-l', 'JavaScript', '-e']));
  });

  it('returns empty array when jxa returns invalid json', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: 'not valid json', stderr: 'error', status: 1 });
    const driver = new MacOsDriver({ exec: execMock });
    const windows = await driver.listWindows();
    expect(windows).toEqual([]);
  });

  it('returns empty array when jxa returns non-array json', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '{"error": true}', stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    const windows = await driver.listWindows();
    expect(windows).toEqual([]);
  });

  it('activates application on focusWindow', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    await driver.focusWindow('Safari');
    expect(execMock).toHaveBeenCalledWith('osascript', ['-e', 'tell application "Safari" to activate']);
  });

  it('escapes quotes and backslashes in focusWindow', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    await driver.focusWindow('App\\"Quote');
    expect(execMock).toHaveBeenCalledWith('osascript', ['-e', 'tell application "App\\\\\\"Quote" to activate']);
  });

  it('closes window via keystroke', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    await driver.closeWindow('TextEdit');
    expect(execMock).toHaveBeenCalled();
    const callArgs = execMock.mock.calls[0]![1];
    const script = callArgs.join(' ');
    expect(script).toContain('tell process "TextEdit"');
    expect(script).toContain('keystroke "w" using command down');
  });

  it('escapes quotes in closeWindow', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    await driver.closeWindow('App "Test"');
    expect(execMock).toHaveBeenCalled();
    const callArgs = execMock.mock.calls[0]![1];
    expect(callArgs.join(' ')).toContain('tell process "App \\"Test\\""');
  });

  it('triggers menu items via osascript', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    await driver.triggerMenu('TextEdit', ['File', 'Save']);
    expect(execMock).toHaveBeenCalled();
    const callArgs = execMock.mock.calls[0]![1];
    expect(callArgs.join(' ')).toContain('TextEdit');
    expect(callArgs.join(' ')).toContain('File');
    expect(callArgs.join(' ')).toContain('Save');
  });

  it('triggers nested menu items via osascript', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    await driver.triggerMenu('Preview', ['File', 'Export As', 'PDF']);
    expect(execMock).toHaveBeenCalled();
    const callArgs = execMock.mock.calls[0]![1];
    const script = callArgs.join(' ');
    expect(script).toContain('Preview');
    expect(script).toContain('click menu item "PDF" of menu 1 of menu item "Export As" of menu "File" of menu bar 1');
  });

  it('escapes quotes in menu path and app name', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    await driver.triggerMenu('My "App"', ['File "Menu"', 'Save "Item"']);
    expect(execMock).toHaveBeenCalled();
    const callArgs = execMock.mock.calls[0]![1];
    const script = callArgs.join(' ');
    expect(script).toContain('tell process "My \\"App\\""');
    expect(script).toContain('click menu item "Save \\"Item\\"" of menu "File \\"Menu\\"" of menu bar 1');
  });

  it('does nothing when menu path has less than 2 items', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    await driver.triggerMenu('TextEdit', ['File']);
    await driver.triggerMenu('TextEdit', []);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('sends key combo with modifiers', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    await driver.sendKeyCombo(['c'], ['command']);
    expect(execMock).toHaveBeenCalled();
    const callArgs = execMock.mock.calls[0]![1];
    expect(callArgs.join(' ')).toContain('keystroke "c" using {command down}');
  });

  it('sends key combo with multiple modifiers and normalizes down suffix', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    await driver.sendKeyCombo(['z'], ['command down', 'shift']);
    expect(execMock).toHaveBeenCalled();
    const callArgs = execMock.mock.calls[0]![1];
    expect(callArgs.join(' ')).toContain('keystroke "z" using {command down, shift down}');
  });

  it('sends keystroke without modifiers', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    await driver.sendKeyCombo(['a'], []);
    expect(execMock).toHaveBeenCalled();
    const callArgs = execMock.mock.calls[0]![1];
    expect(callArgs.join(' ')).toContain('keystroke "a"\n');
  });

  it('handles empty keys array safely', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    await driver.sendKeyCombo([], ['command']);
    expect(execMock).toHaveBeenCalled();
    const callArgs = execMock.mock.calls[0]![1];
    expect(callArgs.join(' ')).toContain('keystroke "" using {command down}');
  });

  it('escapes quotes and backslashes in keys', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const driver = new MacOsDriver({ exec: execMock });
    await driver.sendKeyCombo(['"'], []);
    expect(execMock).toHaveBeenCalled();
    const callArgs = execMock.mock.calls[0]![1];
    expect(callArgs.join(' ')).toContain('keystroke "\\""');
  });
});
