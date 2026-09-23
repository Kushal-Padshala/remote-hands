# Unified Hybrid Guidance and Annotation Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a high-speed, unified browser and desktop visual guidance overlay system that renders animated arrows, spotlights, and step-by-step guidance over UI elements in Google Chrome and macOS native desktop applications.

**Architecture:** A client-side SVG mask and hardware-accelerated floating arrow script injected into Google Chrome via CDP (Driver.js-inspired), paired with a transparent native macOS AppKit overlay window (Glint-inspired) for desktop apps, orchestrated by a reactive step-advance guidance manager in the Remote Hands daemon and surfaced via `rh guide` CLI commands.

**Tech Stack:** TypeScript, Chrome DevTools Protocol (CDP), Node.js, SVG/CSS Transitions, AppKit/JXA / CoreAnimation, Vitest.

**Spec:** docs/superpowers/specs/2026-09-23-unified-hybrid-guidance-and-annotation-overlay-design.md

## Global Constraints
- Target macOS Darwin (ARM64/x64) and Google Chrome via CDP
- Zero external client dependencies (vanilla TS/SVG in browser, zero Chrome extension install required)
- Clean code, NO comments in source code, strict TypeScript, no broken APIs
- Frame transitions must be sub-100ms with cubic-bezier easing

---

### Task 1: Browser Injected Overlay Runtime & SVG Arrow Engine

**Files:**
- Create: `packages/daemon/src/guidance/browser-overlay-script.ts`
- Test: `packages/daemon/src/guidance/browser-overlay-script.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface GuideOverlayOptions {
    selector?: string;
    index?: number;
    text: string;
    step?: number;
    totalSteps?: number;
    arrowPosition?: 'top' | 'bottom' | 'left' | 'right' | 'auto';
  }
  export const BROWSER_OVERLAY_SCRIPT: string;
  export function generateShowGuideScript(options: GuideOverlayOptions): string;
  export function generateDismissGuideScript(): string;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/guidance/browser-overlay-script.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  BROWSER_OVERLAY_SCRIPT,
  generateShowGuideScript,
  generateDismissGuideScript,
} from './browser-overlay-script.js';

describe('Browser Overlay Script', () => {
  it('exports valid JavaScript runtime script', () => {
    expect(BROWSER_OVERLAY_SCRIPT).toBeDefined();
    expect(BROWSER_OVERLAY_SCRIPT).toContain('window.__rhGuide');
    expect(BROWSER_OVERLAY_SCRIPT).toContain('SVG_NS');
    expect(BROWSER_OVERLAY_SCRIPT).toContain('evenodd');
  });

  it('generates executable script for showGuide with selector', () => {
    const script = generateShowGuideScript({
      selector: 'button#upload',
      text: 'Click here to upload',
      step: 1,
      totalSteps: 3,
    });
    expect(script).toContain('window.__rhGuide.show');
    expect(script).toContain('button#upload');
    expect(script).toContain('Click here to upload');
    expect(script).toContain('step: 1');
    expect(script).toContain('totalSteps: 3');
  });

  it('generates executable script for showGuide with indexed element id', () => {
    const script = generateShowGuideScript({
      index: 5,
      text: 'Select file',
    });
    expect(script).toContain('window.__rhGuide.show');
    expect(script).toContain('index: 5');
    expect(script).toContain('Select file');
  });

  it('generates executable script for dismissGuide', () => {
    const script = generateDismissGuideScript();
    expect(script).toContain('window.__rhGuide.dismiss');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/guidance/browser-overlay-script.test.ts`
Expected: FAIL with "Cannot find module './browser-overlay-script.js'"

- [ ] **Step 3: Write minimal implementation**

