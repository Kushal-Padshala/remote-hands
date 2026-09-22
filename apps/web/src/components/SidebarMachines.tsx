import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { MachineRow, TaskRow } from '@remote-hands/shared';
import { apiClient } from '../api/client.js';

export interface SidebarMachinesProps {
  machines: MachineRow[];
  selectedMachineId?: string | null | undefined;
  activeTaskId?: string | null | undefined;
  isChatMode: boolean;
  onOpenMachine: (machine: MachineRow) => void;
  onOpenTask: (task: TaskRow) => void;
  onViewAll: () => void;
  onRefreshMachines: () => void;
}

const MAX_CHATS = 6;

function isOnlineMachine(m: MachineRow): boolean {
  return (
    m.status === 'online' &&
    Boolean(m.last_seen_at) &&
    Date.now() - new Date(m.last_seen_at as string).getTime() < 45000
  );
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
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
  if (d < 7) return `${d}d ago`;
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function statusClass(status: string): string {
  switch (status) {
    case 'done':
      return 'done';
    case 'running':
    case 'claimed':
      return 'running';
    case 'queued':
      return 'queued';
    case 'failed':
      return 'failed';
    default:
      return 'muted';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'done':
      return 'Completed';
    case 'running':
    case 'claimed':
      return 'Running';
    case 'queued':
      return 'Queued';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}

export function SidebarMachines({
  machines,
  selectedMachineId,
  activeTaskId,
  isChatMode,
  onOpenMachine,
  onOpenTask,
  onViewAll,
  onRefreshMachines,
}: SidebarMachinesProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [chats, setChats] = useState<Record<string, TaskRow[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  const fetchChats = async (machineId: string) => {
    setLoading((prev) => ({ ...prev, [machineId]: true }));
    try {
      const list = await apiClient.listTasks({ machine_id: machineId });
      const mine = list
        .filter((t) => t.machine_id === machineId)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, MAX_CHATS);
      setChats((prev) => ({ ...prev, [machineId]: mine }));
    } catch {
      setChats((prev) => (prev[machineId] ? prev : { ...prev, [machineId]: [] }));
    } finally {
      setLoading((prev) => ({ ...prev, [machineId]: false }));
    }
  };

  const toggle = (machineId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(machineId)) {
        next.delete(machineId);
      } else {
        next.add(machineId);
        if (chats[machineId] === undefined && !loading[machineId]) {
          void fetchChats(machineId);
        }
      }
      return next;
    });
  };

  useEffect(() => {
    const fallback =
      machines.find((m) => isOnlineMachine(m))?.id || machines[0]?.id || null;
    const target = selectedMachineId || fallback;
    if (target) {
      setExpanded((prev) => {
        if (prev.has(target)) return prev;
        const next = new Set(prev);
        next.add(target);
        return next;
      });
      if (chats[target] === undefined) {
        void fetchChats(target);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMachineId, machines]);

  useEffect(() => {
    const timer = setInterval(() => {
      setExpanded((current) => {
        for (const id of current) {
          void fetchChats(id);
        }
        return current;
      });
    }, 20000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRefresh = () => {
    onRefreshMachines();
    for (const id of expanded) {
      void fetchChats(id);
    }
  };

  if (machines.length === 0) return null;

  return (
    <div className="sidebar-section">
      <div className="sidebar-section-head">
        <span className="sidebar-section-title">Computers</span>
        <button
          type="button"
          className="sidebar-section-action"
          onClick={handleRefresh}
          title="Refresh computers"
          aria-label="Refresh computers"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
          </svg>
        </button>
      </div>
      <div className="sidebar-machines" role="list">
        {machines.slice(0, 8).map((m) => {
          const online = isOnlineMachine(m);
          const isActive = selectedMachineId === m.id && isChatMode;
          const isOpen = expanded.has(m.id);
          const list = chats[m.id];
          const isLoading = Boolean(loading[m.id]) && list === undefined;
          return (
            <div
              key={m.id}
              role="listitem"
              className={clsx('sidebar-machine-row', isOpen && 'expanded', isActive && 'active')}
            >
              <div className="sidebar-machine-main">
                <button
                  type="button"
                  className={clsx('sidebar-machine', isActive && 'active')}
                  onClick={() => onOpenMachine(m)}
                  data-testid={`sidebar-machine-${m.id}`}
                  title={m.name || m.hostname || 'Computer'}
                >
                  <span className={clsx('sidebar-machine-dot', online ? 'online' : 'offline')} aria-hidden="true" />
                  <span className="sidebar-machine-text">
                    <span className="sidebar-machine-name">{m.name || m.hostname || 'Computer'}</span>
                    <span className="sidebar-machine-sub">{online ? 'Online' : 'Offline'}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={clsx('sidebar-machine-chevron', isOpen && 'open')}
                  onClick={() => toggle(m.id)}
                  aria-expanded={isOpen}
                  aria-label={isOpen ? `Hide chats on ${m.name || 'computer'}` : `Show chats on ${m.name || 'computer'}`}
                  data-testid={`sidebar-machine-toggle-${m.id}`}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              </div>
              <div className={clsx('sidebar-chats', isOpen && 'open')}>
                <div className="sidebar-chats-inner">
                  {isLoading ? (
                    <div className="sidebar-chats-loading" aria-hidden="true">
                      <span className="sidebar-chat-skel" />
                      <span className="sidebar-chat-skel short" />
                    </div>
                  ) : list && list.length > 0 ? (
                    <>
                      {list.map((t) => {
                        const isCurrent = activeTaskId === t.id && isChatMode;
                        return (
                          <button
                            key={t.id}
                            type="button"
                            className={clsx('sidebar-chat', isCurrent && 'active')}
                            onClick={() => onOpenTask(t)}
                            data-testid={`sidebar-chat-${t.id}`}
                            title={t.prompt}
                          >
                            <span className="sidebar-chat-prompt">{t.prompt}</span>
                            <span className="sidebar-chat-meta">
                              <span
                                className={clsx('sidebar-chat-dot', statusClass(t.status))}
                                title={statusLabel(t.status)}
                                aria-label={statusLabel(t.status)}
                              />
                              <span>{timeAgo(t.created_at)}</span>
                            </span>
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        className="sidebar-chats-all"
                        onClick={onViewAll}
                      >
                        <span>View all history</span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </button>
                    </>
                  ) : (
                    <div className="sidebar-chats-empty">No chats yet</div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
