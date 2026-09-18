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

  it('evaluates DOM_SNAPSHOT_SCRIPT against HTML elements and masks password values', async () => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM(`
      <!DOCTYPE html>
      <html>
        <head><title>Test App</title></head>
        <body>
          <button aria-label="Submit Order">Submit</button>
          <input type="password" aria-label="Secret Password" value="super-secret-123" />
          <input type="text" placeholder="Your Name" value="Alice" />
          <a href="/docs">API Docs</a>
        </body>
      </html>
    `, { runScripts: 'dangerously', url: 'https://example.com/app' });

    const result = dom.window.eval(DOM_SNAPSHOT_SCRIPT);
    expect(result.url).toBe('https://example.com/app');
    expect(result.title).toBe('Test App');
    expect(result.elements.length).toBeGreaterThanOrEqual(4);

    const passwordElement = result.elements.find((e: any) => e.type === 'password');
    expect(passwordElement).toBeDefined();
    expect(passwordElement.label).toBe('Secret Password');
    expect(passwordElement.value).toBe('••••••••');

    const buttonElement = result.elements.find((e: any) => e.role === 'button');
    expect(buttonElement).toBeDefined();
    expect(buttonElement.label).toBe('Submit Order');

    const nameElement = result.elements.find((e: any) => e.label === 'Your Name');
    expect(nameElement).toBeDefined();
    expect(nameElement.value).toBe('Alice');
  });
});