Create `packages/daemon/src/guidance/browser-overlay-script.ts`:
```ts
export interface GuideOverlayOptions {
  selector?: string | undefined;
  index?: number | undefined;
  text: string;
  step?: number | undefined;
  totalSteps?: number | undefined;
  arrowPosition?: 'top' | 'bottom' | 'left' | 'right' | 'auto' | undefined;
}

export const BROWSER_OVERLAY_SCRIPT = `
(() => {
  if (window.__rhGuide) return;

  const SVG_NS = 'http://www.w3.org/2000/svg';

  class GuideOverlay {
    constructor() {
      this.container = null;
      this.svg = null;
      this.maskPath = null;
      this.arrow = null;
      this.card = null;
      this.targetEl = null;
      this.clickHandler = null;
      this.onScroll = this.updatePosition.bind(this);
      this.lastClicked = false;
    }

    init() {
      if (document.getElementById('__rh-guide-root')) {
        this.container = document.getElementById('__rh-guide-root');
        this.svg = this.container.querySelector('svg');
        this.maskPath = this.container.querySelector('.rh-mask-path');
        this.arrow = this.container.querySelector('.rh-guide-arrow');
        this.card = this.container.querySelector('.rh-guide-card');
        return;
      }

      this.container = document.createElement('div');
      this.container.id = '__rh-guide-root';
      this.container.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';

      const style = document.createElement('style');
      style.textContent = \`
        @keyframes rh-pulse {
          0% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7); }
          70% { box-shadow: 0 0 0 14px rgba(59, 130, 246, 0); }
          100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); }
        }
        @keyframes rh-float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-6px); }
        }
        .rh-guide-card {
          position: absolute;
          background: #0f172a;
          color: #f8fafc;
          padding: 10px 14px;
          border-radius: 10px;
          font-size: 13px;
          font-weight: 500;
          box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.1);
          pointer-events: auto;
          display: flex;
          align-items: center;
          gap: 8px;
          max-width: 320px;
          transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
          animation: rh-float 2.5s ease-in-out infinite;
        }
        .rh-guide-badge {
          background: #2563eb;
          color: #ffffff;
          padding: 2px 7px;
          border-radius: 9999px;
          font-size: 11px;
          font-weight: 700;
        }
        .rh-target-spotlight {
          position: absolute;
          border: 2px solid #3b82f6;
          border-radius: 6px;
          pointer-events: auto;
          cursor: pointer;
          animation: rh-pulse 2s infinite;
          transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .rh-arrow-svg {
          position: absolute;
          pointer-events: none;
          filter: drop-shadow(0 4px 6px rgba(0,0,0,0.3));
          transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }
      \`;
      this.container.appendChild(style);

      this.svg = document.createElementNS(SVG_NS, 'svg');
      this.svg.setAttribute('style', 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;');
      this.maskPath = document.createElementNS(SVG_NS, 'path');
      this.maskPath.setAttribute('fill', 'rgba(15, 23, 42, 0.55)');
      this.maskPath.setAttribute('fill-rule', 'evenodd');
      this.svg.appendChild(this.maskPath);
      this.container.appendChild(this.svg);

      this.spotlight = document.createElement('div');
      this.spotlight.className = 'rh-target-spotlight';
      this.container.appendChild(this.spotlight);

      this.arrow = document.createElement('div');
      this.arrow.className = 'rh-arrow-svg';
      this.arrow.innerHTML = \`<svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M12 4L12 20M12 20L5 13M12 20L19 13" stroke="#3b82f6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>\`;
      this.container.appendChild(this.arrow);

      this.card = document.createElement('div');
      this.card.className = 'rh-guide-card';
      this.container.appendChild(this.card);

      document.body.appendChild(this.container);
      window.addEventListener('scroll', this.onScroll, { passive: true });
      window.addEventListener('resize', this.onScroll, { passive: true });
    }

    resolveTarget(options) {
      if (options.selector) {
        return document.querySelector(options.selector);
      }
      if (options.index !== undefined) {
        if (window.__rhFast && window.__rhFast.nodes) {
          const node = window.__rhFast.nodes.get(options.index);
          if (node) return node;
        }
        const buttons = Array.from(document.querySelectorAll('a[href],button,input,textarea,select,summary,[contenteditable="true"]'));
        if (buttons[options.index]) return buttons[options.index];
      }
      return null;
    }

    show(options) {
      this.init();
      this.lastClicked = false;
      const el = this.resolveTarget(options);
      if (!el) {
        return { success: false, error: 'Target element not found' };
      }
      this.targetEl = el;

      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });

      if (this.clickHandler && this.targetEl) {
        this.targetEl.removeEventListener('click', this.clickHandler, true);
      }
      this.clickHandler = () => {
        this.lastClicked = true;
      };
      el.addEventListener('click', this.clickHandler, { once: true, capture: true });

      const stepText = options.step ? \`<span class="rh-guide-badge">\${options.step}\${options.totalSteps ? '/' + options.totalSteps : ''}</span>\` : '';
      this.card.innerHTML = \`\${stepText}<span>\${options.text || ''}</span>\`;

      setTimeout(() => this.updatePosition(), 50);
      return { success: true };
    }

    updatePosition() {
      if (!this.targetEl || !this.container) return;
      const rect = this.targetEl.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const pad = 6;
      const x = Math.max(0, rect.left - pad);
      const y = Math.max(0, rect.top - pad);
      const w = rect.width + pad * 2;
      const h = rect.height + pad * 2;

      this.maskPath.setAttribute('d', \`M 0 0 L \${vw} 0 L \${vw} \${vh} L 0 \${vh} Z M \${x} \${y} L \${x} \${y + h} L \${x + w} \${y + h} L \${x + w} \${y} Z\`);

      this.spotlight.style.left = \`\${x}px\`;
      this.spotlight.style.top = \`\${y}px\`;
      this.spotlight.style.width = \`\${w}px\`;
      this.spotlight.style.height = \`\${h}px\`;

      const cardRect = this.card.getBoundingClientRect();
      let cardX = x + (w / 2) - (cardRect.width / 2);
      let cardY = y - cardRect.height - 42;
      let arrowX = x + (w / 2) - 16;
      let arrowY = y - 36;
      let arrowRot = 0;

      if (cardY < 10) {
        cardY = y + h + 42;
        arrowY = y + h + 8;
        arrowRot = 180;
      }
      if (cardX < 10) cardX = 10;
      if (cardX + cardRect.width > vw - 10) cardX = vw - cardRect.width - 10;

      this.card.style.transform = \`translate3d(\${cardX}px, \${cardY}px, 0)\`;
      this.arrow.style.transform = \`translate3d(\${arrowX}px, \${arrowY}px, 0) rotate(\${arrowRot}deg)\`;
    }

    dismiss() {
      if (this.container && this.container.parentNode) {
        this.container.parentNode.removeChild(this.container);
      }
      if (this.targetEl && this.clickHandler) {
        this.targetEl.removeEventListener('click', this.clickHandler, true);
      }
      window.removeEventListener('scroll', this.onScroll);
      window.removeEventListener('resize', this.onScroll);
      this.container = null;
      this.targetEl = null;
      this.lastClicked = false;
      return { success: true };
    }

    wasClicked() {
      return this.lastClicked;
    }
  }

  window.__rhGuide = new GuideOverlay();
})();
`;

export function generateShowGuideScript(options: GuideOverlayOptions): string {
  const jsonOptions = JSON.stringify(options);
  return `${BROWSER_OVERLAY_SCRIPT}; window.__rhGuide.show(${jsonOptions});`;
}

export function generateDismissGuideScript(): string {
  return `${BROWSER_OVERLAY_SCRIPT}; window.__rhGuide.dismiss();`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/guidance/browser-overlay-script.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/guidance/browser-overlay-script.ts packages/daemon/src/guidance/browser-overlay-script.test.ts
git commit -m "feat(daemon): implement client-side browser guidance overlay script and svg arrow engine"
```

---

### Task 2: Daemon Browser Guidance Controller via Chrome CDP

**Files:**
- Create: `packages/daemon/src/guidance/browser-guidance.ts`
- Test: `packages/daemon/src/guidance/browser-guidance.test.ts`

**Interfaces:**
- Consumes: `BrowserDriver` from `../browser-driver.js`, `GuideOverlayOptions`, `generateShowGuideScript`, `generateDismissGuideScript` from `./browser-overlay-script.js`
- Produces:
  ```ts
  export interface GuideShowResult {
    success: boolean;
    error?: string;
  }
  export class BrowserGuidanceController {
    constructor(driver?: BrowserDriver);
    show(options: GuideOverlayOptions): Promise<GuideShowResult>;
    dismiss(): Promise<void>;
    checkClicked(): Promise<boolean>;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/guidance/browser-guidance.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserGuidanceController } from './browser-guidance.js';

describe('BrowserGuidanceController', () => {
  let mockDriver: any;
  let controller: BrowserGuidanceController;

  beforeEach(() => {
    mockDriver = {
      executeScript: vi.fn(),
    };
    controller = new BrowserGuidanceController(mockDriver);
  });

  it('invokes driver executeScript with generated show script', async () => {
    mockDriver.executeScript.mockResolvedValue({ success: true });
    const res = await controller.show({
      selector: 'button#submit',
      text: 'Submit form',
      step: 1,
      totalSteps: 2,
    });
    expect(res.success).toBe(true);
    expect(mockDriver.executeScript).toHaveBeenCalledTimes(1);
    expect(mockDriver.executeScript.mock.calls[0][0]).toContain('window.__rhGuide.show');
    expect(mockDriver.executeScript.mock.calls[0][0]).toContain('button#submit');
  });

  it('invokes driver executeScript for dismiss', async () => {
    mockDriver.executeScript.mockResolvedValue({ success: true });
    await controller.dismiss();
    expect(mockDriver.executeScript).toHaveBeenCalledTimes(1);
    expect(mockDriver.executeScript.mock.calls[0][0]).toContain('window.__rhGuide.dismiss');
  });

  it('checks if target element was clicked by user', async () => {
    mockDriver.executeScript.mockResolvedValue(true);
    const clicked = await controller.checkClicked();
    expect(clicked).toBe(true);
    expect(mockDriver.executeScript.mock.calls[0][0]).toContain('window.__rhGuide.wasClicked()');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/guidance/browser-guidance.test.ts`
Expected: FAIL with "Cannot find module './browser-guidance.js'"

- [ ] **Step 3: Write minimal implementation**

Create `packages/daemon/src/guidance/browser-guidance.ts`:
```ts
import { BrowserDriver } from '../browser-driver.js';
import {
  type GuideOverlayOptions,
  generateShowGuideScript,
  generateDismissGuideScript,
} from './browser-overlay-script.js';

export interface GuideShowResult {
  success: boolean;
  error?: string | undefined;
}

export class BrowserGuidanceController {
  private driver: BrowserDriver;

  constructor(driver?: BrowserDriver) {
    this.driver = driver || new BrowserDriver();
  }

  async show(options: GuideOverlayOptions): Promise<GuideShowResult> {
    const script = generateShowGuideScript(options);
    try {
      const result = await (this.driver as any).executeScript(script);
      if (result && typeof result === 'object' && result.success === false) {
        return { success: false, error: result.error || 'Failed to highlight target element' };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  }

  async dismiss(): Promise<void> {
    const script = generateDismissGuideScript();
    try {
      await (this.driver as any).executeScript(script);
    } catch {}
  }

  async checkClicked(): Promise<boolean> {
    try {
      const res = await (this.driver as any).executeScript(
        'window.__rhGuide ? Boolean(window.__rhGuide.wasClicked()) : false'
      );
      return Boolean(res);
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/guidance/browser-guidance.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/guidance/browser-guidance.ts packages/daemon/src/guidance/browser-guidance.test.ts
git commit -m "feat(daemon): implement browser guidance controller via cdp websocket"
```

---

### Task 3: Desktop Screen Overlay Controller for macOS Native Applications

**Files:**
- Create: `packages/daemon/src/guidance/desktop-overlay.ts`
- Test: `packages/daemon/src/guidance/desktop-overlay.test.ts`

**Interfaces:**
- Consumes: `MacOsDriver` from `../desktop/macos-driver.js`, `AxWalker` from `../desktop/ax-walker.js`
- Produces:
  ```ts
  export interface DesktopGuideOptions {
    app?: string;
    target?: string;
    text: string;
    bounds?: { x: number; y: number; width: number; height: number };
    step?: number;
    totalSteps?: number;
  }
  export class DesktopOverlayController {
    constructor(macosDriver?: MacOsDriver, axWalker?: AxWalker);
    show(options: DesktopGuideOptions): Promise<{ success: boolean; bounds?: any; error?: string }>;
    dismiss(): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/guidance/desktop-overlay.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DesktopOverlayController } from './desktop-overlay.js';

describe('DesktopOverlayController', () => {
  let mockDriver: any;
  let mockAxWalker: any;
  let controller: DesktopOverlayController;

  beforeEach(() => {
    mockDriver = {
      exec: vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 }),
    };
    mockAxWalker = {
      snapshot: vi.fn(),
    };
    controller = new DesktopOverlayController(mockDriver, mockAxWalker);
  });

  it('resolves element bounds via AX walker and renders overlay', async () => {
    mockAxWalker.snapshot.mockResolvedValue({
      app: 'Finder',
      elements: [
        {
          index: 0,
          role: 'AXButton',
          title: 'Upload',
          bounds: { x: 200, y: 150, width: 80, height: 32 },
        },
      ],
    });

    const res = await controller.show({
      app: 'Finder',
      target: 'Upload',
      text: 'Click Upload button',
      step: 1,
    });

    expect(res.success).toBe(true);
    expect(res.bounds).toEqual({ x: 200, y: 150, width: 80, height: 32 });
    expect(mockDriver.exec).toHaveBeenCalled();
  });

  it('uses direct bounds when provided without needing AX lookup', async () => {
    const res = await controller.show({
      bounds: { x: 100, y: 100, width: 50, height: 50 },
      text: 'Target area',
    });

    expect(res.success).toBe(true);
    expect(mockAxWalker.snapshot).not.toHaveBeenCalled();
    expect(mockDriver.exec).toHaveBeenCalled();
  });

  it('dismisses active desktop overlay cleanly', async () => {
    await controller.dismiss();
    expect(mockDriver.exec).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/guidance/desktop-overlay.test.ts`
Expected: FAIL with "Cannot find module './desktop-overlay.js'"

- [ ] **Step 3: Write minimal implementation**

Create `packages/daemon/src/guidance/desktop-overlay.ts`:
```ts
import { MacOsDriver } from '../desktop/macos-driver.js';
import { AxWalker } from '../desktop/ax-walker.js';

export interface DesktopBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopGuideOptions {
  app?: string | undefined;
  target?: string | undefined;
  text: string;
  bounds?: DesktopBounds | undefined;
  step?: number | undefined;
  totalSteps?: number | undefined;
}

export class DesktopOverlayController {
  private driver: MacOsDriver;
  private axWalker: AxWalker;
  private isActive = false;

  constructor(driver?: MacOsDriver, axWalker?: AxWalker) {
    this.driver = driver || new MacOsDriver();
    this.axWalker = axWalker || new AxWalker(this.driver);
  }

  async show(options: DesktopGuideOptions): Promise<{ success: boolean; bounds?: DesktopBounds | undefined; error?: string | undefined }> {
    let targetBounds = options.bounds;

    if (!targetBounds && options.app && options.target) {
      try {
        const snap = await this.axWalker.snapshot(options.app);
        const match = snap.elements.find(
          (el) =>
            el.bounds &&
            (el.title.toLowerCase().includes(options.target!.toLowerCase()) ||
              el.description.toLowerCase().includes(options.target!.toLowerCase()))
        );
        if (match && match.bounds) {
          targetBounds = match.bounds;
        }
      } catch (err: any) {
        return { success: false, error: `Failed to inspect app: ${err?.message || String(err)}` };
      }
    }

    if (!targetBounds) {
      return { success: false, error: 'Target element or bounds not found' };
    }

    const { x, y, width, height } = targetBounds;
    const arrowX = Math.round(x + width / 2);
    const arrowY = Math.round(y);
    const label = `${options.step ? `[${options.step}] ` : ''}${options.text}`;

    const script = `
      ObjC.import('Cocoa');
      const app = $.NSApplication.sharedApplication;
      app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);

      if ($.__rhDesktopOverlay) {
        try { $.__rhDesktopOverlay.close(); } catch(e) {}
      }

      const screenRect = $.NSScreen.mainScreen.frame;
      const screenH = screenRect.size.height;
      const windowRect = $.NSMakeRect(0, 0, screenRect.size.width, screenH);

      const panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
        windowRect,
        $.NSWindowStyleMaskBorderless | $.NSWindowStyleMaskNonactivatingPanel,
        $.NSBackingStoreBuffered,
        false
      );

      panel.setOpaque(false);
      panel.setBackgroundColor($.NSColor.clearColor);
      panel.setLevel($.NSFloatingWindowLevel);
      panel.setIgnoresMouseEvents(true);
      panel.setCollectionBehavior($.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorFullScreenAuxiliary);

      const view = $.NSView.alloc.initWithFrame(windowRect);
      view.setWantsLayer(true);

      const targetLayer = $.CALayer.layer;
      targetLayer.frame = $.CGRectMake(${x}, screenH - ${y + height}, ${width}, ${height});
      targetLayer.borderColor = $.NSColor.colorWithRedGreenBlueAlpha(0.23, 0.51, 0.96, 1.0).CGColor;
      targetLayer.borderWidth = 3;
      targetLayer.cornerRadius = 6;
      view.layer.addSublayer(targetLayer);

      panel.setContentView(view);
      panel.orderFrontRegardless();
      $.__rhDesktopOverlay = panel;
    `;

    this.driver.exec('osascript', ['-l', 'JavaScript', '-e', script]);
    this.isActive = true;
    return { success: true, bounds: targetBounds };
  }

  async dismiss(): Promise<void> {
    const script = `
      ObjC.import('Cocoa');
      if ($.__rhDesktopOverlay) {
        try {
          $.__rhDesktopOverlay.close();
          $.__rhDesktopOverlay = null;
        } catch(e) {}
      }
    `;
    this.driver.exec('osascript', ['-l', 'JavaScript', '-e', script]);
    this.isActive = false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/guidance/desktop-overlay.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/guidance/desktop-overlay.ts packages/daemon/src/guidance/desktop-overlay.test.ts
git commit -m "feat(daemon): implement native macos desktop screen overlay and accessibility bounds targeting"
```

---

### Task 4: Reactive Guidance Orchestrator & Session State Machine

**Files:**
- Create: `packages/daemon/src/guidance/guidance-manager.ts`
- Test: `packages/daemon/src/guidance/guidance-manager.test.ts`

**Interfaces:**
- Consumes: `BrowserGuidanceController` from `./browser-guidance.js`, `DesktopOverlayController` from `./desktop-overlay.js`
- Produces:
  ```ts
  export interface GuideStep {
    type: 'browser' | 'desktop';
    target?: string;
    index?: number;
    app?: string;
    text: string;
  }
  export interface GuidanceSession {
    id: string;
    currentStepIndex: number;
    steps: GuideStep[];
    active: boolean;
  }
  export class GuidanceManager {
    constructor(browserGuide?: BrowserGuidanceController, desktopOverlay?: DesktopOverlayController);
    startSession(steps: GuideStep[]): Promise<GuidanceSession>;
    next(): Promise<GuidanceSession | null>;
    dismiss(): Promise<void>;
    getStatus(): GuidanceSession | null;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/guidance/guidance-manager.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GuidanceManager, type GuideStep } from './guidance-manager.js';

describe('GuidanceManager', () => {
  let mockBrowserGuide: any;
  let mockDesktopOverlay: any;
  let manager: GuidanceManager;

  const testSteps: GuideStep[] = [
    { type: 'browser', selector: 'button#new', text: 'Click New' },
    { type: 'browser', selector: 'input#file', text: 'Select File' },
  ];

  beforeEach(() => {
    mockBrowserGuide = {
      show: vi.fn().mockResolvedValue({ success: true }),
      dismiss: vi.fn().mockResolvedValue(undefined),
    };
    mockDesktopOverlay = {
      show: vi.fn().mockResolvedValue({ success: true }),
      dismiss: vi.fn().mockResolvedValue(undefined),
    };
    manager = new GuidanceManager(mockBrowserGuide, mockDesktopOverlay);
  });

  it('starts a multi-step guidance session and shows first step', async () => {
    const session = await manager.startSession(testSteps);
    expect(session.active).toBe(true);
    expect(session.currentStepIndex).toBe(0);
    expect(session.steps.length).toBe(2);
    expect(mockBrowserGuide.show).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'button#new', text: 'Click New', step: 1, totalSteps: 2 })
    );
  });

  it('advances to next step smoothly', async () => {
    await manager.startSession(testSteps);
    const nextSession = await manager.next();
    expect(nextSession?.currentStepIndex).toBe(1);
    expect(mockBrowserGuide.show).toHaveBeenCalledTimes(2);
    expect(mockBrowserGuide.show).toHaveBeenLastCalledWith(
      expect.objectContaining({ selector: 'input#file', text: 'Select File', step: 2, totalSteps: 2 })
    );
  });

  it('completes session and dismisses on advancing past last step', async () => {
    await manager.startSession(testSteps);
    await manager.next();
    const finalSession = await manager.next();
    expect(finalSession).toBeNull();
    expect(manager.getStatus()).toBeNull();
    expect(mockBrowserGuide.dismiss).toHaveBeenCalled();
  });

  it('dismisses active session explicitly', async () => {
    await manager.startSession(testSteps);
    await manager.dismiss();
    expect(manager.getStatus()).toBeNull();
    expect(mockBrowserGuide.dismiss).toHaveBeenCalled();
    expect(mockDesktopOverlay.dismiss).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/guidance/guidance-manager.test.ts`
Expected: FAIL with "Cannot find module './guidance-manager.js'"

- [ ] **Step 3: Write minimal implementation**

Create `packages/daemon/src/guidance/guidance-manager.ts`:
```ts
import { BrowserGuidanceController } from './browser-guidance.js';
import { DesktopOverlayController } from './desktop-overlay.js';

export interface GuideStep {
  type: 'browser' | 'desktop';
  selector?: string | undefined;
  index?: number | undefined;
  app?: string | undefined;
  target?: string | undefined;
  text: string;
}

export interface GuidanceSession {
  id: string;
  currentStepIndex: number;
  steps: GuideStep[];
  active: boolean;
}

export class GuidanceManager {
  private browserGuide: BrowserGuidanceController;
  private desktopOverlay: DesktopOverlayController;
  private currentSession: GuidanceSession | null = null;

  constructor(
    browserGuide?: BrowserGuidanceController,
    desktopOverlay?: DesktopOverlayController
  ) {
    this.browserGuide = browserGuide || new BrowserGuidanceController();
    this.desktopOverlay = desktopOverlay || new DesktopOverlayController();
  }

  async startSession(steps: GuideStep[]): Promise<GuidanceSession> {
    if (steps.length === 0) {
      throw new Error('Guidance session requires at least one step');
    }
    await this.dismiss();

    this.currentSession = {
      id: `guide-${Date.now()}`,
      currentStepIndex: 0,
      steps,
      active: true,
    };

    await this.renderCurrentStep();
    return this.currentSession;
  }

  private async renderCurrentStep(): Promise<void> {
    if (!this.currentSession || !this.currentSession.active) return;
    const step = this.currentSession.steps[this.currentSession.currentStepIndex];
    if (!step) return;

    const stepNum = this.currentSession.currentStepIndex + 1;
    const total = this.currentSession.steps.length;

    if (step.type === 'browser') {
      await this.desktopOverlay.dismiss();
      await this.browserGuide.show({
        selector: step.selector,
        index: step.index,
        text: step.text,
        step: stepNum,
        totalSteps: total,
      });
    } else {
      await this.browserGuide.dismiss();
      await this.desktopOverlay.show({
        app: step.app,
        target: step.target,
        text: step.text,
        step: stepNum,
        totalSteps: total,
      });
    }
  }

  async next(): Promise<GuidanceSession | null> {
    if (!this.currentSession || !this.currentSession.active) return null;
    this.currentSession.currentStepIndex++;
    if (this.currentSession.currentStepIndex >= this.currentSession.steps.length) {
      await this.dismiss();
      return null;
    }
    await this.renderCurrentStep();
    return this.currentSession;
  }

  async dismiss(): Promise<void> {
    this.currentSession = null;
    await Promise.all([
      this.browserGuide.dismiss(),
      this.desktopOverlay.dismiss(),
    ]);
  }

  getStatus(): GuidanceSession | null {
    return this.currentSession;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/guidance/guidance-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/guidance/guidance-manager.ts packages/daemon/src/guidance/guidance-manager.test.ts
git commit -m "feat(daemon): implement guidance manager orchestrator and multi-step state machine"
```

---

### Task 5: CLI Command Suite (`rh guide`) & Daemon Integration

**Files:**
- Create: `packages/cli/src/commands/guide.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/src/commands/guide.test.ts`

**Interfaces:**
- Consumes: `BrowserGuidanceController`, `DesktopOverlayController`, `GuidanceManager`
- Produces: `guideCommand(argv: string[]): Promise<void>` registered in `packages/cli/src/index.ts` under `guide`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/commands/guide.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeGuideCommand } from './guide.js';

describe('CLI guide command', () => {
  let mockManager: any;
  let logSpy: any;
  let errorSpy: any;

  beforeEach(() => {
    mockManager = {
      startSession: vi.fn().mockResolvedValue({ id: 'g1', currentStepIndex: 0, steps: [{}], active: true }),
      next: vi.fn().mockResolvedValue({ id: 'g1', currentStepIndex: 1, steps: [{}, {}], active: true }),
      dismiss: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue(null),
    };
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('handles show command with browser selector', async () => {
    await executeGuideCommand(['show', '--browser', '--target=button#upload', '--text=Click upload'], mockManager);
    expect(mockManager.startSession).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'browser', selector: 'button#upload', text: 'Click upload' }),
    ]);
  });

  it('handles show command with snapshot index', async () => {
    await executeGuideCommand(['show', '--browser', '--index=4', '--text=Choose File'], mockManager);
    expect(mockManager.startSession).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'browser', index: 4, text: 'Choose File' }),
    ]);
  });

  it('handles next command', async () => {
    await executeGuideCommand(['next'], mockManager);
    expect(mockManager.next).toHaveBeenCalled();
  });

  it('handles dismiss command', async () => {
    await executeGuideCommand(['dismiss'], mockManager);
    expect(mockManager.dismiss).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/src/commands/guide.test.ts`
Expected: FAIL with "Cannot find module './guide.js'"

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/commands/guide.ts`:
```ts
import { GuidanceManager, type GuideStep } from '@remote-hands/daemon/guidance/guidance-manager.js';

let sharedManager: GuidanceManager | null = null;

function getSharedManager(): GuidanceManager {
  if (!sharedManager) {
    sharedManager = new GuidanceManager();
  }
  return sharedManager;
}

export async function executeGuideCommand(args: string[], manager: GuidanceManager = getSharedManager()): Promise<void> {
  const subcommand = args[0] || 'status';

  if (subcommand === 'dismiss') {
    await manager.dismiss();
    console.log('✓ Visual guidance dismissed');
    return;
  }

  if (subcommand === 'next') {
    const session = await manager.next();
    if (session) {
      console.log(`✓ Advanced to step ${session.currentStepIndex + 1} of ${session.steps.length}`);
    } else {
      console.log('✓ Guidance session completed and dismissed');
    }
    return;
  }

  if (subcommand === 'status') {
    const status = manager.getStatus();
    if (status) {
      console.log(`Active guidance session: Step ${status.currentStepIndex + 1} of ${status.steps.length}`);
    } else {
      console.log('No active guidance session');
    }
    return;
  }

  if (subcommand === 'show') {
    let isDesktop = false;
    let target = '';
    let app = '';
    let index: number | undefined;
    let text = '';

    for (let i = 1; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--desktop') isDesktop = true;
      else if (arg === '--browser') isDesktop = false;
      else if (arg.startsWith('--target=')) target = arg.slice(9);
      else if (arg.startsWith('--app=')) app = arg.slice(6);
      else if (arg.startsWith('--index=')) index = parseInt(arg.slice(8), 10);
      else if (arg.startsWith('--text=')) text = arg.slice(7);
      else if (!text && !arg.startsWith('--')) text = arg;
    }

    const step: GuideStep = {
      type: isDesktop ? 'desktop' : 'browser',
      text: text || 'Click here',
      selector: target || undefined,
      index,
      app: app || undefined,
      target: target || undefined,
    };

    await manager.startSession([step]);
    console.log(`✓ Pointing arrow to ${isDesktop ? 'desktop element' : 'browser element'}: "${step.text}"`);
    return;
  }

  console.error(`Unknown guide subcommand: ${subcommand}`);
}
```

Update `packages/cli/src/index.ts` to register `guide`:
```ts
// in command routing:
case 'guide':
  const { executeGuideCommand } = await import('./commands/guide.js');
  await executeGuideCommand(args.slice(1));
  break;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/cli/src/commands/guide.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/guide.ts packages/cli/src/commands/guide.test.ts packages/cli/src/index.ts
git commit -m "feat(cli): introduce rh guide commands for step-by-step visual pointing"
```

---

### Task 6: Agent System Prompt & Automated Guidance Flow Integration

**Files:**
- Modify: `packages/daemon/src/agy-runner.ts`
- Test: `packages/daemon/src/agy-runner.test.ts`

**Interfaces:**
- Updates `DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT` and `DEFAULT_REMOTE_HANDS_REMINDER` to include visual guidance commands:
  - `rh guide show --browser --index=<index> --text="<label>"`
  - `rh guide show --desktop --app="<app>" --target="<target>" --text="<label>"`
  - `rh guide next`
  - `rh guide dismiss`

- [ ] **Step 1: Write the failing test**

In `packages/daemon/src/agy-runner.test.ts`, add:
```ts
it('includes rh guide commands in system prompt and reminder', () => {
  expect(DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT).toContain('rh guide show');
  expect(DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT).toContain('--browser');
  expect(DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT).toContain('--desktop');
  expect(DEFAULT_REMOTE_HANDS_REMINDER).toContain('rh guide show');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/agy-runner.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Update `DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT` and `DEFAULT_REMOTE_HANDS_REMINDER` in `packages/daemon/src/agy-runner.ts`:
Add Section 3b:
```ts
'   - Interactive Visual Guidance & Annotation Overlays:\n' +
'     When the user asks "how do I...", "where do I click...", "guide me to...", or "show me where to...":\n' +
'     DO NOT click the button autonomously. Instead, inspect the page (`rh browser snapshot` or `rh desktop snapshot`) and project an interactive visual arrow over the target button:\n' +
'     rh guide show --browser --index=<index> --text="Click here to upload"\n' +
'     rh guide show --desktop --app="<app>" --target="<button>" --text="<label>"\n' +
'     rh guide next\n' +
'     rh guide dismiss\n'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/daemon/src/agy-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/agy-runner.ts packages/daemon/src/agy-runner.test.ts
git commit -m "feat(daemon): equip agy agent with visual guidance and annotation overlay commands"
```
