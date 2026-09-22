import { describe, it, expect, vi } from 'vitest';
import { DesktopActEngine } from './desktop-act.js';
import { MacOsDriver } from './macos-driver.js';
import type { IndexedElement } from './ax-walker.js';

describe('DesktopActEngine', () => {
  it('instantiates with default options without error', () => {
    const engine = new DesktopActEngine();
    expect(engine).toBeDefined();
    expect(engine.driver).toBeInstanceOf(MacOsDriver);
  });

  it('instantiates with custom driver instance', () => {
    const driver = new MacOsDriver();
    const engine = new DesktopActEngine(driver);
    expect(engine.driver).toBe(driver);
  });

  it('instantiates with options object containing driver', () => {
    const driver = new MacOsDriver();
    const engine = new DesktopActEngine({ driver });
    expect(engine.driver).toBe(driver);
  });

  it('instantiates with options object containing exec mock', () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const engine = new DesktopActEngine({ exec: execMock });
    expect(engine.driver.exec).toBe(execMock);
  });

  it('instantiates with direct exec function', () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const engine = new DesktopActEngine(execMock);
    expect(engine.driver.exec).toBe(execMock);
  });

  it('is exported from daemon index', async () => {
    const daemonIndex = await import('../index.js');
    expect(daemonIndex.DesktopActEngine).toBeDefined();
    const engine = new daemonIndex.DesktopActEngine();
    expect(engine).toBeInstanceOf(DesktopActEngine);
  });

  it('selects matching element index based on sub-goal target', () => {
    const engine = new DesktopActEngine();
    const elements: IndexedElement[] = [
      { index: 1, role: 'AXButton', label: 'Cancel', bounds: [10, 10, 50, 30] },
      { index: 2, role: 'AXButton', label: 'Save Changes', bounds: [70, 10, 100, 30] },
    ];
    const decision = engine.matchHeuristic('Click Save Changes', elements);
    expect(decision.action).toBe('CLICK');
    expect(decision.targetIndex).toBe(2);
  });

  it('handles click with double quotes and single quotes', () => {
    const engine = new DesktopActEngine();
    const elements: IndexedElement[] = [
      { index: 1, role: 'AXButton', label: 'Cancel', bounds: [10, 10, 50, 30] },
      { index: 2, role: 'AXButton', label: 'Save Changes', bounds: [70, 10, 100, 30] },
    ];
    const decisionDouble = engine.matchHeuristic('Click "Save Changes"', elements);
    expect(decisionDouble.action).toBe('CLICK');
    expect(decisionDouble.targetIndex).toBe(2);

    const decisionSingle = engine.matchHeuristic("Click 'Cancel'", elements);
    expect(decisionSingle.action).toBe('CLICK');
    expect(decisionSingle.targetIndex).toBe(1);
  });

  it('handles click on and tap variations', () => {
    const engine = new DesktopActEngine();
    const elements: IndexedElement[] = [
      { index: 1, role: 'AXButton', label: 'Submit', bounds: [10, 10, 50, 30] },
    ];
    const clickOn = engine.matchHeuristic('click on Submit', elements);
    expect(clickOn.action).toBe('CLICK');
    expect(clickOn.targetIndex).toBe(1);

    const tap = engine.matchHeuristic('Tap Submit', elements);
    expect(tap.action).toBe('CLICK');
    expect(tap.targetIndex).toBe(1);
  });

  it('handles explicit index target for click', () => {
    const engine = new DesktopActEngine();
    const elements: IndexedElement[] = [
      { index: 1, role: 'AXButton', label: 'First', bounds: [10, 10, 50, 30] },
      { index: 2, role: 'AXButton', label: 'Second', bounds: [70, 10, 50, 30] },
    ];
    const decisionBracket = engine.matchHeuristic('Click [2]', elements);
    expect(decisionBracket.action).toBe('CLICK');
    expect(decisionBracket.targetIndex).toBe(2);

    const decisionNumber = engine.matchHeuristic('Click 1', elements);
    expect(decisionNumber.action).toBe('CLICK');
    expect(decisionNumber.targetIndex).toBe(1);
  });

  it('returns click with undefined targetIndex when label does not match', () => {
    const engine = new DesktopActEngine();
    const elements: IndexedElement[] = [
      { index: 1, role: 'AXButton', label: 'Cancel', bounds: [10, 10, 50, 30] },
    ];
    const decision = engine.matchHeuristic('Click Nonexistent', elements);
    expect(decision.action).toBe('CLICK');
    expect(decision.targetIndex).toBeUndefined();
  });

  it('disambiguates between elements with shared substrings for click', () => {
    const engine = new DesktopActEngine();
    const elements: IndexedElement[] = [
      { index: 1, role: 'AXButton', label: 'Save', bounds: [10, 10, 50, 30] },
      { index: 2, role: 'AXButton', label: 'Save Changes', bounds: [70, 10, 100, 30] },
    ];
    const decisionExact = engine.matchHeuristic('Click Save Changes', elements);
    expect(decisionExact.action).toBe('CLICK');
    expect(decisionExact.targetIndex).toBe(2);

    const decisionShort = engine.matchHeuristic('Click Save', elements);
    expect(decisionShort.action).toBe('CLICK');
    expect(decisionShort.targetIndex).toBe(1);
  });

  it('detects type intent and extracts payload with in', () => {
    const engine = new DesktopActEngine();
    const elements: IndexedElement[] = [
      { index: 1, role: 'AXTextField', label: 'Search Query', bounds: [10, 10, 100, 30] },
    ];
    const decision = engine.matchHeuristic('Type "Quarterly Report" in Search Query', elements);
    expect(decision.action).toBe('TYPE_TEXT');
    expect(decision.targetIndex).toBe(1);
    expect(decision.text).toBe('Quarterly Report');
  });

  it('detects type intent and extracts payload with into', () => {
    const engine = new DesktopActEngine();
    const elements: IndexedElement[] = [
      { index: 1, role: 'AXTextField', label: 'Search Query', bounds: [10, 10, 100, 30] },
    ];
    const decision = engine.matchHeuristic('Type "Quarterly Report" into Search Query', elements);
    expect(decision.action).toBe('TYPE_TEXT');
    expect(decision.targetIndex).toBe(1);
    expect(decision.text).toBe('Quarterly Report');
  });

  it('detects unquoted type intent with into field', () => {
    const engine = new DesktopActEngine();
    const elements: IndexedElement[] = [
      { index: 1, role: 'AXTextField', label: 'Address', bounds: [10, 10, 100, 30] },
    ];
    const decision = engine.matchHeuristic('Type hello world into Address', elements);
    expect(decision.action).toBe('TYPE_TEXT');
    expect(decision.targetIndex).toBe(1);
    expect(decision.text).toBe('hello world');
  });

  it('detects type intent without field and defaults to first textfield', () => {
    const engine = new DesktopActEngine();
    const elements: IndexedElement[] = [
      { index: 1, role: 'AXButton', label: 'Submit', bounds: [10, 10, 50, 30] },
      { index: 2, role: 'AXTextField', label: 'Input', bounds: [70, 10, 100, 30] },
    ];
    const decision = engine.matchHeuristic('Type "default text"', elements);
    expect(decision.action).toBe('TYPE_TEXT');
    expect(decision.targetIndex).toBe(2);
    expect(decision.text).toBe('default text');
  });

  it('detects type intent when no text fields exist', () => {
    const engine = new DesktopActEngine();
    const elements: IndexedElement[] = [
      { index: 1, role: 'AXButton', label: 'Submit', bounds: [10, 10, 50, 30] },
    ];
    const decision = engine.matchHeuristic('Type "orphan text"', elements);
    expect(decision.action).toBe('TYPE_TEXT');
    expect(decision.targetIndex).toBeUndefined();
    expect(decision.text).toBe('orphan text');
  });

  it('detects press key intent for standard keys', () => {
    const engine = new DesktopActEngine();
    const elements: IndexedElement[] = [
      { index: 1, role: 'AXButton', label: 'Submit', bounds: [10, 10, 50, 30] },
    ];
    const decisionEnter = engine.matchHeuristic('Press Enter', elements);
    expect(decisionEnter.action).toBe('KEY');
    expect(decisionEnter.key).toBe('Enter');

    const decisionReturn = engine.matchHeuristic('Press Return', elements);
    expect(decisionReturn.action).toBe('KEY');
    expect(decisionReturn.key).toBe('Return');

    const decisionTab = engine.matchHeuristic('Press Tab', elements);
    expect(decisionTab.action).toBe('KEY');
    expect(decisionTab.key).toBe('Tab');

    const decisionEsc = engine.matchHeuristic('Press Escape', elements);
    expect(decisionEsc.action).toBe('KEY');
    expect(decisionEsc.key).toBe('Escape');

    const decisionSpace = engine.matchHeuristic('Press Space', elements);
    expect(decisionSpace.action).toBe('KEY');
    expect(decisionSpace.key).toBe('Space');
  });

  it('detects press key intent for key combinations', () => {
    const engine = new DesktopActEngine();
    const elements: IndexedElement[] = [];
    const decisionCmdS = engine.matchHeuristic('Press Cmd+S', elements);
    expect(decisionCmdS.action).toBe('KEY');
    expect(decisionCmdS.key).toBe('Cmd+S');

    const decisionCombo = engine.matchHeuristic('Press Command+Shift+P', elements);
    expect(decisionCombo.action).toBe('KEY');
    expect(decisionCombo.key).toBe('Command+Shift+P');
  });

  it('detects press intent with hit or key prefix', () => {
    const engine = new DesktopActEngine();
    const elements: IndexedElement[] = [];
    const decisionHit = engine.matchHeuristic('hit Enter', elements);
    expect(decisionHit.action).toBe('KEY');
    expect(decisionHit.key).toBe('Enter');

    const decisionKey = engine.matchHeuristic('Press key Tab', elements);
    expect(decisionKey.action).toBe('KEY');
    expect(decisionKey.key).toBe('Tab');
  });

  it('detects terminating and completion goals as DONE', () => {
    const engine = new DesktopActEngine();
    const elements: IndexedElement[] = [];
    expect(engine.matchHeuristic('done', elements).action).toBe('DONE');
    expect(engine.matchHeuristic('DONE', elements).action).toBe('DONE');
    expect(engine.matchHeuristic('Done.', elements).action).toBe('DONE');
    expect(engine.matchHeuristic('complete', elements).action).toBe('DONE');
    expect(engine.matchHeuristic('Completed', elements).action).toBe('DONE');
    expect(engine.matchHeuristic('finish', elements).action).toBe('DONE');
    expect(engine.matchHeuristic('finished', elements).action).toBe('DONE');
    expect(engine.matchHeuristic('exit', elements).action).toBe('DONE');
    expect(engine.matchHeuristic('stop', elements).action).toBe('DONE');
    expect(engine.matchHeuristic('terminate', elements).action).toBe('DONE');
  });

  it('falls back to clicking element mentioned in freeform goal', () => {
    const engine = new DesktopActEngine();
    const elements: IndexedElement[] = [
      { index: 1, role: 'AXButton', label: 'Dismiss', bounds: [10, 10, 50, 30] },
      { index: 2, role: 'AXButton', label: 'Save Changes', bounds: [70, 10, 100, 30] },
    ];
    const decision = engine.matchHeuristic('please select Save Changes now', elements);
    expect(decision.action).toBe('CLICK');
    expect(decision.targetIndex).toBe(2);
  });

  it('returns DONE for unclassifiable goal with no element matches', () => {
    const engine = new DesktopActEngine();
    const elements: IndexedElement[] = [
      { index: 1, role: 'AXButton', label: 'Save', bounds: [10, 10, 50, 30] },
    ];
    const decision = engine.matchHeuristic('unrelated random thought', elements);
    expect(decision.action).toBe('DONE');
  });

  it('executes CLICK decision by clicking element midpoint', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const engine = new DesktopActEngine({ exec: execMock });
    const elements: IndexedElement[] = [
      { index: 1, role: 'AXButton', label: 'Submit', bounds: [100, 200, 80, 40] },
    ];
    await engine.executeDecision({ action: 'CLICK', targetIndex: 1 }, elements);
    expect(execMock).toHaveBeenCalledWith('osascript', ['-e', expect.stringContaining('click at {140, 220}')]);
  });

  it('does not dispatch CLICK if targetIndex is not found in elements', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const engine = new DesktopActEngine({ exec: execMock });
    await engine.executeDecision({ action: 'CLICK', targetIndex: 99 }, []);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('executes TYPE_TEXT with targetIndex by focusing element then typing', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const engine = new DesktopActEngine({ exec: execMock });
    const elements: IndexedElement[] = [
      { index: 1, role: 'AXTextField', label: 'Search', bounds: [50, 50, 100, 30] },
    ];
    await engine.executeDecision({ action: 'TYPE_TEXT', targetIndex: 1, text: 'Remote Hands' }, elements);
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock).toHaveBeenNthCalledWith(1, 'osascript', ['-e', expect.stringContaining('click at {100, 65}')]);
    expect(execMock).toHaveBeenNthCalledWith(2, 'osascript', ['-e', expect.stringContaining('keystroke "Remote Hands"')]);
  });

  it('executes TYPE_TEXT without targetIndex by directly keystroking', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const engine = new DesktopActEngine({ exec: execMock });
    await engine.executeDecision({ action: 'TYPE_TEXT', text: 'Hello' }, []);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith('osascript', ['-e', expect.stringContaining('keystroke "Hello"')]);
  });

  it('escapes quotes and backslashes in TYPE_TEXT', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const engine = new DesktopActEngine({ exec: execMock });
    await engine.executeDecision({ action: 'TYPE_TEXT', text: 'Hello "World" \\ Test' }, []);
    expect(execMock).toHaveBeenCalledWith('osascript', ['-e', expect.stringContaining('keystroke "Hello \\"World\\" \\\\ Test"')]);
  });

  it('executes KEY decision with special key code for Return', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const engine = new DesktopActEngine({ exec: execMock });
    await engine.executeDecision({ action: 'KEY', key: 'Return' }, []);
    expect(execMock).toHaveBeenCalledWith('osascript', ['-e', expect.stringContaining('key code 36')]);
  });

  it('executes KEY decision with special key code for Tab and Escape', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const engine = new DesktopActEngine({ exec: execMock });
    await engine.executeDecision({ action: 'KEY', key: 'Tab' }, []);
    expect(execMock).toHaveBeenCalledWith('osascript', ['-e', expect.stringContaining('key code 48')]);

    await engine.executeDecision({ action: 'KEY', key: 'Escape' }, []);
    expect(execMock).toHaveBeenCalledWith('osascript', ['-e', expect.stringContaining('key code 53')]);
  });

  it('executes KEY decision with modifier combo', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const engine = new DesktopActEngine({ exec: execMock });
    await engine.executeDecision({ action: 'KEY', key: 'Cmd+S' }, []);
    expect(execMock).toHaveBeenCalledWith('osascript', ['-e', expect.stringContaining('keystroke "s" using {command down}')]);
  });

  it('executes KEY decision for single character', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const engine = new DesktopActEngine({ exec: execMock });
    await engine.executeDecision({ action: 'KEY', key: 'a' }, []);
    expect(execMock).toHaveBeenCalledWith('osascript', ['-e', expect.stringContaining('keystroke "a"')]);
  });

  it('does nothing on DONE decision', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const engine = new DesktopActEngine({ exec: execMock });
    await engine.executeDecision({ action: 'DONE' }, []);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('act method matches and executes in one call', async () => {
    const execMock = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const engine = new DesktopActEngine({ exec: execMock });
    const elements: IndexedElement[] = [
      { index: 1, role: 'AXButton', label: 'Save', bounds: [10, 10, 40, 20] },
    ];
    const decision = await engine.act('Click Save', elements);
    expect(decision.action).toBe('CLICK');
    expect(decision.targetIndex).toBe(1);
    expect(execMock).toHaveBeenCalledWith('osascript', ['-e', expect.stringContaining('click at {30, 20}')]);
  });
});
