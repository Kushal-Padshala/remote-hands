import { describe, it, expect, vi } from 'vitest';
import { isSlicerApp, getSlicerShortcut, assignSlicerFilament, addSlicerFilamentSlot } from './slicer-adapter.js';
import { MacOsDriver } from './macos-driver.js';

describe('slicer-adapter', () => {
  it('identifies 3D slicer applications', () => {
    expect(isSlicerApp('Bambu Studio')).toBe(true);
    expect(isSlicerApp('OrcaSlicer')).toBe(true);
    expect(isSlicerApp('PrusaSlicer')).toBe(true);
    expect(isSlicerApp('Creality Print')).toBe(true);
    expect(isSlicerApp('Google Chrome')).toBe(false);
    expect(isSlicerApp('Slack')).toBe(false);
    expect(isSlicerApp('')).toBe(false);
  });

  it('maps semantic slicer operations to native shortcuts', () => {
    expect(getSlicerShortcut('slice')).toBe('cmd+r');
    expect(getSlicerShortcut('import')).toBe('cmd+i');
    expect(getSlicerShortcut('select all')).toBe('cmd+a');
    expect(getSlicerShortcut('delete')).toBe('backspace');
    expect(getSlicerShortcut('undo')).toBe('cmd+z');
    expect(getSlicerShortcut('redo')).toBe('cmd+shift+z');
    expect(getSlicerShortcut('unknown_intent')).toBeUndefined();
  });

  it('assigns filament slot directly via keyboard number press', async () => {
    const driver = new MacOsDriver();
    (driver as any).pressKey = vi.fn().mockResolvedValue(undefined);
    const pressKeyMock = vi.spyOn(driver, 'pressKey');
    const success = await assignSlicerFilament(driver, 2);
    expect(success).toBe(true);
    expect(pressKeyMock).toHaveBeenCalledWith('2');
  });

  it('falls back to typeText when pressKey is not present', async () => {
    const driver = new MacOsDriver();
    const typeTextMock = vi.spyOn(driver, 'typeText').mockResolvedValue(undefined);
    const success = await assignSlicerFilament(driver, 4);
    expect(success).toBe(true);
    expect(typeTextMock).toHaveBeenCalledWith('4');
  });

  it('returns false when slot number is out of bounds or pressKey fails', async () => {
    const driver = new MacOsDriver();
    (driver as any).pressKey = vi.fn().mockResolvedValue(undefined);
    expect(await assignSlicerFilament(driver, 0)).toBe(false);
    expect(await assignSlicerFilament(driver, 10)).toBe(false);
    vi.spyOn(driver, 'pressKey').mockRejectedValue(new Error('Key failed'));
    expect(await assignSlicerFilament(driver, 3)).toBe(false);
  });

  it('adds filament slot by executing click action', async () => {
    const driver = new MacOsDriver();
    const clickAtMock = vi.spyOn(driver, 'clickAt').mockResolvedValue(undefined);
    const success = await addSlicerFilamentSlot(driver);
    expect(success).toBe(true);
    expect(clickAtMock).toHaveBeenCalled();
  });

  it('returns false when add filament slot click fails', async () => {
    const driver = new MacOsDriver();
    vi.spyOn(driver, 'clickAt').mockRejectedValue(new Error('Click failed'));
    const success = await addSlicerFilamentSlot(driver);
    expect(success).toBe(false);
  });
});
