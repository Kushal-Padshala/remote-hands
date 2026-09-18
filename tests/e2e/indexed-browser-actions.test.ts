import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { browserCommand } from '../../packages/cli/src/commands/browser.js';
import {
  BrowserDriver,
  formatIndexedElements,
  parseSnapshotOutput,
  type IndexedElement,
} from '@remote-hands/daemon';

interface MockBrowserState {
  url: string;
  title: string;
  elements: IndexedElement[];
  clickedElementIds: number[];
  typedValues: Map<number, string>;
}

class MockCdpWebSocket {
  private messageListeners: Array<(data: Buffer) => void> = [];
  private openListeners: Array<() => void> = [];

  constructor(private readonly state: MockBrowserState) {}

  on(event: string, callback: any): void {
    if (event === 'open') {
      this.openListeners.push(callback);
      setTimeout(() => callback(), 0);
    } else if (event === 'message') {
      this.messageListeners.push(callback);
    }
  }

  send(payload: string): void {
    const request = JSON.parse(payload);
    setTimeout(() => {
      if (request.method === 'Page.navigate') {
        this.state.url = request.params?.url || this.state.url;
        const response = { id: request.id, result: {} };
        for (const listener of this.messageListeners) {
          listener(Buffer.from(JSON.stringify(response)));
        }
        return;
      }

      if (request.method === 'Runtime.evaluate') {
        const expression = String(request.params?.expression || '');
        let value: any = true;

        if (expression.includes('mousedown') && expression.includes('nodes.get')) {
          const match = expression.match(/nodes\.get\((\d+)\)/);
          if (match && match[1]) {
            const nodeId = parseInt(match[1], 10);
            this.state.clickedElementIds.push(nodeId);
          }
        } else if (expression.includes('insertText') && expression.includes('nodes.get')) {
          const idMatch = expression.match(/nodes\.get\((\d+)\)/);
          const textMatch = expression.match(/insertText',\s*false,\s*(".*?")/);
          if (idMatch && idMatch[1] && textMatch && textMatch[1]) {
            const nodeId = parseInt(idMatch[1], 10);
            const textValue = JSON.parse(textMatch[1]);
            this.state.typedValues.set(nodeId, textValue);
            const target = this.state.elements.find((el) => el.id === nodeId);
            if (target) {
              target.value = textValue;
            }
          }
        } else if (expression.includes('checkVisibility') || expression.includes('interactiveRoles') || expression.includes('window.__rhFast')) {
          value = {
            url: this.state.url,
            title: this.state.title,
            elements: this.state.elements.map((el) => ({ ...el })),
          };
        }

        const response = {
          id: request.id,
          result: {
            result: {
              value,
            },
          },
        };

        for (const listener of this.messageListeners) {
          listener(Buffer.from(JSON.stringify(response)));
        }
      }
    }, 0);
  }

  close(): void {}
}

describe('End-to-End Cross-Domain Task Execution with Indexed Browser Actions', () => {
  let mockState: MockBrowserState;
  let stdoutMessages: string[] = [];
  let stderrMessages: string[] = [];
  let tempWorkspaceDir = '';

  const getCtx = () => ({
    stdout: (msg: string) => stdoutMessages.push(msg),
    stderr: (msg: string) => stderrMessages.push(msg),
  });

  beforeEach(() => {
    stdoutMessages = [];
    stderrMessages = [];
    mockState = {
      url: 'http://localhost:3000/app',
      title: 'Remote Hands Workspace App',
      elements: [
        {
          index: 1,
          id: 101,
          role: 'button',
          label: 'Deploy Production',
          tag: 'BUTTON',
          type: 'submit',
          value: '',
          disabled: false,
        },
        {
          index: 2,
          id: 102,
          role: 'textbox',
          label: 'API Access Key',
          tag: 'INPUT',
          type: 'text',
          value: '',
          checked: false,
          disabled: false,
        },
        {
          index: 3,
          id: 103,
          role: 'link',
          label: 'Deployment Logs',
          tag: 'A',
          disabled: false,
        },
      ],
      clickedElementIds: [],
      typedValues: new Map<number, string>(),
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('/json/version')) {
          return {
            ok: true,
            json: async () => ({ Browser: 'Chrome/120.0.0.0' }),
          };
        }
        if (urlStr.includes('/json')) {
          return {
            ok: true,
            json: async () => [
              {
                id: 'tab-e2e',
                type: 'page',
                title: mockState.title,
                url: mockState.url,
                webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-e2e',
              },
            ],
          };
        }
        return {
          ok: false,
          statusText: 'Not Found',
        };
      }),
    );

    vi.spyOn(BrowserDriver.prototype as any, 'createWebSocket').mockImplementation(() => {
      return new MockCdpWebSocket(mockState);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (tempWorkspaceDir && fs.existsSync(tempWorkspaceDir)) {
      fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
      tempWorkspaceDir = '';
    }
  });

  it('simulates cross-domain task execution where agent handles workspace files, runs tests, and drives browser', async () => {
    tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-e2e-crossdomain-'));
    const packageJsonPath = path.join(tempWorkspaceDir, 'package.json');
    const sourceFilePath = path.join(tempWorkspaceDir, 'service.ts');
    const testFilePath = path.join(tempWorkspaceDir, 'service.test.ts');

    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: 'remote-hands-microservice', version: '1.0.0' }, null, 2),
    );
    fs.writeFileSync(
      sourceFilePath,
      `export const serviceConfig = { ready: true, version: '1.0.0' };\nexport function getStatus(): string { return 'healthy'; }\n`,
    );
    fs.writeFileSync(
      testFilePath,
      `import { serviceConfig, getStatus } from './service.js';\nif (!serviceConfig.ready || getStatus() !== 'healthy') throw new Error('Verification failed');\n`,
    );

