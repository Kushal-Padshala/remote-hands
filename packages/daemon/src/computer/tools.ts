import { z } from 'zod';
import type { ComputerSession } from './session.js';
import { ABANDONED, isCallAborted } from './call-scope.js';

export interface ComputerTool {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  handler(args: any): Promise<string>;
}

const app = z.string().optional().describe('Application name. Omit for the frontmost app.');

const stableId = z.number().int().min(1).describe('Stable id from the last page state.');

// Flat on purpose: oneOf/anyOf/const unions are not reliably accepted by every MCP client's schema dialect.
const DO_OPS = ['click', 'type', 'select', 'check', 'hover', 'press', 'scroll', 'wait'] as const;

const doStepSchema = z.object({
  op: z.enum(DO_OPS),
  index: stableId.optional(),
  target: z.string().min(1).max(200).optional().describe('Visible label of the element, instead of index. Exact label preferred.'),
  text: z.string().optional(),
  value: z.string().optional(),
  checked: z.boolean().optional(),
  key: z.string().optional().describe('Key name such as Enter, Tab, Shift+Tab, Escape.'),
  delta: z.number().optional().describe('Pixels to scroll; negative scrolls up.'),
  ms: z.number().int().min(0).max(5000).optional(),
  submit: z.boolean().optional().describe('type only: press Enter after typing.'),
});

const ELEMENT_OPS = new Set<(typeof DO_OPS)[number]>(['click', 'type', 'select', 'check', 'hover']);

const REQUIRED_BY_OP: Record<(typeof DO_OPS)[number], Array<keyof z.infer<typeof doStepSchema>>> = {
  click: [],
  type: ['text'],
  select: ['value'],
  check: ['checked'],
  hover: [],
  press: ['key'],
  scroll: ['delta'],
  wait: ['ms'],
};

const doStepsSchema = z
  .array(doStepSchema)
  .min(1)
  .max(30)
  .superRefine((steps, ctx) => {
    steps.forEach((step, i) => {
      if (ELEMENT_OPS.has(step.op)) {
        if (step.index === undefined && step.target === undefined) {
          ctx.addIssue({ code: 'custom', path: [i, 'index'], message: `step ${i + 1} ${step.op} needs index or target` });
        } else if (step.index !== undefined && step.target !== undefined) {
          ctx.addIssue({ code: 'custom', path: [i, 'index'], message: `step ${i + 1} ${step.op} takes index or target, not both` });
        }
      }
      for (const field of REQUIRED_BY_OP[step.op]) {
        if (step[field] === undefined) {
          ctx.addIssue({ code: 'custom', path: [i, field], message: `step ${i + 1} ${step.op} needs ${field}` });
        }
      }
    });
  });

export interface ComputerToolsOptions {
  /** Only the Mac can control native apps; elsewhere the desktop tools are not offered. */
  platform?: NodeJS.Platform | undefined;
}

