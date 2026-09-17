import { useState, useEffect, useRef } from 'react';
import {
  safeParseRealtimeMessage,
  type TaskRow,
  type ApprovalRow,
} from '@remote-hands/shared';
import { apiClient } from '../api/client.js';
import { FrameViewer } from '../components/FrameViewer.js';
import { ApprovalSheet } from '../components/ApprovalSheet.js';
import { StepsDropdown, type ChatStep } from '../components/StepsDropdown.js';

export interface LiveTaskScreenProps {
  task: TaskRow;
  machineName?: string | undefined;
  onBack: () => void;
  webSocketFactory?: ((taskId: string) => any) | undefined;
}

interface ChatMessage {
  id: string;
  type: 'user' | 'agent' | 'tool' | 'thinking' | 'result' | 'error';
  text?: string;
  toolName?: string;
  toolInput?: any;
  toolOutput?: string;
  toolStatus?: 'active' | 'done';
  time?: string;
}

type GroupedRenderItem =
  | { kind: 'user'; message: ChatMessage }
  | { kind: 'agent'; message: ChatMessage; isLatest: boolean }
  | { kind: 'steps'; steps: ChatStep[]; isWorking: boolean; id: string }
  | { kind: 'error'; message: ChatMessage };

function groupMessages(messages: ChatMessage[], isWorking: boolean): GroupedRenderItem[] {
  const items: GroupedRenderItem[] = [];
  const latestAgentIdx = messages.findLastIndex((m) => m.type === 'agent');
  const lastUserIdx = messages.findLastIndex((m) => m.type === 'user');

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.type === 'user') {
      items.push({ kind: 'user', message: msg });
    } else if (msg.type === 'agent') {
      items.push({ kind: 'agent', message: msg, isLatest: i === latestAgentIdx });
    } else if (msg.type === 'error') {
      items.push({ kind: 'error', message: msg });
    } else if (msg.type === 'tool' || msg.type === 'thinking') {
      const last = items[items.length - 1];
      const isCurrentGroupWorking = isWorking && i >= lastUserIdx;
      if (last && last.kind === 'steps') {
        last.steps.push(msg as ChatStep);
        if (isCurrentGroupWorking) {
          last.isWorking = true;
        }
      } else {
        items.push({
          kind: 'steps',
          steps: [msg as ChatStep],
          isWorking: isCurrentGroupWorking,
          id: `steps-${msg.id}`,
        });
      }
    }
  }

  return items;
}

