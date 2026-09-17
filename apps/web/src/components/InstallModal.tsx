import { useState, useEffect } from 'react';

export interface InstallModalProps {
  isOpen: boolean;
  onClose: () => void;
  deferredPrompt?: any;
}

export function InstallModal({ isOpen, onClose, deferredPrompt }: InstallModalProps) {
  const [platform, setPlatform] = useState<'ios' | 'android' | 'desktop'>('desktop');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const ua = window.navigator.userAgent.toLowerCase();
      if (/iphone|ipad|ipod/.test(ua)) {
        setPlatform('ios');
      } else if (/android/.test(ua)) {
        setPlatform('android');
      } else {
        setPlatform('desktop');
      }
    }
  }, []);

  if (!isOpen) return null;

  const handleNativeInstall = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice?.outcome === 'accepted') {
        onClose();
      }
    }
  };

  return (
    <div className="sheet-overlay" onClick={onClose} data-testid="install-modal">
      <div className="sheet-content" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grabber" />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                background: '#18181b',
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent-cyan)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </div>
            <div>
              <h3 style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                Add to Home Screen
              </h3>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {platform === 'ios' ? 'Apple iOS' : platform === 'android' ? 'Android PWA' : 'Mobile Web App'}
              </span>
            </div>
          </div>
          <button
            className="btn-ghost"
            style={{ width: 'auto', padding: '4px 8px', borderRadius: '50%' }}
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {deferredPrompt ? (
          <div style={{ margin: '14px 0 18px 0' }}>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.5 }}>
              Install Remote Hands directly on your device for instant fullscreen access and offline caching.
            </p>
            <button
              className="btn btn-primary"
              onClick={handleNativeInstall}
            >
              Install App Now
            </button>
          </div>
        ) : platform === 'ios' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, margin: '14px 0 20px 0' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: 'rgba(56, 189, 248, 0.12)',
                  color: 'var(--accent-cyan)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  flexShrink: 0,
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                }}
              >
                1
              </div>
              <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                In Safari, tap the <strong>Share</strong> button <span style={{ display: 'inline-block', verticalAlign: 'middle', padding: '1px 4px', background: 'rgba(255,255,255,0.08)', borderRadius: 4, fontSize: '0.875rem' }}>⎋</span> or <span style={{ display: 'inline-block', verticalAlign: 'middle', padding: '1px 4px', background: 'rgba(255,255,255,0.08)', borderRadius: 4, fontSize: '0.875rem' }}>↑</span> at the bottom toolbar.
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: 'rgba(56, 189, 248, 0.12)',
                  color: 'var(--accent-cyan)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  flexShrink: 0,
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                }}
              >
                2
              </div>
              <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                Scroll down in the menu and tap <strong>Add to Home Screen</strong> <span style={{ display: 'inline-block', verticalAlign: 'middle', padding: '1px 4px', background: 'rgba(255,255,255,0.08)', borderRadius: 4, fontSize: '0.875rem' }}>+</span>.
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: 'rgba(56, 189, 248, 0.12)',
                  color: 'var(--accent-cyan)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  flexShrink: 0,
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                }}
              >
                3
              </div>
              <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                Tap <strong>Add</strong> in the top right. Remote Hands will launch as a native fullscreen app.
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, margin: '14px 0 20px 0' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: 'rgba(56, 189, 248, 0.12)',
                  color: 'var(--accent-cyan)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  flexShrink: 0,
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                }}
              >
                1
              </div>
              <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                Tap the browser menu <span style={{ display: 'inline-block', verticalAlign: 'middle', padding: '1px 5px', background: 'rgba(255,255,255,0.08)', borderRadius: 4, fontSize: '0.875rem' }}>⋮</span> in the top right.
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: 'rgba(56, 189, 248, 0.12)',
                  color: 'var(--accent-cyan)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  flexShrink: 0,
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                }}
              >
                2
              </div>
              <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                Select <strong>Install app</strong> or <strong>Add to Home screen</strong>.
              </div>
            </div>
          </div>
        )}

        <button className="btn btn-primary" onClick={onClose}>
          Got it
        </button>
      </div>
    </div>
  );
}