export function buildComputerTools(session: ComputerSession, opts: ComputerToolsOptions = {}): ComputerTool[] {
  const desktopTools = (opts.platform ?? process.platform) === 'darwin';
  const tools: ComputerTool[] = [
    {
      name: 'desktop_snapshot',
      description:
        'List the controls and text of a macOS app window as "[index] role \\"label\\"" with state (disabled, selected, checked, focused), values in fields ("= \\"text\\""), extra actions in braces ({open}, {menu}) and a hint line when more is scrolled out of view ("… N more below"). Indexes stay the same across snapshots and actions while the element stays on screen. Use filter to search by role/label substring. In a big window (editors, chat and web-based apps) each list or pane is cut short and ends with "… N more in [id] … (desktop_snapshot index=id)": pass that index to read just that part (up to 400 lines; use filter inside a longer one); ids from outside it are not available until you take a full snapshot, and later actions keep showing only that part (plus any menu or sheet they open) while it stays on screen. Later desktop tools must target the same app as the latest snapshot, so either omit app on all calls or pass the same app. LAST RESORT, only when the snapshot (or its "shows almost nothing to Accessibility" note) does not list what you need: ocr=true also reads the window by sight, a picture of that one window read as text, about half a second slower. It adds lines like "[1000003] \\"Send\\" @82,91" whose ids can only be clicked with desktop_click. Never use ocr=true when Accessibility already lists the control.',
      inputSchema: {
        app,
        filter: z.string().optional().describe('Case-insensitive substring of role or label.'),
        index: z.number().int().min(1).optional().describe('Read only this list, pane or scroll area from the latest snapshot.'),
        ocr: z.boolean().optional().describe('LAST RESORT: also read the window by sight (slower). Only when Accessibility does not list what you need.'),
      },
      handler: (a) => session.desktopSnapshot(a.app, a.filter, a.index, a.ocr),
    },
    {
      name: 'desktop_click',
      description:
        'Press a UI element by index from the latest desktop_snapshot using native Accessibility (no mouse movement); if the element does not support AXPress it may fall back to a physical click at its center, which is reported in the result. action (optional): "press" (default), "open" (open a row/file/folder; same as double-click), "menu" (show its context menu), "double", "right". The app must be the same as in the latest desktop_snapshot: omit app on both calls or pass the same app to both, otherwise the call fails. Returns what changed on screen (lines starting with + new, ~ changed, - gone), or the whole window when most of it changed, so a separate snapshot is not needed. An index from a desktop_snapshot with ocr=true (1000001 and up) is text read by sight: it is clicked at the middle of that text, after checking that the window is still where it was read; the window is then read by sight again.',
      inputSchema: {
        index: z.number().int().describe('Index from the latest snapshot.'),
        app: z
          .string()
          .optional()
          .describe('Application name. Must match the latest desktop_snapshot app; omit to use the snapshot app.'),
        action: z.enum(['press', 'open', 'menu', 'double', 'right']).optional().describe('How to activate it. Default press.'),
      },
      handler: (a) => session.desktopClick(a.index, a.app, a.action),
    },
    {
      name: 'desktop_type',
      description:
        'Type text into the focused element, or into the field with the given index (it is focused first). With index, replace:true swaps the whole content of the field for the text; submit:true presses Return afterwards. Emoji, new lines and non-English text are fine. Returns what changed on screen.',
      inputSchema: {
        text: z.string(),
        app,
        index: z.number().int().optional().describe('Text field from the latest snapshot. Omit to type into whatever has focus.'),
        replace: z.boolean().optional().describe('With index: replace the existing content instead of adding to it.'),
        submit: z.boolean().optional().describe('Press Return after typing.'),
      },
      handler: (a) => session.desktopType(a.text, a.app, { index: a.index, replace: a.replace, submit: a.submit }),
    },
    {
      name: 'desktop_scroll',
      description:
        'Scroll a list, table or scroll area by its index from the latest snapshot (or any element in it). direction up/down/left/right; amount 1-20 where 1 is about ten lines (default 3). Use it when the snapshot says "… N more below (desktop_scroll [6])" and pass that number as index. Returns what changed on screen.',
      inputSchema: {
        index: z.number().int().describe('Index of the list or an element inside the area to scroll.'),
        direction: z.enum(['up', 'down', 'left', 'right']),
        amount: z.number().int().min(1).max(20).optional().describe('1 is about ten lines. Default 3.'),
        app,
      },
      handler: (a) => session.desktopScroll(a.index, a.direction, a.amount ?? 3, a.app),
    },
    {
      name: 'desktop_read',
      description:
        'Read the full text of an element (a document, a long field, a message) by index from the latest snapshot. Never reads password fields. Use it instead of scrolling when you only need to read.',
      inputSchema: {
        index: z.number().int(),
        max_chars: z.number().int().min(100).max(100000).optional().describe('Maximum characters (default 20000).'),
        app,
      },
      handler: (a) => session.desktopRead(a.index, a.max_chars, a.app),
    },
    {
      name: 'desktop_drag',
      description:
        'Drag one element onto another by index from the latest snapshot (move a file into a folder, reorder a list). It briefly moves the real mouse pointer and puts it back. Returns what changed on screen.',
      inputSchema: { from: z.number().int(), to: z.number().int(), app },
      handler: (a) => session.desktopDrag(a.from, a.to, a.app),
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
      description:
        'List browser tabs as "[wN-tM] (active) title - url". Use it to find a tab to reuse before opening a new one.',
      inputSchema: {},
      handler: () => session.browserTabs(),
    },
    {
      name: 'browser_focus',
      description:
        'Switch to an existing tab by index, url substring or title and return its page state (ids in brackets are stable numbers; do not call browser_snapshot again). Prefer this over opening duplicates.',
      inputSchema: { target: z.string().describe('Tab index, url substring or title.') },
      handler: (a) => session.browserFocus(/^\d+$/.test(a.target) ? Number(a.target) : a.target),
    },
    {
      name: 'browser_open',
      description:
        'Open a URL (reuses a matching tab, never a duplicate) and return the page state. Ids in brackets are stable numbers; the result already contains the page state, so do not call browser_snapshot again.',
      inputSchema: { url: z.string() },
      handler: (a) => session.browserOpen(a.url),
    },
    {
      name: 'browser_snapshot',
      description:
        'Re-read the active tab as "[id] role \\"label\\"" lines. Ids in brackets are stable numbers that stay valid while the element stays on the page. Every browser action result already includes the updated state, so only call this to start from an unknown page or to recover from an error. Pseudo lines [scroll_down], [scroll_up] and [wait] are not ids: use browser_do steps {op:"scroll",delta:560|-560} (down|up) and {op:"wait",ms:...} instead. Selects and checkboxes are set with browser_do ops "select" and "check" (browser_click/browser_type cannot). Content inside open shadow DOM and same-origin iframes is listed like any other element; a note line says when large frames that cannot be read (other websites, sandboxed, nested too deeply) are on screen.',
      inputSchema: {},
      handler: () => session.browserSnapshot(),
    },
    {
      name: 'browser_click',
      description:
        'Click a page element by its stable id from the last state you saw. The result already includes the updated page state, so do not call browser_snapshot again. For several steps or forms use browser_do.',
      inputSchema: { index: stableId },
      handler: (a) => session.browserClick(a.index),
    },
    {
      name: 'browser_type',
      description:
        'Type text into a page element by its stable id from the last state you saw; set submit to press Enter afterwards. The result already includes the updated page state, so do not call browser_snapshot again. To fill and submit a whole form in one call use browser_do.',
      inputSchema: {
        index: stableId,
        text: z.string(),
        submit: z.boolean().optional().describe('Press Enter after typing (for example to submit a search).'),
      },
      handler: (a) => session.browserType(a.index, a.text, a.submit),
    },
    {
      name: 'browser_find',
      description:
        'Search the active page for elements matching a query and return only the best matches with their stable ids. Use it on large pages instead of dumping everything with browser_snapshot. Results use the same ids as the page state.',
      inputSchema: {
        query: z.string().describe('Words from the label, value, role or select options.'),
        limit: z.number().int().min(1).max(20).optional().describe('Maximum matches to return (1-20).'),
      },
      handler: (a) => session.browserFind(a.query, a.limit),
    },
    {
      name: 'browser_do',
      description:
        'Run up to 30 browser steps in ONE call, stopping at the first failure. Prefer this for forms and multi-step sequences. Required fields per op: click/type/select/check/hover need index or target (exactly one: index is the stable id from the last state you saw, target is the element\'s visible label, exact label preferred; an ambiguous or unknown label fails before anything runs and lists the candidates); type needs text (optional submit); select needs value; check needs checked; press needs key (Enter, Tab, Shift+Tab, Escape); scroll needs delta; wait needs ms (0-5000, at most 30000 in total per call). Example: [{"op":"type","index":3,"text":"me@x.com"},{"op":"click","index":7}] or [{"op":"type","target":"Email","text":"me@x.com"},{"op":"click","target":"Next"}]. A click, Enter or submit that navigates ends the batch (remaining steps not run) and the new page state is returned; otherwise the final page state is returned, so do not call browser_snapshot again. Pseudo lines [scroll_down], [scroll_up] and [wait] map to {op:"scroll",delta:560|-560} (down|up) and {op:"wait",ms:...}. Labels are matched among the controls currently visible on screen, using a fresh look at the page taken at the start of the call, and fail (use index) when the page has more controls than could be listed. A call starts no new step after 60 seconds or once the tool call has timed out. hover fires mouse events so menus that open from mouseover handlers appear; it cannot open menus that only use CSS :hover, and clicking the parent is not a substitute (it runs the action of the parent itself). press dispatches synthetic key events: Enter submits forms; Tab and Shift+Tab move focus to the next or previous control in document order (through shadow DOM and frames; positive tabindex values are ordered page-wide) and the result names the control that really took focus; typed keys do not type text (use type). On the slower fallback path only click, type and wait are supported, and only with index.',
      inputSchema: { steps: doStepsSchema },
      handler: (a) => session.browserDo(a.steps),
    },
    {
      name: 'browser_extract',
      description:
        'Read the visible text of the active page (articles, emails, long text). Use it instead of browser_snapshot when you need to read content rather than find controls. One call returns at most about 3000 characters; when the page has more, the result ends with a line naming the offset to pass to read on.',
      inputSchema: {
        max_chars: z.number().int().min(200).max(20000).optional().describe('Maximum characters to return (200-20000, but a single call never returns more than about 3000).'),
        offset: z.number().int().min(0).optional().describe('Character position to start reading from, as named by the previous result.'),
      },
      handler: (a) => (a.offset === undefined ? session.browserExtract(a.max_chars) : session.browserExtract(a.max_chars, a.offset)),
    },
  ];

  if (!desktopTools) {
    for (let i = tools.length - 1; i >= 0; i -= 1) if (tools[i]!.name.startsWith('desktop_')) tools.splice(i, 1);
  }
  const byName = new Map(tools.map((t) => [t.name, t]));

  tools.push({
    name: 'computer_batch',
    description: !desktopTools
      ? 'Run several tool calls in one round trip, validating all steps first and stopping at the first failure. Browser ids are stable numbers, but for browser sequences and forms use browser_do instead: it takes several steps with the ids you already saw and stops when the page navigates. Returns per-step status and the final state.'
      : 'Run several tool calls in one round trip, validating all steps first and stopping at the first failure. Only DESKTOP indexes shift: every action re-reads the UI, so a desktop_click index refers to the desktop state AFTER the previous step, which you have not seen; typing and key presses can reshape the UI. Batch only desktop steps that do not need an index, with at most one desktop_click first or last. Browser ids are stable numbers, but for browser sequences and forms use browser_do instead: it takes several steps with the ids you already saw and stops when the page navigates. Returns per-step status and the final state.',
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
      // Desktop results list only what changed since the step before, so changes from earlier steps would be lost.
      const earlierChanges: string[] = [];
      let last = '';
      for (let i = 0; i < plan.length; i += 1) {
        const step = plan[i]!;
        const n = i + 1;
        try {
          if (isCallAborted()) throw new Error(`${ABANDONED}; remaining steps not run`);
          last = await step.tool.handler(step.args);
          if (i < plan.length - 1 && step.name.startsWith('desktop_')) {
            earlierChanges.push(...last.split('\n').filter((l) => /^[+~-] /.test(l)));
          }
        } catch (err: any) {
          const okSoFar = n === 1 ? 'no steps ok' : n === 2 ? 'step 1 ok' : `steps 1-${n - 1} ok`;
          const remaining = i < plan.length - 1 ? `; steps after ${n} not run` : '';
          throw new Error(`step ${n} ${step.name} failed: ${err?.message ?? err} (${okSoFar}${remaining})`);
        }
        lines.push(`step ${n} ${step.name} ok`);
      }
      const earlier = earlierChanges.length > 0 && last.includes('(same window)') ? ['changes during earlier steps:', ...earlierChanges] : [];
      return [...lines, ...earlier, last].join('\n');
    },
  });

  return tools;
}
