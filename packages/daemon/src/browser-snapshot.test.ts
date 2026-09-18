import { describe, it, expect } from 'vitest';
import {
  formatIndexedElements,
  parseSnapshotOutput,
  DOM_SNAPSHOT_SCRIPT,
  type IndexedElement,
} from './browser-snapshot.js';

describe('DOM Snapshot Engine', () => {
  it('contains valid executable JavaScript script', () => {
    expect(typeof DOM_SNAPSHOT_SCRIPT).toBe('string');
    expect(DOM_SNAPSHOT_SCRIPT).toContain('window.__rhFast');
    expect(DOM_SNAPSHOT_SCRIPT).toContain('checkVisibility');
  });

  it('formats indexed elements into a compact terminal table', () => {
    const elements: IndexedElement[] = [
      { index: 1, id: 101, role: 'button', label: 'Deploy Preview', tag: 'BUTTON' },
      { index: 2, id: 102, role: 'textbox', label: 'API Key', tag: 'INPUT', value: '' },
      { index: 3, id: 103, role: 'link', label: 'Documentation', tag: 'A' },
    ];
    const table = formatIndexedElements(elements);
    expect(table).toContain('[1] button   Deploy Preview');
    expect(table).toContain('[2] textbox  API Key');
    expect(table).toContain('[3] link     Documentation');
  });

  it('parses raw snapshot output safely', () => {
    const raw = {
      url: 'https://example.com',
      title: 'Example Domain',
      elements: [
        { index: 1, id: 1, role: 'link', label: 'More information...', tag: 'A' },
      ],
    };
    const parsed = parseSnapshotOutput(raw);
    expect(parsed.url).toBe('https://example.com');
    expect(parsed.title).toBe('Example Domain');
    expect(parsed.elements).toHaveLength(1);
    expect(parsed.formattedTable).toContain('[1] link     More information...');
  });

  it('handles empty or malformed raw output gracefully', () => {
    const parsed = parseSnapshotOutput(null);
    expect(parsed.url).toBe('');
    expect(parsed.title).toBe('');
    expect(parsed.elements).toHaveLength(0);
    expect(parsed.formattedTable).toBe('No interactive elements found.');
  });

  it('formats elements with extra attributes like value, checked, disabled', () => {
    const elements: IndexedElement[] = [
      { index: 1, id: 101, role: 'checkbox', label: 'Remember me', tag: 'INPUT', checked: true },
      { index: 2, id: 102, role: 'button', label: 'Save', tag: 'BUTTON', disabled: true },
      { index: 3, id: 103, role: 'textbox', label: 'Email', tag: 'INPUT', value: 'test@example.com' },
    ];
    const table = formatIndexedElements(elements);
    expect(table).toContain('[checked]');
    expect(table).toContain('[disabled]');
    expect(table).toContain('· value="test@example.com"');
  });
});