    expect(fs.existsSync(packageJsonPath)).toBe(true);
    expect(fs.existsSync(sourceFilePath)).toBe(true);
    expect(fs.existsSync(testFilePath)).toBe(true);

    const sourceContent = fs.readFileSync(sourceFilePath, 'utf-8');
    expect(sourceContent).toContain(`version: '1.0.0'`);
    const verifiedStatus = sourceContent.includes('healthy');
    expect(verifiedStatus).toBe(true);

    const buildArtifactPath = path.join(tempWorkspaceDir, 'dist.json');
    fs.writeFileSync(
      buildArtifactPath,
      JSON.stringify({ buildStatus: 'passed', artifacts: ['service.js'] }),
    );
    expect(fs.existsSync(buildArtifactPath)).toBe(true);

    const snapshotExitCode = await browserCommand(['snapshot'], getCtx());
    expect(snapshotExitCode).toBe(0);
    const snapshotOutput = stdoutMessages.join('\n');
    expect(snapshotOutput).toContain('[1] button   Deploy Production');
    expect(snapshotOutput).toContain('[2] textbox  API Access Key');
    expect(snapshotOutput).toContain('[3] link     Deployment Logs');

    stdoutMessages = [];
    const clickExitCode = await browserCommand(['click', '1'], getCtx());
    expect(clickExitCode).toBe(0);
    expect(stdoutMessages.join('\n')).toContain('Clicked [1] Deploy Production');
    expect(mockState.clickedElementIds).toContain(101);

    stdoutMessages = [];
    const typeExitCode = await browserCommand(['type', '2', 'test-input'], getCtx());
    expect(typeExitCode).toBe(0);
    expect(stdoutMessages.join('\n')).toContain('Typed "test-input" into [2] API Access Key');
    expect(mockState.typedValues.get(102)).toBe('test-input');

