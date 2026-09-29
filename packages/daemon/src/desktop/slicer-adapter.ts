import type { MacOsDriver } from './macos-driver.js';

const SLICER_APP_PATTERN = /bambu|orca|prusa|slicer|creality/i;

const SLICER_SHORTCUTS: Record<string, string> = {
  slice: 'cmd+r',
  import: 'cmd+i',
  'select all': 'cmd+a',
  deselect: 'esc',
  delete: 'backspace',
  undo: 'cmd+z',
  redo: 'cmd+shift+z',
  save: 'cmd+s',
  export: 'cmd+e',
};

export function isSlicerApp(appName: string): boolean {
  if (!appName) return false;
  return SLICER_APP_PATTERN.test(appName);
}

export function getSlicerShortcut(intent: string): string | undefined {
  if (!intent) return undefined;
  const lower = intent.trim().toLowerCase();
  return SLICER_SHORTCUTS[lower];
}

export async function assignSlicerFilament(
  driver: MacOsDriver & { pressKey?: (key: string) => Promise<void> },
  slotNumber: number,
): Promise<boolean> {
  if (slotNumber < 1 || slotNumber > 9) return false;
  try {
    if (typeof driver.pressKey === 'function') {
      await driver.pressKey(String(slotNumber));
    } else {
      await driver.typeText(String(slotNumber));
    }
    return true;
  } catch {
    return false;
  }
}

export async function addSlicerFilamentSlot(driver: MacOsDriver): Promise<boolean> {
  try {
    await driver.clickAt(300, 439, 'left');
    return true;
  } catch {
    return false;
  }
}
