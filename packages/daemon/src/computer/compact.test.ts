import { describe, it, expect } from 'vitest';
import { compactDesktopElements, capLines } from './compact.js';
import type { IndexedElement } from '../desktop/ax-walker.js';

const el = (index: number, role: string, label: string): IndexedElement => ({
  index,
  role,
  label,
  bounds: [0, 0, 10, 10],
});

describe('compactDesktopElements', () => {
  it('drops unlabeled noise roles, strips the AX prefix and keeps original indexes', () => {
    const out = compactDesktopElements([
      el(1, 'AXStaticText', ''),
      el(2, 'AXButton', 'Next'),
      el(3, 'AXGroup', ''),
      el(4, 'AXTextField', 'Email'),
    ]);
    expect(out).toBe('[2] Button "Next"\n[4] TextField "Email"');
  });

  it('collapses consecutive duplicates and truncates long labels', () => {
    const long = 'x'.repeat(100);
    const out = compactDesktopElements([el(1, 'AXLink', 'Home'), el(2, 'AXLink', 'Home'), el(3, 'AXButton', long)]);
    expect(out.split('\n')).toEqual(['[1] Link "Home"', `[3] Button "${'x'.repeat(59)}…"`]);
  });

  it('caps the number of lines and reports how many were hidden', () => {
    const many = Array.from({ length: 10 }, (_, i) => el(i + 1, 'AXButton', `b${i}`));
    const out = compactDesktopElements(many, { max: 3 });
    expect(out.split('\n')).toHaveLength(4);
    expect(out).toContain('… 7 more elements hidden; pass filter to narrow');
  });

  it('filters by case-insensitive substring of role or label', () => {
    const out = compactDesktopElements([el(1, 'AXButton', 'Save'), el(2, 'AXButton', 'Cancel')], { filter: 'sav' });
    expect(out).toBe('[1] Button "Save"');
  });

  it('says so when nothing is left', () => {
    expect(compactDesktopElements([])).toBe('(no interactive elements found)');
  });
});

describe('capLines', () => {
  it('returns short text unchanged and truncates long text with a note', () => {
    expect(capLines('a\nb', 5)).toBe('a\nb');
    expect(capLines('a\nb\nc\nd', 2)).toBe('a\nb\n… 2 more lines hidden');
  });
});
