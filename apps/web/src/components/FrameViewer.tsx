export interface FrameViewerProps {
  frameBase64: string | null;
}

export function FrameViewer({ frameBase64 }: FrameViewerProps) {
  return (
    <div className="frame-viewer" data-testid="frame-viewer">
      {frameBase64 ? (
        <img
          src={frameBase64.startsWith('data:') ? frameBase64 : `data:image/jpeg;base64,${frameBase64}`}
          alt="Live browser screen"
        />
      ) : (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
          No browser frame available
        </div>
      )}
    </div>
  );
}
