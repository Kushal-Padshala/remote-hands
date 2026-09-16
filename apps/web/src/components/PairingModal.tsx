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
        width: 220,
        margin: 2,
        color: {
          dark: '#090d16',
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Pair Your Phone</h3>
          <button
            className="btn"
            style={{ width: 'auto', padding: '4px 10px', fontSize: '0.875rem' }}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
          Scan this QR code with your mobile camera to open the direct pairing link on your phone.
        </p>

        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            background: '#ffffff',
            borderRadius: 16,
            padding: 16,
            margin: '0 auto 16px auto',
            maxWidth: 240,
          }}
        >
          <canvas ref={canvasRef} />
        </div>

        {pairingCode && (
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Pairing Code</div>
            <div
              style={{
                fontSize: '1.25rem',
                fontWeight: 700,
                letterSpacing: '0.08em',
                color: 'var(--accent-blue)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {pairingCode}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" style={{ flex: 1 }} onClick={handleCopy}>
            {copied ? '✓ Copied Direct Link' : 'Copy Direct Link'}
          </button>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
