import type { MachineRow } from '@remote-hands/shared';

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
          const isOnline = machine.status === 'online';
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

              <div className="machine-card-footer">
                <span className="badge-badge">agy {machine.agy_version || 'ready'}</span>
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
          );
        })}
      </div>
    </div>
  );
}
