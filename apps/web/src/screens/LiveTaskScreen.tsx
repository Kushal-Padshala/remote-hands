import { useState, useEffect, useRef } from 'react';
import {
  safeParseRealtimeMessage,
  type TaskRow,
  type ApprovalRow,
  type MachineRow,
} from '@remote-hands/shared';
import { apiClient } from '../api/client.js';
import { FrameViewer } from '../components/FrameViewer.js';
import { ApprovalSheet } from '../components/ApprovalSheet.js';
import { StepsDropdown, type ChatStep } from '../components/StepsDropdown.js';
import { MarkdownView } from '../components/MarkdownView.js';
import { ThinkingOrb } from 'thinking-orbs';
import { VoiceButton } from '../components/VoiceButton.js';
import { useVoiceInput } from '../hooks/useVoiceInput.js';

export interface LiveTaskScreenProps {
  task?: TaskRow | undefined;
  machine?: MachineRow | undefined;
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

function getActiveWorkingInfo(messages: ChatMessage[]): {
  text: string;
  state: 'working' | 'searching' | 'solving' | 'listening' | 'connecting' | 'weaving' | 'composing' | 'breathing' | 'shaping';
} {
  const activeTool = [...messages].reverse().find((m) => m.type === 'tool' && m.toolStatus === 'active');
  if (activeTool) {
    const name = activeTool.toolName || '';
    const input = activeTool.toolInput;

    if (name === 'view_file') {
      const p = input?.AbsolutePath || input?.path || '';
      const base = p.split('/').filter(Boolean).pop() || 'file';
      return { text: `Reading ${base}...`, state: 'searching' };
    }
    if (name === 'replace_file_content' || name === 'multi_replace_file_content' || name === 'write_to_file') {
      const p = input?.TargetFile || input?.path || '';
      const base = p.split('/').filter(Boolean).pop() || 'file';
      return { text: `Updating ${base}...`, state: 'shaping' };
    }
    if (name === 'run_command') {
      const cmd = input?.CommandLine || input?.command || '';
      const displayCmd = cmd.length > 28 ? cmd.slice(0, 28) + '...' : cmd;
      return { text: displayCmd ? `Running ${displayCmd}` : 'Running terminal command...', state: 'solving' };
    }
    if (name === 'grep_search') {
      const q = input?.Query || '';
      return { text: q ? `Searching for "${q.slice(0, 18)}"...` : 'Searching codebase...', state: 'searching' };
    }
    if (name === 'search_web') {
      return { text: 'Searching web...', state: 'connecting' };
    }
    if (name === 'list_dir') {
      return { text: 'Listing files...', state: 'searching' };
    }
    return { text: `Executing ${name}...`, state: 'working' };
  }

  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.type === 'thinking') {
    return { text: 'Thinking...', state: 'weaving' };
  }

  return { text: 'Thinking...', state: 'working' };
}

