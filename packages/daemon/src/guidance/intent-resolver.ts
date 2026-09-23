import { AxWalker, type IndexedElement } from '../desktop/ax-walker.js';
import type { GuideStep } from './guidance-manager.js';

export interface IntentResolutionResult {
  steps: GuideStep[];
  confidence: number;
  source: 'exact_menu' | 'ax_element' | 'heuristic' | 'agent';
}

export class IntentResolver {
  private axWalker: AxWalker;

  constructor(axWalker?: AxWalker) {
    this.axWalker = axWalker || new AxWalker();
  }

  async resolve(query: string, activeApp: string): Promise<IntentResolutionResult> {
    const q = query.toLowerCase().trim();
    const app = activeApp || 'Desktop';

    try {
      const elements = await this.axWalker.walkActiveApp(app);
      const keywords = q
        .replace(/^(how to|where to|can you show me|show me|where is|how do i)\s+/i, '')
        .split(/\s+/)
        .filter((w) => w.length > 2);

      for (const el of elements) {
        const label = (el.label || '').toLowerCase();
        if (!label) continue;
        const matched = keywords.some((kw) => label.includes(kw));
        if (matched && el.bounds) {
          const [x, y, width, height] = el.bounds;
          return {
            source: 'ax_element',
            confidence: 0.95,
            steps: [
              {
                type: 'desktop',
                app,
                target: el.label,
                bounds: { x, y, width, height },
                text: `Click "${el.label}"`,
              },
            ],
          };
        }
      }
    } catch {}

    if (q.includes('upload') || q.includes('open') || q.includes('import')) {
      return {
        source: 'heuristic',
        confidence: 0.85,
        steps: [
          {
            type: 'desktop',
            app,
            target: 'File',
            text: 'Click "File" in top menu bar',
          },
          {
            type: 'desktop',
            app,
            target: 'Open',
            text: 'Select "Open..." or "Place Embedded..." to choose file',
          },
        ],
      };
    }

    if (q.includes('new') || q.includes('create')) {
      return {
        source: 'heuristic',
        confidence: 0.85,
        steps: [
          {
            type: 'desktop',
            app,
            target: 'File',
            text: 'Click "File" in top menu bar',
          },
          {
            type: 'desktop',
            app,
            target: 'New',
            text: 'Click "New..." to create a new document',
          },
        ],
      };
    }

    if (q.includes('export') || q.includes('save') || q.includes('png') || q.includes('jpeg')) {
      return {
        source: 'heuristic',
        confidence: 0.85,
        steps: [
          {
            type: 'desktop',
            app,
            target: 'File',
            text: 'Click "File" in top menu bar',
          },
          {
            type: 'desktop',
            app,
            target: 'Export',
            text: 'Select "Export" or "Save As..."',
          },
        ],
      };
    }

    if (q.includes('settings') || q.includes('preference')) {
      return {
        source: 'heuristic',
        confidence: 0.85,
        steps: [
          {
            type: 'desktop',
            app,
            target: app,
            text: `Click "${app}" menu item in application bar`,
          },
          {
            type: 'desktop',
            app,
            target: 'Settings',
            text: 'Click "Settings..." or "Preferences..."',
          },
        ],
      };
    }

    return {
      source: 'heuristic',
      confidence: 0.7,
      steps: [
        {
          type: 'desktop',
          app,
          target: app,
          text: `In ${app}: ${query}`,
        },
      ],
    };
  }
}
