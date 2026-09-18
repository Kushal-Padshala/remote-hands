import { useState } from 'react';
import type { MachineRow } from '@remote-hands/shared';
import clsx from 'clsx';

export interface MachinesScreenProps {
  machines: MachineRow[];
  onSelectMachine: (machine: MachineRow) => void;
  onRefresh: () => void;
  loading: boolean;
  onShowPairQr?: (() => void) | undefined;
  onGoToPairing?: (() => void) | undefined;
}

export function MachinesScreen({
  machines,
  onSelectMachine,
  onRefresh,
  loading,
  onGoToPairing,
}: MachinesScreenProps) {
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  const handleCopy = (e: React.MouseEvent, cmd: string) => {
    e.stopPropagation();
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(cmd);
      setCopiedCmd(cmd);
      setTimeout(() => setCopiedCmd(null), 2000);
    }
  };

  return (
    <div className="screen-content">
      <div className="section-header">
        <div>
          <h2 className="section-title">Devices</h2>
          <p className="section-subtitle">
            {machines.length === 0
              ? 'Connect your computer to get started'
              : `${machines.length} ${machines.length === 1 ? 'computer' : 'computers'} paired`}
          </p>
        </div>
        <button
          type="button"
          className="btn-ghost"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh machines list"
        >
          {loading ? (
            <span className="spinner" style={{ width: 13, height: 13 }} />
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
          )}
          <span>{loading ? 'Refreshing' : 'Refresh'}</span>
        </button>
      </div>

      {machines.length === 0 && !loading && (
        <div className="empty-state-card" data-testid="machines-placeholder">
          <div className="empty-state-icon">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </div>
          <h3 className="empty-state-title">No computers connected</h3>
          <p className="empty-state-desc">
            Run in your Mac terminal to connect:
          </p>
          <div
            className="empty-state-code-pill"
            onClick={(e) => handleCopy(e, 'rh start')}
            role="button"
            tabIndex={0}
          >
            <code className="inline-code">rh start</code>
            <span className="copy-label">{copiedCmd === 'rh start' ? 'Copied' : 'Copy'}</span>
          </div>
          {onGoToPairing && (
            <button
              type="button"
              className="btn btn-primary"
              style={{ width: 'auto', padding: '9px 20px', fontSize: '0.8125rem', marginTop: 18 }}
              onClick={onGoToPairing}
            >
              Pair a Computer
            </button>
          )}
        </div>
      )}

      <div className="machines-list">
        {machines.map((machine) => {
          const isOnline =
            machine.status === 'online' &&
            Boolean(machine.last_seen_at && Date.now() - new Date(machine.last_seen_at).getTime() < 45000);
          return (
            <div
              key={machine.id}
              className={clsx('machine-card', isOnline && 'machine-card-online')}
              data-testid={`machine-card-${machine.id}`}
              onClick={() => onSelectMachine(machine)}
              role="button"
              tabIndex={0}
            >
              <div className="machine-card-header">
                <div className="machine-info-group">
                  <div className="device-avatar">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                      <line x1="12" y1="17" x2="12" y2="21" />
                    </svg>
                  </div>
                  <div className="machine-meta">
                    <span className="machine-name">{machine.name}</span>
                    <div className="machine-submeta">
                      <span className="machine-hostname">{machine.hostname}</span>
                      <span className="meta-sep">·</span>
                      <span className="machine-version">agy {machine.agy_version || 'ready'}</span>
                    </div>
                  </div>
                </div>
                <div className={clsx('status-pill', isOnline ? 'status-pill-online' : 'status-pill-offline')}>
                  <span className={clsx('status-dot', isOnline && 'pulse')} />
                  <span className="status-label">{isOnline ? 'Online' : 'Offline'}</span>
                </div>
              </div>

              {!isOnline && (
                <div className="machine-offline-hint" onClick={(e) => e.stopPropagation()}>
                  <span className="offline-hint-text">To connect, run in terminal:</span>
                  <button
                    type="button"
                    className="offline-cmd-pill"
                    onClick={(e) => handleCopy(e, 'rh start')}
                  >
                    <code>rh start</code>
                    <span className="offline-cmd-copy">{copiedCmd === 'rh start' ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
              )}

              <div className="machine-card-footer">
                <div className="machine-presence-note">
                  {isOnline ? 'Ready for agent tasks' : 'Waiting for connection'}
                </div>
                <button
                  type="button"
                  className={clsx('btn-card-action', isOnline ? 'btn-card-primary' : 'btn-card-secondary')}
                  data-testid={`create-task-btn-${machine.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectMachine(machine);
                  }}
                >
                  <span>New Task</span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
