import { useState } from 'react';

export interface PairingTabProps {
  pairingCode?: string | undefined;
  onShowPairQr: () => void;
  onClearCache: () => void;
  onConnectUrl: (url: string) => void;
  error?: string | null | undefined;
}

export function PairingTab({
  pairingCode,
  onShowPairQr,
  onClearCache,
  onConnectUrl,
  error,
}: PairingTabProps) {
  const [pasteUrlInput, setPasteUrlInput] = useState('');

  const handleConnect = () => {
    if (!pasteUrlInput.trim()) return;
    onConnectUrl(pasteUrlInput.trim());
    setPasteUrlInput('');
  };

  return (
    <div className="screen-content pairing-content">
      <div className="section-header">
        <div>
          <h2 className="section-title">Pairing & Session</h2>
          <p className="section-subtitle">Link this phone with your Mac or PC daemon</p>
        </div>
      </div>

      {pairingCode ? (
        <div className="card" style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="status-dot pulse" style={{ background: 'var(--accent-emerald)' }} />
              <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>Session Active</span>
            </div>
            <span className="badge badge-online">Paired</span>
          </div>

          <div style={{ background: 'rgba(0, 0, 0, 0.4)', borderRadius: 10, padding: '12px 14px', border: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
              Pairing Code
            </div>
            <div style={{ fontSize: '1.25rem', fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--accent-cyan)', marginTop: 2 }}>
              {pairingCode}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 4 }}>
            <button className="btn btn-primary" onClick={onShowPairQr} style={{ padding: '8px 12px', fontSize: '0.8125rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
              </svg>
              <span>View QR</span>
            </button>
            <button className="btn-ghost" onClick={onClearCache} style={{ padding: '8px 12px', fontSize: '0.8125rem' }}>
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                background: 'rgba(56, 189, 248, 0.1)',
                border: '1px solid rgba(56, 189, 248, 0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent-cyan)',
                flexShrink: 0,
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            </div>
            <div>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                Connect a New Computer
              </h3>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Setup takes less than 30 seconds
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'rgba(255,255,255,0.08)', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6875rem', fontWeight: 700, flexShrink: 0 }}>
                1
              </span>
              <div>
                Open your terminal on your computer and run:
                <div style={{ marginTop: 4 }}>
                  <code className="inline-code">rh start</code> or <code className="inline-code">rh pair</code>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'rgba(255,255,255,0.08)', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6875rem', fontWeight: 700, flexShrink: 0 }}>
                2
              </span>
              <div>
                Scan the QR code shown in terminal, or paste the link/token below:
              </div>
            </div>
          </div>

          <div className="connect-input-group" style={{ margin: 0 }}>
            <input
              type="text"
              className="app-input"
              placeholder="Paste pairing URL or token..."
              value={pasteUrlInput}
              onChange={(e) => setPasteUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConnect();
              }}
            />
            <button className="btn-primary-compact" onClick={handleConnect}>
              Connect
            </button>
          </div>

          {error && (
            <div style={{ fontSize: '0.75rem', color: 'var(--accent-rose)', marginTop: -6 }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
            <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>Trouble connecting?</span>
            <button className="btn-text" onClick={onClearCache}>
              Reset Session
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
