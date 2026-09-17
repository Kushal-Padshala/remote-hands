import type { MachineRow } from '@remote-hands/shared';

export interface MachinesScreenProps {
  machines: MachineRow[];
  onSelectMachine: (machine: MachineRow) => void;
  onRefresh: () => void;
  loading: boolean;
  onShowPairQr?: (() => void) | undefined;
}

export function MachinesScreen({ machines, onSelectMachine, onRefresh, loading, onShowPairQr }: MachinesScreenProps) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
          Available Machines
        </h2>
        <button
          className="btn"
          style={{ width: 'auto', padding: '6px 12px', fontSize: '0.75rem', background: 'var(--bg-surface)' }}
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {machines.length === 0 && !loading && (
        <div className="card" data-testid="machines-placeholder" style={{ textAlign: 'center', padding: '32px 16px' }}>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 8, fontWeight: 500 }}>No machines connected</p>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
            Run <code>rh start</code> on your computer to begin.
          </p>
        </div>
      )}

      {machines.map((machine) => (
        <div
          key={machine.id}
          className="card"
          data-testid={`machine-card-${machine.id}`}
          style={{ cursor: 'pointer' }}
          onClick={() => onSelectMachine(machine)}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: '0.9375rem' }}>{machine.name}</strong>
            <span className={`badge ${machine.status === 'online' ? 'badge-online' : 'badge-offline'}`}>
              {machine.status}
            </span>
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
            {machine.hostname}
          </div>
          <div style={{ marginTop: 12 }}>
            <button
              className="btn btn-primary"
              data-testid={`create-task-btn-${machine.id}`}
              style={{ padding: '8px 12px', fontSize: '0.8125rem' }}
              onClick={(e) => {
                e.stopPropagation();
                onSelectMachine(machine);
              }}
            >
              + New Task
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
