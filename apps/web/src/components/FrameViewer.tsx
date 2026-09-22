import { useState } from 'react';

export interface FrameViewerProps {
  frameBase64: string | null;
  onClose?: (() => void) | undefined;
  title?: string | undefined;
}

export function FrameViewer({ frameBase64, onClose, title = 'Live' }: FrameViewerProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!frameBase64) return null;

  const imgSrc = frameBase64.startsWith('data:')
    ? frameBase64
    : `data:image/jpeg;base64,${frameBase64}`;

  return (
    <>
      <div className="frame-viewer" data-testid="frame-viewer">
        <div className="frame-viewer-header">
          <div className="frame-viewer-live-badge">
            <span className="live-dot" />
            <span>{title}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              className="frame-viewer-expand"
              onClick={() => setIsExpanded(true)}
              aria-label="Expand screen"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
            {onClose && (
              <button
                type="button"
                className="frame-viewer-close"
                onClick={onClose}
                aria-label="Hide screen"
              >
                ✕
              </button>
            )}
          </div>
        </div>
        <img
          src={imgSrc}
          alt="Live desktop or browser screen"
          className="frame-viewer-img"
          onClick={() => setIsExpanded(true)}
          style={{ cursor: 'pointer' }}
        />
      </div>

      {isExpanded && (
        <div className="frame-lightbox-overlay" onClick={() => setIsExpanded(false)} data-testid="frame-lightbox">
          <div className="frame-lightbox-content" onClick={(e) => e.stopPropagation()}>
            <div className="frame-lightbox-bar">
              <div className="frame-viewer-live-badge">
                <span className="live-dot" />
                <span>{title}</span>
              </div>
              <button
                type="button"
                className="frame-viewer-close"
                onClick={() => setIsExpanded(false)}
                aria-label="Close full view"
              >
                ✕
              </button>
            </div>
            <img src={imgSrc} alt="Full screen preview" className="frame-lightbox-img" />
          </div>
        </div>
      )}
    </>
  );
}
