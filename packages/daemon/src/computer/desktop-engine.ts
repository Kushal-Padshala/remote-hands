import { AxHelperError, type AxHelperPort, type AxSnapshot } from '../desktop/ax-helper.js';
import { buildView, renderDiff, type View } from '../desktop/ax-model.js';

/**
 * Native-app control on top of the rh-ax helper: a fast snapshot with stable ids, and (added next to it)
 * actions addressed by those ids. Every method answers `null` when the helper cannot serve, so the caller
 * can run the slower code it had before; real problems (no permission, no such app) are thrown as plain
 * messages for the model.
 */

export interface EngineSnapshot {
  app: string;
  snapshot: AxSnapshot;
  view: View;
}

const SNAPSHOT_TIMEOUT_MS = 15_000;
const MAX_NODES = 600;
const BUDGET_MS = 3000;

/** The helper's error codes that mean "use the slower path" rather than "tell the model". */
const FALLBACK_CODES = new Set(['unavailable', 'helper_exited', 'timeout']);

export function describeHelperError(err: AxHelperError, app: string): Error | null {
  if (FALLBACK_CODES.has(err.code)) return null;
  switch (err.code) {
    case 'not_trusted':
      return new Error(
        'Accessibility permission is missing for Remote Hands. Allow it in System Settings > Privacy & Security > Accessibility, then try again.',
      );
    case 'no_app':
      return new Error(app ? `No running app matches "${app}". Use desktop_open to start it.` : 'No app is in front.');
    case 'stale':
      return new Error('That element is no longer there. Call desktop_snapshot again.');
    default:
      return new Error(err.message || 'The accessibility helper reported an error.');
  }
}

export class DesktopEngine {
  private last: EngineSnapshot | null = null;

  constructor(private readonly helper: AxHelperPort) {}

  /** The most recent snapshot that was shown to the model. */
  current(): EngineSnapshot | null {
    return this.last;
  }

  async ready(): Promise<boolean> {
    return this.helper.ready();
  }

  /** Reads `app` (the front app when empty), remembers it, and returns what the model reads. Null: use the slower path. */
  async snapshot(app: string, opts: { filter?: string } = {}): Promise<string | null> {
    const taken = await this.read(app);
    if (!taken) return null;
    const view = buildView(taken.snapshot, opts.filter ? { filter: opts.filter } : {});
    // A filtered view hides lines, so the ids the model may use are those of the whole window.
    this.last = { app: taken.app, snapshot: taken.snapshot, view: opts.filter ? buildView(taken.snapshot) : view };
    return view.text;
  }

  /** Reads the window again without remembering it. Null: use the slower path. */
  async read(app: string): Promise<{ app: string; snapshot: AxSnapshot } | null> {
    if (!(await this.helper.ready())) return null;
    try {
      const snapshot = await this.helper.request<AxSnapshot>({ op: 'snapshot', app, maxNodes: MAX_NODES, budgetMs: BUDGET_MS }, SNAPSHOT_TIMEOUT_MS);
      return { app: snapshot.app.name || app, snapshot };
    } catch (err) {
      if (err instanceof AxHelperError) {
        const told = describeHelperError(err, app);
        if (told) throw told;
        return null;
      }
      throw err;
    }
  }

  /** What changed in the current window since `before`, or the whole window when that is shorter. */
  diff(before: View | null, after: View): string {
    return renderDiff(before, after);
  }
}
