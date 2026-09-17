import { useState, useEffect, useMemo } from 'react';
import { apiClient } from '../api/client.js';
import type { TaskRow, MachineRow } from '@remote-hands/shared';

interface HistoryTabProps {
  machines: MachineRow[];
  onSelectTask: (task: TaskRow) => void;
}

export function HistoryTab({ machines, onSelectTask }: HistoryTabProps) {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMachineId, setSelectedMachineId] = useState<string>('all');

  const machineMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of machines) {
      map.set(m.id, m.name || m.hostname || m.id.slice(0, 8));
    }
    return map;
  }, [machines]);

  const loadTasks = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await apiClient.listTasks(
        selectedMachineId !== 'all' ? { machine_id: selectedMachineId } : undefined,
      );
      setTasks(list);
    } catch (err: any) {
      setError(err?.message || 'Failed to load task history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTasks();
  }, [selectedMachineId]);

  const filteredTasks = useMemo(() => {
    if (!searchQuery.trim()) return tasks;
    const query = searchQuery.toLowerCase().trim();
    return tasks.filter((t) => {
      const promptMatch = t.prompt.toLowerCase().includes(query);
      const machineName = machineMap.get(t.machine_id)?.toLowerCase() || '';
      const summaryMatch = t.result_summary?.toLowerCase().includes(query) ?? false;
      return promptMatch || machineName.includes(query) || summaryMatch;
    });
  }, [tasks, searchQuery, machineMap]);

  const formatTimestamp = (iso: string) => {
    try {
      const date = new Date(iso);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);

      if (diffMins < 1) return 'just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (diffDays === 1) return 'yesterday';
      if (diffDays < 7) return `${diffDays}d ago`;
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'done':
        return <span className="history-status-badge status-done">Completed</span>;
      case 'running':
      case 'claimed':
        return (
          <span className="history-status-badge status-running">
            <span className="history-pulse-dot" />
            Running
          </span>
        );
      case 'queued':
        return <span className="history-status-badge status-queued">Queued</span>;
      case 'failed':
        return <span className="history-status-badge status-failed">Failed</span>;
      case 'cancelled':
        return <span className="history-status-badge status-cancelled">Cancelled</span>;
      default:
        return <span className="history-status-badge">{status}</span>;
    }
  };

  return (
    <div className="history-tab">
      <div className="history-header">
        <div className="history-search-row">
          <div className="history-search-container">
            <svg
              className="history-search-icon"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              className="history-search-input"
              placeholder="Search chat history..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search chat history"
            />
            {searchQuery && (
              <button
                type="button"
                className="history-search-clear"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>
          <button
            type="button"
            className="history-refresh-btn"
            onClick={loadTasks}
            disabled={loading}
            aria-label="Refresh chat history"
            title="Refresh"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={loading ? 'spin-animation' : ''}
              aria-hidden="true"
            >
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        </div>

        {machines.length > 1 && (
          <div className="history-filter-scroll">
            <button
              type="button"
              className={`history-filter-chip ${selectedMachineId === 'all' ? 'active' : ''}`}
              onClick={() => setSelectedMachineId('all')}
            >
              All Devices
            </button>
            {machines.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`history-filter-chip ${selectedMachineId === m.id ? 'active' : ''}`}
                onClick={() => setSelectedMachineId(m.id)}
              >
                {m.name || m.hostname || m.id.slice(0, 8)}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--accent-rose)', margin: '12px 0' }}>
          <div style={{ color: 'var(--accent-rose)', fontSize: '0.85rem' }}>{error}</div>
        </div>
      )}

      {loading && tasks.length === 0 ? (
        <div className="history-loading-list">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="history-skeleton-card">
              <div className="history-skeleton-line title" />
              <div className="history-skeleton-line meta" />
            </div>
          ))}
        </div>
      ) : filteredTasks.length === 0 ? (
        <div className="history-empty-state">
          <div className="history-empty-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <div className="history-empty-title">
            {searchQuery ? 'No matching chats found' : 'No conversation history yet'}
          </div>
          <div className="history-empty-desc">
            {searchQuery
              ? 'Try a different search query'
              : 'Tasks and chat conversations from all connected devices will appear here.'}
          </div>
        </div>
      ) : (
        <div className="history-list">
          {filteredTasks.map((t) => {
            const machineName = machineMap.get(t.machine_id) || t.machine_id.slice(0, 8);
            const timeStr = formatTimestamp(t.created_at);

            return (
              <div
                key={t.id}
                className="history-card"
                onClick={() => onSelectTask(t)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectTask(t);
                  }
                }}
              >
                <div className="history-card-header">
                  <div className="history-card-machine">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                      <line x1="12" y1="17" x2="12" y2="21" />
                    </svg>
                    <span>{machineName}</span>
                  </div>
                  <div className="history-card-meta-right">
                    {timeStr && <span className="history-card-time">{timeStr}</span>}
                    {getStatusBadge(t.status)}
                  </div>
                </div>

                <div className="history-card-prompt">{t.prompt}</div>

                {t.result_summary && t.result_summary !== 'Task completed without text output' && (
                  <div className="history-card-summary">
                    {t.result_summary}
                  </div>
                )}

                <div className="history-card-footer">
                  <span className="history-continue-hint">
                    Continue chat
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
