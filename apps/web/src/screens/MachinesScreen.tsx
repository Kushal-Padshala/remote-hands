import { useMemo, useState } from 'react';
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

function isOnline(machine: MachineRow): boolean {
  return (
    machine.status === 'online' &&
    Boolean(machine.last_seen_at && Date.now() - new Date(machine.last_seen_at).getTime() < 45000)
  );
}

function formatSeen(iso: string | null): string {
  if (!iso) return 'never seen';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'unknown';
  const diff = Date.now() - t;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function MachinesScreen({
  machines,
  onSelectMachine,
  onRefresh,
  loading,
  onGoToPairing,
}: MachinesScreenProps) {
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const handleCopy = (e: React.MouseEvent, cmd: string) => {
    e.stopPropagation();
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(cmd);
      setCopiedCmd(cmd);
      setTimeout(() => setCopiedCmd(null), 2000);
    }
  };

  const onlineCount = useMemo(() => machines.filter(isOnline).length, [machines]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? machines.filter((m) =>
          `${m.name || ''} ${m.hostname || ''}`.toLowerCase().includes(q),
        )
      : [...machines];
    return filtered.sort((a, b) => {
      const ao = isOnline(a) ? 0 : 1;
      const bo = isOnline(b) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      const at = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
      const bt = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0;
      return bt - at;
    });
  }, [machines, query]);

  return (
    <div className="screen-content home-content">
      <div className="home-toolbar">
        <div className="home-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={machines.length > 0 ? 'Search computers…' : 'Search'}
            aria-label="Search computers"
            disabled={machines.length === 0 && !query}
          />
          {query && (
            <button
              type="button"
              className="home-search-clear"
              onClick={() => setQuery('')}
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>
        <button
          type="button"
          className="btn-icon"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh machines list"
          title="Refresh"
        >
          {loading ? (
            <span className="spinner" style={{ width: 14, height: 14 }} />
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
          )}
        </button>
      </div>

      <div className="home-meta">
        <span>
          {machines.length === 0
            ? 'No computers yet'
            : `${machines.length} paired · ${onlineCount} online`}
        </span>
        {onGoToPairing && machines.length > 0 && (
          <button type="button" className="home-meta-action" onClick={onGoToPairing}>
            Pair new
          </button>
        )}
      </div>

      {machines.length === 0 && !loading && (
        <div className="empty-state-card home-onboard" data-testid="machines-placeholder">
          <div className="empty-state-icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </div>
          <h3 className="empty-state-title">No computers connected</h3>
          <p className="empty-state-desc">
            Connect your Mac once, then open it here to send tasks.
          </p>
          <ol className="onboard-steps">
            <li>
              <span className="onboard-num" aria-hidden="true">1</span>
              <span>
                Install the daemon on your Mac — see <span className="onboard-em">Pairing</span>
              </span>
            </li>
            <li>
              <span className="onboard-num" aria-hidden="true">2</span>
              <span>
                Run{' '}
                <button
                  type="button"
                  className="onboard-cmd"
                  onClick={(e) => handleCopy(e, 'rh start')}
                  title="Copy command"
                >
                  <code>rh start</code>
                  <span>{copiedCmd === 'rh start' ? 'Copied' : 'Copy'}</span>
                </button>
              </span>
            </li>
            <li>
              <span className="onboard-num" aria-hidden="true">3</span>
              <span>Come back here — your Mac appears above</span>
            </li>
          </ol>
          {onGoToPairing && (
            <button
              type="button"
              className="btn-onboard-primary"
              onClick={onGoToPairing}
            >
              Pair a Computer
            </button>
          )}
        </div>
      )}

      {loading && machines.length === 0 && (
        <div className="machines-list" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="machine-skel">
              <span className="skel-dot" />
              <span className="skel-lines">
                <span className="skel-line title" />
                <span className="skel-line sub" />
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="machines-list">
        {visible.map((machine) => {
          const online = isOnline(machine);
          const sub = `${machine.hostname || 'remote'} · agy ${machine.agy_version || 'ready'} · seen ${formatSeen(machine.last_seen_at)}`;
          return (
            <div
              key={machine.id}
              className={clsx('machine-row', !online && 'is-offline')}
              data-testid={`machine-card-${machine.id}`}
              onClick={() => onSelectMachine(machine)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectMachine(machine);
                }
              }}
              role="button"
              tabIndex={0}
              aria-label={`Open ${machine.name || machine.hostname || 'computer'}`}
            >
              <span className={clsx('machine-dot', online && 'on')} aria-hidden="true" />
              <span className="machine-main">
                <span className="machine-name">{machine.name}</span>
                <span className="machine-sub">{sub}</span>
                {!online && (
                  <span className="machine-offline-line" onClick={(e) => e.stopPropagation()}>
                    <span>Offline — run</span>
                    <button
                      type="button"
                      className="offline-cmd-pill"
                      onClick={(e) => handleCopy(e, 'rh start')}
                    >
                      <code>rh start</code>
                      <span className="offline-cmd-copy">{copiedCmd === 'rh start' ? 'Copied' : 'Copy'}</span>
                    </button>
                  </span>
                )}
              </span>
              <button
                type="button"
                className="machine-open"
                data-testid={`create-task-btn-${machine.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectMachine(machine);
                }}
                aria-label={`Open ${machine.name || machine.hostname || 'computer'}`}
                title="Open"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>

      {machines.length > 0 && visible.length === 0 && (
        <div className="home-no-results">
          <p>No computers match “{query.trim()}”.</p>
          <button type="button" className="home-meta-action" onClick={() => setQuery('')}>
            Clear search
          </button>
        </div>
      )}
    </div>
  );
}
