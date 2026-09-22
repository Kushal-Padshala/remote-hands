import type { IndexedElement } from './ax-walker.js';
import { MacOsDriver, type ExecFunction } from './macos-driver.js';

export type MicroActionType = 'CLICK' | 'TYPE_TEXT' | 'KEY' | 'DONE';

export interface MicroDecision {
  action: MicroActionType;
  targetIndex?: number | undefined;
  text?: string | undefined;
  key?: string | undefined;
}

export interface DesktopActEngineOptions {
  driver?: MacOsDriver;
  exec?: ExecFunction;
}

function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class DesktopActEngine {
  public driver: MacOsDriver;

  constructor(optionsOrDriver?: DesktopActEngineOptions | MacOsDriver | ExecFunction) {
    if (!optionsOrDriver) {
      this.driver = new MacOsDriver();
    } else if (typeof optionsOrDriver === 'function') {
      this.driver = new MacOsDriver({ exec: optionsOrDriver });
    } else if ('openApp' in optionsOrDriver && typeof (optionsOrDriver as MacOsDriver).openApp === 'function') {
      this.driver = optionsOrDriver as MacOsDriver;
    } else if (typeof optionsOrDriver === 'object') {
      const opts = optionsOrDriver as DesktopActEngineOptions;
      if (opts.driver) {
        this.driver = opts.driver;
      } else if (opts.exec) {
        this.driver = new MacOsDriver({ exec: opts.exec });
      } else {
        this.driver = new MacOsDriver();
      }
    } else {
      this.driver = new MacOsDriver();
    }
  }

  matchHeuristic(goal: string, elements: IndexedElement[]): MicroDecision {
    const trimmed = goal.trim();

    if (/^(?:done|complete|completed|finish|finished|exit|stop|terminate)[\.\!]?$/i.test(trimmed)) {
      return { action: 'DONE' };
    }

    const typeQuotedMatch = trimmed.match(/^type\s+["']([^"']+)["'](?:\s+(?:in|into)\s+["']?(.+?)["']?)?$/i);
    const typeUnquotedWithField = !typeQuotedMatch
      ? trimmed.match(/^type\s+(.+?)\s+(?:in|into)\s+["']?(.+?)["']?$/i)
      : null;
    const typeSimple = !typeQuotedMatch && !typeUnquotedWithField
      ? trimmed.match(/^type\s+["']?([^"']+)["']?$/i)
      : null;

    if (typeQuotedMatch || typeUnquotedWithField || typeSimple) {
      const text = typeQuotedMatch
        ? typeQuotedMatch[1]!
        : typeUnquotedWithField
          ? typeUnquotedWithField[1]!.trim()
          : typeSimple![1]!.trim();
      const fieldDesc = typeQuotedMatch
        ? typeQuotedMatch[2]?.trim()
        : typeUnquotedWithField
          ? typeUnquotedWithField[2]!.trim()
          : undefined;

      let target: IndexedElement | undefined;
      if (fieldDesc) {
        const lowerField = fieldDesc.toLowerCase();
        target = elements.find(
          (e) =>
            (e.role === 'AXTextField' || e.role === 'AXTextArea') &&
            e.label.toLowerCase() === lowerField,
        );
        if (!target) {
          target = elements.find(
            (e) =>
              (e.role === 'AXTextField' || e.role === 'AXTextArea') &&
              (e.label.toLowerCase().includes(lowerField) || lowerField.includes(e.label.toLowerCase())),
          );
        }
        if (!target) {
          target = elements.find(
            (e) =>
              e.label.toLowerCase() === lowerField ||
              e.label.toLowerCase().includes(lowerField) ||
              lowerField.includes(e.label.toLowerCase()),
          );
        }
      }
      if (!target) {
        target = elements.find((e) => e.role === 'AXTextField' || e.role === 'AXTextArea');
      }

      return {
        action: 'TYPE_TEXT',
        targetIndex: target?.index,
        text,
      };
    }

    const pressMatch = trimmed.match(/^(?:press|hit)(?:\s+key)?\s+["']?([^"']+)["']?$/i);
    if (pressMatch) {
      const candidate = pressMatch[1]!.trim();
      const lowerCandidate = candidate.toLowerCase();
      const standardKeys = new Set([
        'enter',
        'return',
        'tab',
        'escape',
        'esc',
        'space',
        'backspace',
        'delete',
        'up',
        'down',
        'left',
        'right',
        'home',
        'end',
        'pageup',
        'pagedown',
      ]);
      const hasButtonMatch = elements.some(
        (e) =>
          e.label.toLowerCase() === lowerCandidate &&
          (e.role === 'AXButton' ||
            e.role === 'AXMenuItem' ||
            e.role === 'AXLink' ||
            e.role === 'AXCheckBox' ||
            e.role === 'AXRadioButton'),
      );
      if (!hasButtonMatch || standardKeys.has(lowerCandidate) || candidate.includes('+')) {
        return {
          action: 'KEY',
          key: candidate,
        };
      }
    }

    const clickMatch = trimmed.match(/^(?:click(?:\s+on)?|tap)\s+["']?(.+?)["']?$/i);
    if (clickMatch) {
      const targetDesc = clickMatch[1]!.trim();
      if (/^\[?(\d+)\]?$/.test(targetDesc)) {
        const idx = parseInt(targetDesc.replace(/[\[\]]/g, ''), 10);
        return {
          action: 'CLICK',
          targetIndex: idx,
        };
      }
      const lowerTarget = targetDesc.toLowerCase();
      let matched = elements.find((e) => e.label.toLowerCase() === lowerTarget);
      if (!matched) {
        const candidates = elements.filter(
          (e) =>
            e.label &&
            (e.label.toLowerCase().includes(lowerTarget) || lowerTarget.includes(e.label.toLowerCase())),
        );
        if (candidates.length > 0) {
          candidates.sort(
            (a, b) =>
              Math.abs(a.label.length - targetDesc.length) -
              Math.abs(b.label.length - targetDesc.length),
          );
          matched = candidates[0];
        }
      }
      return {
        action: 'CLICK',
        targetIndex: matched?.index,
      };
    }

    const lowerGoal = trimmed.toLowerCase();
    const matches = elements.filter((el) => el.label && lowerGoal.includes(el.label.toLowerCase()));
    if (matches.length > 0) {
      matches.sort((a, b) => b.label.length - a.label.length);
      return {
        action: 'CLICK',
        targetIndex: matches[0]!.index,
      };
    }

    return { action: 'DONE' };
  }

  async executeDecision(decision: MicroDecision, elements: IndexedElement[]): Promise<void> {
    if (decision.action === 'CLICK') {
      if (decision.targetIndex !== undefined) {
        const el = elements.find((e) => e.index === decision.targetIndex);
        if (el) {
          const cx = Math.round(el.bounds[0] + el.bounds[2] / 2);
          const cy = Math.round(el.bounds[1] + el.bounds[3] / 2);
          const script = `tell application "System Events"\n  click at {${cx}, ${cy}}\nend tell`;
          this.driver.exec('osascript', ['-e', script]);
        }
      }
    } else if (decision.action === 'TYPE_TEXT') {
      if (decision.targetIndex !== undefined) {
        const el = elements.find((e) => e.index === decision.targetIndex);
        if (el) {
          const cx = Math.round(el.bounds[0] + el.bounds[2] / 2);
          const cy = Math.round(el.bounds[1] + el.bounds[3] / 2);
          const clickScript = `tell application "System Events"\n  click at {${cx}, ${cy}}\nend tell`;
          this.driver.exec('osascript', ['-e', clickScript]);
        }
      }
      if (decision.text !== undefined) {
        const escaped = escapeAppleScript(decision.text);
        const script = `tell application "System Events"\n  keystroke "${escaped}"\nend tell`;
        this.driver.exec('osascript', ['-e', script]);
      }
    } else if (decision.action === 'KEY') {
      if (decision.key) {
        const keyStr = decision.key.trim();
        if (keyStr.includes('+')) {
          const parts = keyStr.split('+').map((p) => p.trim());
          const rawBase = parts[parts.length - 1] ?? '';
          const baseKey = rawBase.length === 1 ? rawBase.toLowerCase() : rawBase;
          const modParts = parts.slice(0, -1);
          const modifiers = modParts.map((m) => {
            const lower = m.toLowerCase();
            if (lower === 'cmd' || lower === 'command') return 'command';
            if (lower === 'ctrl' || lower === 'control') return 'control';
            if (lower === 'alt' || lower === 'opt' || lower === 'option') return 'option';
            if (lower === 'shift') return 'shift';
            return lower.replace(/\s+down$/, '');
          });
          await this.driver.sendKeyCombo([baseKey], modifiers);
        } else {
          const lower = keyStr.toLowerCase();
          const KEY_CODES: Record<string, number> = {
            return: 36,
            enter: 36,
            tab: 48,
            space: 49,
            delete: 51,
            backspace: 51,
            escape: 53,
            esc: 53,
            left: 123,
            right: 124,
            down: 125,
            up: 126,
          };
          if (KEY_CODES[lower] !== undefined) {
            const script = `tell application "System Events"\n  key code ${KEY_CODES[lower]}\nend tell`;
            this.driver.exec('osascript', ['-e', script]);
          } else {
            const escaped = escapeAppleScript(keyStr);
            const script = `tell application "System Events"\n  keystroke "${escaped}"\nend tell`;
            this.driver.exec('osascript', ['-e', script]);
          }
        }
      }
    }
  }

  async act(goal: string, elements: IndexedElement[]): Promise<MicroDecision> {
    const decision = this.matchHeuristic(goal, elements);
    await this.executeDecision(decision, elements);
    return decision;
  }
}
