export interface FrameViewerProps {
  frameBase64: string | null;
  onClose?: (() => void) | undefined;
}

export function FrameViewer({ frameBase64, onClose }: FrameViewerProps) {
  if (!frameBase64) return null;

  const imgSrc = frameBase64.startsWith('data:')
    ? frameBase64
    : `data:image/jpeg;base64,${frameBase64}`;

  return (
    <div className="frame-viewer" data-testid="frame-viewer">
      <div className="frame-viewer-header">
        <div className="frame-viewer-live-badge">
          <span className="live-dot" />
          <span>Live</span>
        </div>
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
      <img
        src={imgSrc}
        alt="Live browser screen"
        className="frame-viewer-img"
      />
    </div>
  );
}
