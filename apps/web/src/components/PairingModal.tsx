import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

export interface PairingModalProps {
  isOpen: boolean;
  onClose: () => void;
  pairingUrl?: string | undefined;
  pairingCode?: string | undefined;
}

export function PairingModal({ isOpen, onClose, pairingUrl, pairingCode }: PairingModalProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [copied, setCopied] = useState(false);

  const activeUrl =
    pairingUrl ||
    (typeof window !== 'undefined'
      ? `${window.location.origin}/pair${pairingCode ? `?code=${encodeURIComponent(pairingCode)}` : ''}`
      : '');

  useEffect(() => {
    if (isOpen && canvasRef.current && activeUrl) {
      QRCode.toCanvas(canvasRef.current, activeUrl, {
        width: 200,
        margin: 1,
        color: {
          dark: '#09090b',
          light: '#ffffff',
        },
      }).catch(() => {});
    }
  }, [isOpen, activeUrl]);

  if (!isOpen) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(activeUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet-content" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grabber" />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 600 }}>Pair Your Phone</h3>
          <button
            className="btn-ghost"
            style={{ width: 'auto', padding: '4px 8px', borderRadius: '50%' }}
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.45 }}>
          Scan this QR code with your mobile camera to open this remote session directly on your phone.
        </p>

        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            background: '#ffffff',
            borderRadius: 14,
            padding: 14,
            margin: '0 auto 16px auto',
            maxWidth: 228,
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
          }}
        >
          <canvas ref={canvasRef} />
        </div>

        {pairingCode && (
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
              Pairing Code
            </div>
            <div
              style={{
                fontSize: '1.2rem',
                fontWeight: 700,
                letterSpacing: '0.08em',
                color: 'var(--accent-cyan)',
                fontFamily: 'var(--font-mono)',
                marginTop: 2,
              }}
            >
              {pairingCode}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-ghost" style={{ flex: 1, padding: '10px' }} onClick={handleCopy}>
            {copied ? '✓ Copied Link' : 'Copy Link'}
          </button>
          <button className="btn btn-primary" style={{ flex: 1, padding: '10px' }} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
