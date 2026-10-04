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

  it('collapses consecutive non-interactive duplicates and truncates long labels', () => {
    const long = 'x'.repeat(100);
    const out = compactDesktopElements([el(1, 'AXStaticText', 'Home'), el(2, 'AXStaticText', 'Home'), el(3, 'AXButton', long)]);
    expect(out.split('\n')).toEqual(['[1] StaticText "Home"', `[3] Button "${'x'.repeat(59)}…"`]);
  });

  it('never collapses consecutive interactive duplicates', () => {
    const out = compactDesktopElements([el(1, 'AXLink', 'Home'), el(2, 'AXLink', 'Home')]);
    expect(out.split('\n')).toEqual(['[1] Link "Home"', '[2] Link "Home"']);
  });

  it('lists every repeated unlabeled button', () => {
    const out = compactDesktopElements([el(1, 'AXButton', ''), el(2, 'AXButton', ''), el(3, 'AXButton', '')]);
    expect(out.split('\n')).toEqual(['[1] Button ""', '[2] Button ""', '[3] Button ""']);
  });

  it('shows all same-label matches when a filter is active', () => {
    const out = compactDesktopElements(
      [
        el(1, 'AXButton', 'Delete'),
        el(2, 'AXStaticText', 'Row one'),
        el(3, 'AXButton', 'Delete'),
        el(4, 'AXStaticText', 'Row two'),
        el(5, 'AXButton', 'Delete'),
      ],
      { filter: 'delete' },
    );
    expect(out.split('\n')).toEqual(['[1] Button "Delete"', '[3] Button "Delete"', '[5] Button "Delete"']);
  });

  it('does not dedupe non-interactive duplicates while filtering', () => {
    const out = compactDesktopElements([el(1, 'AXStaticText', 'Total'), el(2, 'AXStaticText', 'Total')], { filter: 'total' });
    expect(out.split('\n')).toEqual(['[1] StaticText "Total"', '[2] StaticText "Total"']);
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
