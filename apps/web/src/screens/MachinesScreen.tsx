import { useState } from 'react';
import type { MachineRow } from '@remote-hands/shared';
import { apiClient } from '../api/client.js';

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
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testFeedback, setTestFeedback] = useState<{ id: string; online: boolean; text: string } | null>(null);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  const handleCopy = (e: React.MouseEvent, cmd: string) => {
    e.stopPropagation();
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(cmd);
      setCopiedCmd(cmd);
      setTimeout(() => setCopiedCmd(null), 2000);
    }
  };

  const handleTestConnection = async (e: React.MouseEvent, machine: MachineRow) => {
    e.stopPropagation();
    setTestingId(machine.id);
    setTestFeedback(null);
    try {
      const fresh = await apiClient.listMachines();
      const updated = fresh.find((m) => m.id === machine.id);
      const isNowOnline = updated
        ? updated.status === 'online' &&
          Boolean(updated.last_seen_at && Date.now() - new Date(updated.last_seen_at).getTime() < 45000)
        : false;
      onRefresh();
      setTestFeedback({
        id: machine.id,
        online: isNowOnline,
        text: isNowOnline
          ? 'Connected! Computer is online and ready.'
          : 'Still offline. Start rh start in terminal on this computer, then test again.',
      });
    } catch (err: any) {
      setTestFeedback({
        id: machine.id,
        online: false,
        text: err?.message || 'Connection test failed. Check network.',
      });
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="screen-content">
      <div className="section-header">
        <div>
          <h2 className="section-title">Devices</h2>
          <p className="section-subtitle">Select a computer to chat and run tasks</p>
        </div>
        <button
          className="btn-ghost"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh machines list"
        >
          {loading ? (
            <span className="spinner" />
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
          )}
          <span>{loading ? 'Refreshing' : 'Refresh'}</span>
        </button>
      </div>

      {machines.length === 0 && !loading && (
        <div className="empty-state-card" data-testid="machines-placeholder">
          <div className="empty-state-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </div>
          <h3 className="empty-state-title">No machines connected</h3>
          <p className="empty-state-desc">
            Run <code className="inline-code">rh start</code> in terminal on your computer to connect.
          </p>
          {onGoToPairing && (
            <button
              className="btn btn-primary"
              style={{ width: 'auto', padding: '8px 16px', fontSize: '0.8125rem', marginTop: 14 }}
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
              className="machine-card"
              data-testid={`machine-card-${machine.id}`}
              onClick={() => onSelectMachine(machine)}
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
                  <div>
                    <div className="machine-title-row">
                      <span className="machine-name">{machine.name}</span>
                    </div>
                    <div className="machine-hostname">{machine.hostname}</div>
                  </div>
                </div>
                <div className={`status-pill ${isOnline ? 'status-pill-online' : 'status-pill-offline'}`}>
                  <span className={`status-dot ${isOnline ? 'pulse' : ''}`} />
                  <span className="status-label">{isOnline ? 'Online' : 'Offline'}</span>
                </div>
              </div>

              {!isOnline && (
                <div className="connection-box" onClick={(e) => e.stopPropagation()}>
                  <div className="connection-box-row">
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      To connect, run in terminal:
                    </span>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <code className="inline-code">rh start</code>
                      <button
                        className="btn-ghost"
                        style={{ padding: '2px 6px', fontSize: '0.6875rem' }}
                        onClick={(e) => handleCopy(e, 'rh start')}
                      >
                        {copiedCmd === 'rh start' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                  {testFeedback && testFeedback.id === machine.id && (
                    <div className={`connection-feedback ${testFeedback.online ? 'connection-feedback-success' : 'connection-feedback-warning'}`}>
                      {testFeedback.online ? '✓' : '⚠️'} {testFeedback.text}
                    </div>
                  )}
                </div>
              )}

              {isOnline && testFeedback && testFeedback.id === machine.id && (
                <div className="connection-feedback connection-feedback-success" onClick={(e) => e.stopPropagation()}>
                  ✓ {testFeedback.text}
                </div>
              )}

              <div className="machine-card-footer">
                <span className="badge-badge">agy {machine.agy_version || 'ready'}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    className="btn-test-connection"
                    disabled={testingId === machine.id}
                    onClick={(e) => handleTestConnection(e, machine)}
                  >
                    {testingId === machine.id ? (
                      <span className="spinner" style={{ width: 12, height: 12 }} />
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                      </svg>
                    )}
                    <span>{testingId === machine.id ? 'Checking...' : isOnline ? 'Check' : 'Test Connection'}</span>
                  </button>
                  <button
                    className="btn-create-task"
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
