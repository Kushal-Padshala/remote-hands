export interface GuideOverlayOptions {
  selector?: string | undefined;
  index?: number | undefined;
  text: string;
  step?: number | undefined;
  totalSteps?: number | undefined;
  arrowPosition?: "top" | "bottom" | "left" | "right" | "auto" | undefined;
}

export const BROWSER_OVERLAY_SCRIPT = `
(() => {
  if (window.__rhGuide) return;

  const SVG_NS = "http://www.w3.org/2000/svg";

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
      if (document.getElementById("__rh-guide-root")) {
        this.container = document.getElementById("__rh-guide-root");
        this.svg = this.container.querySelector("svg");
        this.maskPath = this.container.querySelector(".rh-mask-path");
        this.arrow = this.container.querySelector(".rh-guide-arrow") || this.container.querySelector(".rh-arrow-svg");
        this.card = this.container.querySelector(".rh-guide-card");
        this.spotlight = this.container.querySelector(".rh-target-spotlight");
        return;
      }

      this.container = document.createElement("div");
      this.container.id = "__rh-guide-root";
      this.container.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;";

      const style = document.createElement("style");
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
          pointer-events: none;
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

      this.svg = document.createElementNS(SVG_NS, "svg");
      this.svg.setAttribute("style", "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;");
      this.maskPath = document.createElementNS(SVG_NS, "path");
      this.maskPath.setAttribute("class", "rh-mask-path");
      this.maskPath.setAttribute("fill", "rgba(15, 23, 42, 0.55)");
      this.maskPath.setAttribute("fill-rule", "evenodd");
      this.svg.appendChild(this.maskPath);
      this.container.appendChild(this.svg);

      this.spotlight = document.createElement("div");
      this.spotlight.className = "rh-target-spotlight";
      this.container.appendChild(this.spotlight);

      this.arrow = document.createElement("div");
      this.arrow.className = "rh-arrow-svg rh-guide-arrow";
      this.arrow.innerHTML = \`<svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M12 4L12 20M12 20L5 13M12 20L19 13" stroke="#3b82f6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>\`;
      this.container.appendChild(this.arrow);

      this.card = document.createElement("div");
      this.card.className = "rh-guide-card";
      this.container.appendChild(this.card);

      document.body.appendChild(this.container);
      window.addEventListener("scroll", this.onScroll, { passive: true });
      window.addEventListener("resize", this.onScroll, { passive: true });
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
        const buttons = Array.from(document.querySelectorAll("a[href],button,input,textarea,select,summary,[contenteditable=\"true\"]"));
        if (buttons[options.index]) return buttons[options.index];
      }
      return null;
    }

    show(options) {
      this.init();
      this.currentOptions = options;
      this.lastClicked = false;
      const el = this.resolveTarget(options);
      if (!el) {
        return { success: false, error: "Target element not found" };
      }
      this.targetEl = el;

      el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });

      if (this.clickHandler && this.targetEl) {
        this.targetEl.removeEventListener("click", this.clickHandler, true);
      }
      this.clickHandler = () => {
        this.lastClicked = true;
      };
      el.addEventListener("click", this.clickHandler, { once: true, capture: true });

      const stepText = options.step ? \`<span class="rh-guide-badge">\\\${options.step}\\\${options.totalSteps ? "/" + options.totalSteps : ""}</span>\` : "";
      this.card.innerHTML = \`\\\${stepText}<span>\\\${options.text || ""}</span>\`;

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

      this.maskPath.setAttribute("d", \`M 0 0 L \\\${vw} 0 L \\\${vw} \\\${vh} L 0 \\\${vh} Z M \\\${x} \\\${y} L \\\${x} \\\${y + h} L \\\${x + w} \\\${y + h} L \\\${x + w} \\\${y} Z\`);

      this.spotlight.style.left = \`\\\${x}px\`;
      this.spotlight.style.top = \`\\\${y}px\`;
      this.spotlight.style.width = \`\\\${w}px\`;
      this.spotlight.style.height = \`\\\${h}px\`;

      const cardRect = this.card.getBoundingClientRect();
      const pos = (this.currentOptions && this.currentOptions.arrowPosition) || "auto";

      let cardX = x + (w / 2) - (cardRect.width / 2);
      let cardY = y - cardRect.height - 42;
      let arrowX = x + (w / 2) - 16;
      let arrowY = y - 36;
      let arrowRot = 0;

      if (pos === "bottom" || (pos === "auto" && cardY < 10)) {
        cardY = y + h + 42;
        arrowY = y + h + 8;
        arrowRot = 180;
      } else if (pos === "right") {
        cardX = x + w + 42;
        cardY = y + (h / 2) - (cardRect.height / 2);
        arrowX = x + w + 8;
        arrowY = y + (h / 2) - 16;
        arrowRot = 90;
      } else if (pos === "left") {
        cardX = x - cardRect.width - 42;
        cardY = y + (h / 2) - (cardRect.height / 2);
        arrowX = x - 36;
        arrowY = y + (h / 2) - 16;
        arrowRot = 270;
      }

      if (cardX < 10) cardX = 10;
      if (cardX + cardRect.width > vw - 10) cardX = vw - cardRect.width - 10;

      this.card.style.transform = \`translate3d(\\\${cardX}px, \\\${cardY}px, 0)\`;
      this.arrow.style.transform = \`translate3d(\\\${arrowX}px, \\\${arrowY}px, 0) rotate(\\\${arrowRot}deg)\`;
    }

    dismiss() {
      if (this.container && this.container.parentNode) {
        this.container.parentNode.removeChild(this.container);
      }
      if (this.targetEl && this.clickHandler) {
        this.targetEl.removeEventListener("click", this.clickHandler, true);
      }
      window.removeEventListener("scroll", this.onScroll);
      window.removeEventListener("resize", this.onScroll);
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
  const parts: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      parts.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  return `${BROWSER_OVERLAY_SCRIPT}; window.__rhGuide.show({ ${parts.join(", ")} });`;
}

export function generateDismissGuideScript(): string {
  return `${BROWSER_OVERLAY_SCRIPT}; window.__rhGuide.dismiss();`;
}