export function LiveTaskScreen({ task, machineName, onBack, webSocketFactory }: LiveTaskScreenProps) {
  const [currentTaskId, setCurrentTaskId] = useState<string>(task.id);
  const [conversationId, setConversationId] = useState<string | undefined>(task.conversation_id ?? undefined);
  const [frameBase64, setFrameBase64] = useState<string | null>(null);
  const [showFrame, setShowFrame] = useState(true);
  const [activeApproval, setActiveApproval] = useState<ApprovalRow | null>(null);
  const [decidingApproval, setDecidingApproval] = useState(false);
  const [isWorking, setIsWorking] = useState(true);
  const [chatInput, setChatInput] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: `user-${task.id}`,
      type: 'user',
      text: task.prompt,
      time: task.created_at,
    },
  ]);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [messages, isWorking]);

  useEffect(() => {
    let ws: any = null;
    let closed = false;
    let pollTimer: any = null;
    const seenEventIds = new Set<string>();

    function processIncomingEvent(kind: string, payload: any) {
      if (kind === 'status') {
        const s = payload?.status;
        if (s === 'running') {
          setIsWorking(true);
        } else if (s === 'done' || s === 'failed' || s === 'cancelled') {
          setIsWorking(false);
        }
      } else if (kind === 'agent_text') {
        const textChunk = typeof payload === 'object' && payload?.text !== undefined ? String(payload.text) : String(payload);
        if (!textChunk) return;

        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.type === 'agent') {
            const updated = [...prev];
            updated[updated.length - 1] = {
              ...last,
              text: (last.text || '') + textChunk,
            };
            return updated;
          }
          return [
            ...prev,
            {
              id: `agent-${Date.now()}-${Math.random()}`,
              type: 'agent',
              text: textChunk,
              time: new Date().toISOString(),
            },
          ];
        });
      } else if (kind === 'thinking') {
        const text = payload?.text || 'Analyzing and planning next actions...';
        setMessages((prev) => {
          const filtered = prev.filter((m) => m.type !== 'thinking');
          return [
            ...filtered,
            {
              id: `thinking-${Date.now()}`,
              type: 'thinking',
              text,
              time: new Date().toISOString(),
            },
          ];
        });
      } else if (kind === 'tool_call') {
        const toolName = payload?.tool || 'tool';
        const callId = String(payload?.call_id || Date.now());
        setMessages((prev) => {
          const filtered = prev.filter((m) => m.type !== 'thinking');
          return [
            ...filtered,
            {
              id: `tool-${callId}`,
              type: 'tool',
              toolName,
              toolInput: payload?.input,
              toolStatus: 'active',
              time: new Date().toISOString(),
            },
          ];
        });
      } else if (kind === 'tool_result') {
        const callId = String(payload?.call_id || '');
        const output = typeof payload?.output === 'string' ? payload.output : JSON.stringify(payload?.output ?? '');
        setMessages((prev) => {
          return prev.map((m) => {
            if (m.type === 'tool' && (m.id === `tool-${callId}` || (callId === '' && m.toolStatus === 'active'))) {
              return {
                ...m,
                toolOutput: output,
                toolStatus: 'done',
              };
            }
            return m;
          });
        });
      } else if (kind === 'result') {
        setIsWorking(false);
        if (payload?.conversation_id) {
          setConversationId(payload.conversation_id);
        }
        setMessages((prev) => {
          const filtered = prev.filter((m) => m.type !== 'thinking');
          const lastUserIdx = filtered.findLastIndex((m) => m.type === 'user');
          const hasAgentAfterLastUser = filtered
            .slice(lastUserIdx + 1)
            .some((m) => m.type === 'agent' && (m.text?.length ?? 0) > 0);
          if (!hasAgentAfterLastUser && payload?.summary) {
            return [
              ...filtered,
              {
                id: `result-${Date.now()}`,
                type: 'agent',
                text: payload.summary,
                time: new Date().toISOString(),
              },
            ];
          }
          return filtered;
        });
      } else if (kind === 'error') {
        setIsWorking(false);
        const errorMsg = payload?.message || 'Task failed';
        setMessages((prev) => [
          ...prev,
          {
            id: `error-${Date.now()}`,
            type: 'error',
            text: errorMsg,
            time: new Date().toISOString(),
          },
        ]);
      }
    }

    async function fetchEventsPoll() {
      try {
        const list = await apiClient.listEvents(currentTaskId);
        if (closed) return;
        for (const e of list) {
          const key = `${e.id}`;
          if (!seenEventIds.has(key)) {
            seenEventIds.add(key);
            processIncomingEvent(e.kind, e.payload);
          }
        }
      } catch {}
    }

    fetchEventsPoll();
    pollTimer = setInterval(fetchEventsPoll, 1500);

    try {
      const socket = webSocketFactory
        ? webSocketFactory(currentTaskId)
        : apiClient.createTaskWebSocket(currentTaskId);
      ws = socket;

      socket.onopen = () => {
        try {
          socket.send(JSON.stringify({ type: 'hello', role: 'phone', protocol_version: 1 }));
        } catch {}
      };

      socket.onmessage = (msgEvent: any) => {
        let rawData: unknown;
        try {
          rawData = JSON.parse(msgEvent.data);
        } catch {
          return;
        }

        const parseResult = safeParseRealtimeMessage(rawData);
        if (!parseResult.ok) return;
        const msg = parseResult.message;

        if (msg.type === 'task.frame') {
          setFrameBase64(msg.jpeg_base64);
        } else if (msg.type === 'task.event') {
          if ((msg.event as any)?.id) {
            seenEventIds.add(String((msg.event as any).id));
          }
          processIncomingEvent(msg.event.kind, msg.event.payload);
        } else if (msg.type === 'approval.requested') {
          setActiveApproval({
            id: msg.approval_id,
            task_id: msg.task_id,
            owner_id: task.owner_id,
            action_kind: 'publish',
            summary: 'Dangerous action requires confirmation',
            risk: 'high',
            tool_payload: {},
            frame_path: null,
            decision: 'pending',
            decided_at: null,
            expires_at: new Date(Date.now() + 60000).toISOString(),
            created_at: new Date().toISOString(),
          });
        }
      };
    } catch {}

    return () => {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (ws) {
        try {
          ws.close();
        } catch {}
      }
    };
  }, [currentTaskId, webSocketFactory, task.owner_id]);

  const handleSendMessage = async () => {
    const text = chatInput.trim();
    if (!text || sendingMessage) return;

    setSendingMessage(true);
    setChatInput('');
    setIsWorking(true);

    const userMsgId = `user-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: userMsgId,
        type: 'user',
        text,
        time: new Date().toISOString(),
      },
    ]);

    try {
      let resolvedConversationId = conversationId;
      if (!resolvedConversationId && currentTaskId) {
        try {
          const prevTask = await apiClient.getTask(currentTaskId);
          if (prevTask.conversation_id) {
            resolvedConversationId = prevTask.conversation_id;
            setConversationId(prevTask.conversation_id);
          }
        } catch {}
      }

      const nextTask = await apiClient.createTask({
        machine_id: task.machine_id,
        prompt: text,
        conversation_id: resolvedConversationId,
        workspace_path: task.workspace_path ?? undefined,
        mode: task.mode ?? undefined,
      });
      setCurrentTaskId(nextTask.id);
      if (nextTask.conversation_id) {
        setConversationId(nextTask.conversation_id);
      }
    } catch (err: any) {
      alert(err?.message || 'Failed to send message');
      setIsWorking(false);
    } finally {
      setSendingMessage(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleApprove = async (approvalId: string) => {
    setDecidingApproval(true);
    try {
      await apiClient.decideApproval(approvalId, 'approved');
      setActiveApproval(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setDecidingApproval(false);
    }
  };

  const handleReject = async (approvalId: string) => {
    setDecidingApproval(true);
    try {
      await apiClient.decideApproval(approvalId, 'rejected');
      setActiveApproval(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setDecidingApproval(false);
    }
  };

  return (
    <div className="chat-screen">
      <div className="chat-nav-header">
        <button
          className="btn"
          style={{ width: 'auto', padding: '6px 10px', fontSize: '0.8125rem', background: 'transparent', color: 'var(--text-secondary)' }}
          onClick={onBack}
        >
          ← Machines
        </button>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>
            {machineName || 'My Computer'}
          </div>
          <div style={{ fontSize: '0.6875rem', color: isWorking ? 'var(--accent-amber)' : 'var(--accent-green)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            <span>●</span> {isWorking ? 'agy working...' : 'Ready'}
          </div>
        </div>
        {frameBase64 ? (
          <button
            className="btn"
            style={{ width: 'auto', padding: '4px 8px', fontSize: '0.6875rem', background: 'var(--bg-surface)' }}
            onClick={() => setShowFrame(!showFrame)}
          >
            📺 Screen
          </button>
        ) : (
          <div style={{ width: 48 }} />
        )}
      </div>

      {showFrame && frameBase64 && (
        <div style={{ marginBottom: 12 }}>
          <FrameViewer frameBase64={frameBase64} />
        </div>
      )}

      <div className="chat-scroll-area">
        {groupMessages(messages, isWorking).map((item) => {
          if (item.kind === 'user') {
            return (
              <div key={item.message.id} className="chat-bubble-user">
                {item.message.text}
              </div>
            );
          }

          if (item.kind === 'steps') {
            return (
              <StepsDropdown
                key={item.id}
                steps={item.steps}
                isWorking={item.isWorking}
              />
            );
          }

          if (item.kind === 'agent') {
            return (
              <div key={item.message.id} className="chat-bubble-agent">
                <div style={{ fontSize: '0.6875rem', color: 'var(--accent-cyan)', fontWeight: 600, marginBottom: 4 }}>
                  ⚡ agy
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>
                  {item.message.text}
                  {isWorking && item.isLatest && <span className="cursor-blink" />}
                </div>
              </div>
            );
          }

          if (item.kind === 'error') {
            return (
              <div key={item.message.id} className="card" style={{ borderColor: 'var(--accent-rose)', color: 'var(--accent-rose)', fontSize: '0.8125rem' }}>
                ✖ {item.message.text}
              </div>
            );
          }

          return null;
        })}

        {isWorking && (() => {
          const lastUserIdx = messages.findLastIndex((m) => m.type === 'user');
          const afterUser = messages.slice(lastUserIdx + 1);
          const hasThinking = afterUser.some((m) => m.type === 'thinking');
          const hasAgent = afterUser.some((m) => m.type === 'agent');
          const hasTools = afterUser.some((m) => m.type === 'tool');
          if (!hasThinking && !hasAgent && !hasTools) {
            return (
              <div className="chat-thinking-indicator">
                <span>⚡</span>
                <span>agy is starting up...</span>
              </div>
            );
          }
          return null;
        })()}

        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-container">
        <input
          type="text"
          className="chat-input-field"
          placeholder="Message agy on your Mac..."
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sendingMessage}
        />
        <button
          className="chat-send-button"
          onClick={handleSendMessage}
          disabled={!chatInput.trim() || sendingMessage}
          aria-label="Send message"
        >
          ↑
        </button>
      </div>

      <ApprovalSheet
        approval={activeApproval}
        onApprove={handleApprove}
        onReject={handleReject}
        loading={decidingApproval}
      />
    </div>
  );
}