export function LiveTaskScreen({ task, machine, machineName, onBack, webSocketFactory }: LiveTaskScreenProps) {
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(task?.id ?? null);
  const [conversationId, setConversationId] = useState<string | undefined>(task?.conversation_id ?? undefined);
  const [frameBase64, setFrameBase64] = useState<string | null>(null);
  const [showFrame, setShowFrame] = useState(true);
  const [activeApproval, setActiveApproval] = useState<ApprovalRow | null>(null);
  const [decidingApproval, setDecidingApproval] = useState(false);
  const [isWorking, setIsWorking] = useState<boolean>(Boolean(task));
  const [chatInput, setChatInput] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const frameExpiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const updateFrame = (nextBase64: string | null) => {
    if (frameExpiryTimerRef.current) {
      clearTimeout(frameExpiryTimerRef.current);
      frameExpiryTimerRef.current = null;
    }
    setFrameBase64(nextBase64);
    if (nextBase64) {
      frameExpiryTimerRef.current = setTimeout(() => {
        setFrameBase64(null);
      }, 5000);
    }
  };

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [chatInput]);

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;

    const handleViewportChange = () => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    vv.addEventListener('resize', handleViewportChange);
    return () => {
      vv.removeEventListener('resize', handleViewportChange);
    };
  }, []);

  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    if (task?.prompt) {
      return [
        {
          id: `user-${task.id}`,
          type: 'user',
          text: task.prompt,
          time: task.created_at,
        },
      ];
    }
    return [];
  });

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const [liveMachine, setLiveMachine] = useState<MachineRow | undefined>(machine);
  const lastActivityRef = useRef<number>(Date.now());

  const resolvedMachineName = machineName || liveMachine?.name || machine?.name || 'Remote Mac';
  const targetMachineId = task?.machine_id || liveMachine?.id || machine?.id;

  useEffect(() => {
    if (machine) {
      setLiveMachine(machine);
    }
  }, [machine]);

  const handleCheckConnection = async () => {
    try {
      const list = await apiClient.listMachines();
      const match = list.find((m) => m.id === targetMachineId);
      if (match) {
        setLiveMachine(match);
      }
      lastActivityRef.current = Date.now();
    } catch {}
  };

  useEffect(() => {
    const interval = setInterval(handleCheckConnection, 8000);
    return () => clearInterval(interval);
  }, [targetMachineId]);

  const isFreshHeartbeat = Boolean(
    liveMachine?.status === 'online' &&
    liveMachine?.last_seen_at &&
    Date.now() - new Date(liveMachine.last_seen_at).getTime() < 45000
  );
  const isRecentlyActive = Date.now() - lastActivityRef.current < 45000;
  const isMachineOnline = isWorking || isRecentlyActive || isFreshHeartbeat;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [messages, isWorking]);

  useEffect(() => {
    if (!currentTaskId) return;

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
          setMessages((prev) =>
            prev.map((m) => (m.type === 'tool' && m.toolStatus === 'active' ? { ...m, toolStatus: 'done' } : m))
          );
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
          const mapped = prev.map((m) =>
            m.type === 'tool' && m.toolStatus === 'active' ? { ...m, toolStatus: 'done' as const } : m
          );
          const filtered = mapped.filter((m) => m.type !== 'thinking');
          const lastUserIdx = filtered.findLastIndex((m) => m.type === 'user');
          const hasAgentAfterLastUser = filtered
            .slice(lastUserIdx + 1)
            .some((m) => m.type === 'agent' && (m.text?.length ?? 0) > 0);
          if (!hasAgentAfterLastUser && payload?.summary) {
            const rawSummary = String(payload.summary).trim();
            const text = rawSummary === 'Task completed without text output'
              ? 'Task completed successfully.'
              : rawSummary;
            return [
              ...filtered,
              {
                id: `result-${Date.now()}`,
                type: 'agent',
                text,
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
          ...prev.map((m) =>
            m.type === 'tool' && m.toolStatus === 'active' ? { ...m, toolStatus: 'done' as const } : m
          ),
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
        const list = await apiClient.listEvents(currentTaskId!);
        if (closed) return;
        if (list.length > 0) {
          lastActivityRef.current = Date.now();
        }
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
        lastActivityRef.current = Date.now();
        const msg = parseResult.message;

        if (msg.type === 'task.frame') {
          updateFrame(msg.jpeg_base64);
        } else if (msg.type === 'task.event') {
          if ((msg.event as any)?.id) {
            seenEventIds.add(String((msg.event as any).id));
          }
          processIncomingEvent(msg.event.kind, msg.event.payload);
        } else if (msg.type === 'approval.requested') {
          setActiveApproval({
            id: msg.approval_id,
            task_id: msg.task_id,
            owner_id: task?.owner_id || '',
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
      if (frameExpiryTimerRef.current) {
        clearTimeout(frameExpiryTimerRef.current);
        frameExpiryTimerRef.current = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {}
      }
    };
  }, [currentTaskId, webSocketFactory, task?.owner_id]);

  const [autoSendVoice, setAutoSendVoice] = useState(false);
  const voiceBasePromptRef = useRef('');

  const handleSendMessage = async (overridePrompt?: string) => {
    const text = (typeof overridePrompt === 'string' ? overridePrompt : chatInput).trim();
    if (!text || sendingMessage || !targetMachineId) return;

    if (isVoiceListening) {
      stopVoiceListening();
    }

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
        machine_id: targetMachineId,
        prompt: text,
        kind: task?.kind ?? 'browser',
        mode: task?.mode ?? 'default',
        conversation_id: resolvedConversationId,
        workspace_path: task?.workspace_path ?? undefined,
        model: 'gemini-3.8-flash-high',
        effort: 'high',
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

  const handleSpeechEnd = (spokenText: string) => {
    if (autoSendVoice && spokenText.trim().length > 0) {
      const fullText = voiceBasePromptRef.current
        ? `${voiceBasePromptRef.current} ${spokenText.trim()}`
        : spokenText.trim();
      handleSendMessage(fullText);
    }
  };

  const handleTranscriptChange = (spokenText: string, isFinal: boolean) => {
    const fullText = voiceBasePromptRef.current
      ? `${voiceBasePromptRef.current} ${spokenText.trim()}`
      : spokenText.trim();
    setChatInput(fullText);
  };

  const {
    isSupported: isVoiceSupported,
    isListening: isVoiceListening,
    startListening: startVoiceListening,
    stopListening: stopVoiceListening,
  } = useVoiceInput({
    onTranscriptChange: handleTranscriptChange,
    onSpeechEnd: handleSpeechEnd,
    silenceTimeoutMs: autoSendVoice ? 3000 : 0,
  });

  const handleToggleVoice = () => {
    if (isVoiceListening) {
      stopVoiceListening();
    } else {
      voiceBasePromptRef.current = chatInput.trim();
      startVoiceListening();
    }
  };

  const handleCancelVoice = () => {
    stopVoiceListening();
    setChatInput(voiceBasePromptRef.current);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleFocus = () => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 120);
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

  const handleStopTask = async () => {
    setIsWorking(false);
    setSendingMessage(false);
    if (!currentTaskId) return;

    try {
      await apiClient.cancelTask(currentTaskId);
    } catch {}

    setMessages((prev) => {
      const mapped = prev.map((m) =>
        m.type === 'tool' && m.toolStatus === 'active' ? { ...m, toolStatus: 'done' as const } : m
      );
      return [
        ...mapped.filter((m) => m.type !== 'thinking'),
        {
          id: `cancelled-${Date.now()}`,
          type: 'agent',
          text: '🛑 Task cancelled by user.',
          time: new Date().toISOString(),
        },
      ];
    });
  };

  const activeInfo = getActiveWorkingInfo(messages);
  const promptSuggestions = [
    'Check git status & recent changes',
    'Open browser and search web',
    'Inspect running processes',
    'Run tests and verify build',
  ];

  return (
    <div className="chat-screen">
      <header className="chat-nav-header" style={{ position: 'sticky', top: 0, zIndex: 50 }}>
        <button className="chat-nav-back-circle" onClick={onBack} aria-label="Back to machines">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div className="chat-nav-center">
          <div className="chat-nav-device-avatar">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </div>
          <div className="chat-nav-info">
            <div className="chat-nav-title">{resolvedMachineName}</div>
            <div
              className={`chat-nav-status ${isWorking ? 'working' : isMachineOnline ? 'ready' : 'offline'}`}
              onClick={handleCheckConnection}
              title="Tap to check connection"
              style={{ cursor: 'pointer' }}
            >
              {isWorking ? (
                <>
                  <ThinkingOrb state="working" size={20} theme="dark" role="presentation" />
                  <span>agy working...</span>
                </>
              ) : isMachineOnline ? (
                <>
                  <span className="status-dot" />
                  <span>Online · Ready</span>
                </>
              ) : (
                <>
                  <span className="status-dot" style={{ background: 'var(--accent-amber)' }} />
                  <span style={{ color: 'var(--accent-amber)' }}>Offline · rh start needed</span>
                </>
              )}
            </div>
          </div>
        </div>
        {frameBase64 ? (
          <button className="chat-nav-btn" onClick={() => setShowFrame(!showFrame)}>
            <span>📺</span>
            <span>{showFrame ? 'Hide' : 'Screen'}</span>
          </button>
        ) : (
          <div style={{ width: 36 }} />
        )}
      </header>

      <div className="chat-scroll-area">
        {messages.length === 0 && (
          <div className="chat-welcome-state">
            <div className="chat-welcome-icon">
              <ThinkingOrb state="breathing" size={56} theme="dark" role="presentation" />
            </div>
            <h3 className="chat-welcome-title">New Task on {resolvedMachineName}</h3>
            <p className="chat-welcome-desc">
              Message agy below to perform browsing, coding, and system actions directly on this machine.
            </p>
            {!isMachineOnline && (
              <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 8, background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.25)', display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '0.8125rem', color: '#fbbf24' }}>
                <span>⚠️</span>
                <span>Computer offline. Run <code>rh start</code> in terminal to connect.</span>
              </div>
            )}
            <div className="chat-suggestions-grid">
              {promptSuggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="chat-suggestion-chip"
                  onClick={() => {
                    setChatInput(suggestion);
                    textareaRef.current?.focus();
                  }}
                >
                  <span className="suggestion-spark">✦</span>
                  <span>{suggestion}</span>
                </button>
              ))}
            </div>
          </div>
        )}

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
                <div className="chat-agent-header">
                  <span className="chat-agent-spark">✦</span>
                  <span>agy</span>
                </div>
                <MarkdownView
                  content={item.message.text || ''}
                  isLatest={isWorking && item.isLatest}
                />
              </div>
            );
          }

          if (item.kind === 'error') {
            return (
              <div key={item.message.id} className="error-banner" style={{ margin: '4px 0' }}>
                <div className="error-banner-title">Error</div>
                <div style={{ fontSize: '0.8125rem' }}>{item.message.text}</div>
              </div>
            );
          }

          return null;
        })}

        {isWorking && (
          <div className="chat-inline-status" data-testid="thinking-orb-indicator">
            <ThinkingOrb state={activeInfo.state} size={20} theme="dark" role="presentation" />
            <span className="chat-inline-status-text">{activeInfo.text}</span>
          </div>
        )}

        {showFrame && frameBase64 && (
          <div className="chat-inline-frame" style={{ margin: '8px 0 12px 0' }}>
            <FrameViewer frameBase64={frameBase64} onClose={() => setShowFrame(false)} />
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-container">
        {isVoiceListening && (
          <div className="voice-listening-banner" data-testid="voice-listening-banner">
            <div className="voice-listening-left">
              <div className="voice-soundwave">
                <span className="voice-soundwave-bar" />
                <span className="voice-soundwave-bar" />
                <span className="voice-soundwave-bar" />
                <span className="voice-soundwave-bar" />
                <span className="voice-soundwave-bar" />
              </div>
              <span className="voice-listening-text">
                {chatInput ? 'Transcribing speech...' : 'Listening... speak your prompt'}
              </span>
            </div>
            <div className="voice-listening-actions">
              <button
                type="button"
                className={`voice-autosend-pill ${autoSendVoice ? 'active' : ''}`}
                onClick={() => setAutoSendVoice(!autoSendVoice)}
                title="Automatically dispatch when you stop speaking"
              >
                <span>⚡ Auto-send: {autoSendVoice ? 'ON' : 'OFF'}</span>
              </button>
              <button
                type="button"
                className="voice-stop-btn"
                onClick={stopVoiceListening}
                title="Stop recording and keep text"
              >
                Stop
              </button>
              <button
                type="button"
                className="voice-cancel-btn"
                onClick={handleCancelVoice}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="chat-composer-card">
          <textarea
            ref={textareaRef}
            rows={1}
            className="chat-input-field"
            data-testid="task-prompt-input"
            placeholder={`Message agy on ${resolvedMachineName}...`}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={handleFocus}
            disabled={sendingMessage}
          />
          <div className="chat-composer-actions">
            <div className="chat-composer-left">
              <VoiceButton
                isListening={isVoiceListening}
                isSupported={isVoiceSupported}
                onToggle={handleToggleVoice}
                disabled={sendingMessage}
              />
              <div className="chat-model-pill">
                <span className="model-pill-dot" />
                <span>Hermes</span>
              </div>
            </div>
            {isWorking ? (
              <button
                className="chat-send-button stop"
                data-testid="stop-task-btn"
                onClick={handleStopTask}
                aria-label="Stop task"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
              </button>
            ) : (
              <button
                className="chat-send-button"
                data-testid="submit-task-btn"
                onClick={() => handleSendMessage()}
                disabled={!chatInput.trim() || sendingMessage}
                aria-label="Send message"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'translateY(-0.5px)' }}>
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
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
