import { z } from 'zod';
import type { ComputerSession } from './session.js';

export interface ComputerTool {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  handler(args: any): Promise<string>;
}

const app = z.string().optional().describe('Application name. Omit for the frontmost app.');

export function buildComputerTools(session: ComputerSession): ComputerTool[] {
  const tools: ComputerTool[] = [
    {
      name: 'desktop_snapshot',
      description:
        'List interactive UI elements of a macOS app as "[index] Role \\"label\\"". Indexes are valid until the next snapshot or action. Use filter to search by role/label substring. desktop_click must target the same app as the latest snapshot, so either omit app on both calls or pass the same app to both.',
      inputSchema: { app, filter: z.string().optional().describe('Case-insensitive substring of role or label.') },
      handler: (a) => session.desktopSnapshot(a.app, a.filter),
    },
    {
      name: 'desktop_click',
      description:
        'Press a UI element by index from the latest desktop_snapshot using native Accessibility (no mouse movement); if the element does not support AXPress it may fall back to a physical click at its center, which is reported in the result. The app must be the same as in the latest desktop_snapshot: omit app on both calls or pass the same app to both, otherwise the call fails. Returns the new UI state, so a separate snapshot is not needed.',
      inputSchema: {
        index: z.number().int().describe('Index from the latest snapshot.'),
        app: z
          .string()
          .optional()
          .describe('Application name. Must match the latest desktop_snapshot app; omit to use the snapshot app.'),
      },
      handler: (a) => session.desktopClick(a.index, a.app),
    },
    {
      name: 'desktop_type',
      description: 'Type text into the focused element. Returns the new UI state.',
      inputSchema: { text: z.string(), app },
      handler: (a) => session.desktopType(a.text, a.app),
    },
    {
      name: 'desktop_key',
      description: 'Press a key or shortcut such as "return", "tab", "cmd+s", "cmd+shift+t". Returns the new UI state.',
      inputSchema: { combo: z.string(), app },
      handler: (a) => session.desktopKey(a.combo, a.app),
    },
    {
      name: 'desktop_open',
      description: 'Launch or activate an application and return its UI state.',
      inputSchema: { app: z.string() },
      handler: (a) => session.desktopOpen(a.app),
    },
    {
      name: 'desktop_menu',
      description: 'Fuzzy-search an app menu bar and trigger the best match, for example query "Export".',
      inputSchema: { app: z.string(), query: z.string() },
      handler: (a) => session.desktopMenu(a.app, a.query),
    },
    {
      name: 'desktop_windows',
      description: 'List open windows as "App - Title".',
      inputSchema: {},
      handler: () => session.desktopWindows(),
    },
    {
      name: 'browser_tabs',
      description: 'List Chrome tabs as "[wN-tM] (active) title - url".',
      inputSchema: {},
      handler: () => session.browserTabs(),
    },
    {
      name: 'browser_focus',
      description: 'Switch to an existing tab by index, url substring or title. Prefer this over opening duplicates.',
      inputSchema: { target: z.string().describe('Tab index, url substring or title.') },
      handler: (a) => session.browserFocus(/^\d+$/.test(a.target) ? Number(a.target) : a.target),
    },
    {
      name: 'browser_open',
      description: 'Open a URL (reuses a matching tab) and return the page state.',
      inputSchema: { url: z.string() },
      handler: (a) => session.browserOpen(a.url),
    },
    {
      name: 'browser_snapshot',
      description: 'List interactive page elements of the active tab as "[index] role \\"label\\"".',
      inputSchema: {},
      handler: () => session.browserSnapshot(),
    },
    {
      name: 'browser_click',
      description: 'Click a page element by index. Returns the new page state.',
      inputSchema: { index: z.number().int() },
      handler: (a) => session.browserClick(a.index),
    },
    {
      name: 'browser_type',
      description: 'Type text into a page element by index. Returns the new page state.',
      inputSchema: { index: z.number().int(), text: z.string() },
      handler: (a) => session.browserType(a.index, a.text),
    },
  ];

  const byName = new Map(tools.map((t) => [t.name, t]));

  tools.push({
    name: 'computer_batch',
    description:
      'Run several tool calls in one round trip, validating all steps first and stopping at the first failure. Every action re-reads the UI, so index-based steps (desktop_click, browser_click, browser_type) refer to the UI state AFTER the previous step, which you have not seen; typing and key presses can reshape the UI. Batch only steps that do not need an index, with at most one index-based step first or last. Returns per-step status and the final state.',
    inputSchema: {
      steps: z
        .array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) }))
        .min(1)
        .max(12),
    },
    handler: async (a) => {
      const steps = a.steps as Array<{ tool: string; args?: Record<string, unknown> }>;
      // Validate every step up front so nothing runs if any step is malformed.
      const plan = steps.map((step, i) => {
        const n = i + 1;
        const tool = step.tool === 'computer_batch' ? undefined : byName.get(step.tool);
        if (!tool) throw new Error(`step ${n} ${step.tool} failed: unknown or nested tool`);
        const parsed = z.object(tool.inputSchema).safeParse(step.args ?? {});
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const where = issue && issue.path.length > 0 ? issue.path.join('.') : '(args)';
          throw new Error(
            `step ${n} ${step.tool} invalid args: ${where}: ${issue?.message ?? 'invalid'}. No steps were run.`,
          );
        }
        return { tool, name: step.tool, args: parsed.data };
      });

      const lines: string[] = [];
      let last = '';
      for (let i = 0; i < plan.length; i += 1) {
        const step = plan[i]!;
        const n = i + 1;
        try {
          last = await step.tool.handler(step.args);
        } catch (err: any) {
          const okSoFar = n === 1 ? 'no steps ok' : n === 2 ? 'step 1 ok' : `steps 1-${n - 1} ok`;
          const remaining = i < plan.length - 1 ? `; steps after ${n} not run` : '';
          throw new Error(`step ${n} ${step.name} failed: ${err?.message ?? err} (${okSoFar}${remaining})`);
        }
        lines.push(`step ${n} ${step.name} ok`);
      }
      return [...lines, last].join('\n');
    },
  });

  return tools;
}