    stdoutMessages = [];
    const updatedSnapshotCode = await browserCommand(['snapshot'], getCtx());
    expect(updatedSnapshotCode).toBe(0);
    expect(stdoutMessages.join('\n')).toContain('· value="test-input"');
  });

  it('verifies formatted table with interactive controls and JSON output formatting', async () => {
    const tableCode = await browserCommand(['snapshot'], getCtx());
    expect(tableCode).toBe(0);
    const tableOutput = stdoutMessages.join('\n');
    expect(tableOutput).toContain('[1]');
    expect(tableOutput).toContain('button');
    expect(tableOutput).toContain('Deploy Production');

    stdoutMessages = [];
    const jsonCode = await browserCommand(['snapshot', '--json'], getCtx());
    expect(jsonCode).toBe(0);
    const parsed = JSON.parse(stdoutMessages.join('\n'));
    expect(parsed.url).toBe('http://localhost:3000/app');
    expect(parsed.title).toBe('Remote Hands Workspace App');
    expect(parsed.elements).toHaveLength(3);
    expect(parsed.elements[0].index).toBe(1);
    expect(parsed.elements[0].role).toBe('button');
    expect(parsed.elements[0].label).toBe('Deploy Production');
    expect(parsed.elements[1].index).toBe(2);
    expect(parsed.elements[1].role).toBe('textbox');
    expect(parsed.elements[1].label).toBe('API Access Key');
    expect(parsed.formattedTable).toBeDefined();
  });

  it('handles invalid indices, missing parameters, and invalid command forms gracefully', async () => {
    let code = await browserCommand(['click'], getCtx());
    expect(code).toBe(1);
    expect(stderrMessages.join('\n')).toContain('Usage: rh browser click <index>');

    stderrMessages = [];
    code = await browserCommand(['click', '999'], getCtx());
    expect(code).toBe(1);
    expect(stderrMessages.join('\n')).toContain('Index 999 not found');

    stderrMessages = [];
    code = await browserCommand(['click', 'non-numeric'], getCtx());
    expect(code).toBe(1);
    expect(stderrMessages.join('\n')).toContain('Usage: rh browser click <index>');

    stderrMessages = [];
    code = await browserCommand(['type'], getCtx());
    expect(code).toBe(1);
    expect(stderrMessages.join('\n')).toContain('Usage: rh browser type <index> <text>');

    stderrMessages = [];
    code = await browserCommand(['type', '2'], getCtx());
    expect(code).toBe(1);
    expect(stderrMessages.join('\n')).toContain('Usage: rh browser type <index> <text>');

    stderrMessages = [];
    code = await browserCommand(['type', '999', 'test-input'], getCtx());
    expect(code).toBe(1);
    expect(stderrMessages.join('\n')).toContain('Index 999 not found');

    stderrMessages = [];
    code = await browserCommand(['open'], getCtx());
    expect(code).toBe(1);
    expect(stderrMessages.join('\n')).toContain('Usage: rh browser open <url>');

    stderrMessages = [];
    code = await browserCommand(['open', 'invalid-url'], getCtx());
    expect(code).toBe(1);
    expect(stderrMessages.join('\n')).toContain('Invalid URL: invalid-url');
  });

  it('manages browser tabs and navigation via browser commands', async () => {
    const tabsCode = await browserCommand(['tabs'], getCtx());
    expect(tabsCode).toBe(0);
    expect(stdoutMessages.join('\n')).toContain('[tab-e2e] Remote Hands Workspace App - http://localhost:3000/app');

    stdoutMessages = [];
    const tabsJsonCode = await browserCommand(['tabs', '--json'], getCtx());
    expect(tabsJsonCode).toBe(0);
    const parsedTabs = JSON.parse(stdoutMessages.join('\n'));
    expect(parsedTabs).toHaveLength(1);
    expect(parsedTabs[0].id).toBe('tab-e2e');
    expect(parsedTabs[0].url).toBe('http://localhost:3000/app');

    stdoutMessages = [];
    const openCode = await browserCommand(['open', 'http://localhost:3000/dashboard'], getCtx());
    expect(openCode).toBe(0);
    expect(stdoutMessages.join('\n')).toContain('Opened http://localhost:3000/dashboard');
    expect(mockState.url).toBe('http://localhost:3000/dashboard');
  });

  it('verifies DOM snapshot parsing and table formatting helper functions', () => {
    const rawData = {
      url: 'http://localhost:3000/overview',
      title: 'Overview',
      elements: [
        { index: 1, id: 1, role: 'button', label: 'Save', tag: 'BUTTON', disabled: false },
        { index: 2, id: 2, role: 'checkbox', label: 'Agree', tag: 'INPUT', checked: true },
      ],
    };

    const parsed = parseSnapshotOutput(rawData);
    expect(parsed.url).toBe('http://localhost:3000/overview');
    expect(parsed.title).toBe('Overview');
    expect(parsed.elements).toHaveLength(2);
    expect(parsed.formattedTable).toContain('[1] button   Save');
    expect(parsed.formattedTable).toContain('[2] checkbox Agree [checked]');

    const emptyParsed = parseSnapshotOutput(null);
    expect(emptyParsed.elements).toHaveLength(0);
    expect(emptyParsed.formattedTable).toBe('No interactive elements found.');

    const emptyTable = formatIndexedElements([]);
    expect(emptyTable).toBe('No interactive elements found.');
  });
});
