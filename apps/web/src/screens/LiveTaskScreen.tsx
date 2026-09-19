import { useState, useEffect, useRef } from 'react';
import {
  safeParseRealtimeMessage,
  type TaskRow,
  type ApprovalRow,
  type MachineRow,
  type TaskKind,
} from '@remote-hands/shared';
import { apiClient } from '../api/client.js';
import { FrameViewer } from '../components/FrameViewer.js';
import { ApprovalSheet } from '../components/ApprovalSheet.js';
import { StepsDropdown, type ChatStep } from '../components/StepsDropdown.js';
import { MarkdownView } from '../components/MarkdownView.js';
import { SafeThinkingOrb as ThinkingOrb } from '../components/SafeThinkingOrb.js';
import { VoiceButton } from '../components/VoiceButton.js';
import { useVoiceInput } from '../hooks/useVoiceInput.js';

export function inferTaskKind(prompt: string): TaskKind {
  const lower = prompt.toLowerCase();

  const explicitBrowserPatterns = [
    'https://', 'http://', 'www.',
    '.com', '.org', '.io', '.net', '.dev', '.app', '.ai',
    'browse ', 'browser', 'navigate to', 'visit ', 'open url',
    'website', 'webpage', 'web page', 'x.com', 'twitter.com',
    'twitter', 'tweet', 'retweet', 'x post', 'on x', 'personal profile',
  ];
  for (const p of explicitBrowserPatterns) {
    if (lower.includes(p)) return 'browser';
  }

  const codingWords = [
    'fix', 'bug', 'code', 'file', 'refactor', 'test', 'build', 'compile',
    'git', 'commit', 'branch', 'merge', 'pr', 'pull request', 'repo',
    'npm', 'pnpm', 'yarn', 'pip', 'python', 'typescript', 'javascript',
    'css', 'html', 'component', 'function', 'method', 'variable', 'import',
    'export', 'error', 'exception', 'stack trace', 'terminal', 'shell',
    'script', 'bash', 'zsh', 'lint', 'prettier', 'vitest', 'jest',
  ];
  for (const w of codingWords) {
    const regex = new RegExp(`\\b${w}\\b`, 'i');
    if (regex.test(prompt)) return 'coding';
  }

  const genericBrowserWords = [
    'page', 'chrome', 'google', 'search online', 'look up online',
    'fill out', 'sign in to', 'log in to', 'click on', 'open ',
  ];
  for (const w of genericBrowserWords) {
    if (lower.includes(w)) return 'browser';
  }

  return 'browser';
}

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
  const [taskKind, setTaskKind] = useState<TaskKind>(task?.kind ?? 'browser');
  const [frameBase64, setFrameBase64] = useState<string | null>(null);
  const [showFrame, setShowFrame] = useState(true);
  const [activeApproval, setActiveApproval] = useState<ApprovalRow | null>(null);
  const [decidingApproval, setDecidingApproval] = useState(false);

  const isTaskActive = (t?: TaskRow | null) =>
    Boolean(t && (t.status === 'queued' || t.status === 'claimed' || t.status === 'running'));

  const [isWorking, setIsWorking] = useState<boolean>(isTaskActive(task));
  const [chatInput, setChatInput] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const frameExpiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dismissedApprovalIdsRef = useRef<Set<string>>(new Set());

  const handleDismissApproval = (approvalId?: string) => {
    const id = approvalId || activeApproval?.id;
    if (id) {
      dismissedApprovalIdsRef.current.add(id);
    }
    setActiveApproval(null);
  };

  useEffect(() => {
    if (task) {
      setCurrentTaskId(task.id);
      setConversationId(task.conversation_id ?? undefined);
      if (task.kind) setTaskKind(task.kind);
      setIsWorking(isTaskActive(task));
    }
  }, [task?.id]);

  useEffect(() => {
    if (task?.kind) {
      setTaskKind(task.kind);
    }
  }, [task?.kind]);

  useEffect(() => {
    setFrameBase64(null);
    if (frameExpiryTimerRef.current) {
      clearTimeout(frameExpiryTimerRef.current);
      frameExpiryTimerRef.current = null;
    }
  }, [currentTaskId]);

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

  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const list: ChatMessage[] = [];
    if (task?.prompt) {
      list.push({
        id: `user-${task.id}`,
        type: 'user',
        text: task.prompt,
        time: task.created_at,
      });
    }
    if (task?.result_summary) {
      list.push({
        id: `agent-summary-${task.id}`,
        type: 'agent',
        text: task.result_summary === 'Task completed without text output'
          ? 'Task completed successfully.'
          : task.result_summary,
        time: task.finished_at || task.created_at,
      });
    } else if (task?.status === 'failed' && task?.error) {
      list.push({
        id: `error-${task.id}`,
        type: 'error',
        text: task.error,
        time: task.finished_at || task.created_at,
      });
    }
    return list;
  });

  useEffect(() => {
    if (!task?.conversation_id) return;
    let isCancelled = false;

    apiClient.listTasks({ conversation_id: task.conversation_id }).then((tasks) => {
      if (isCancelled || tasks.length <= 1) return;
      const conversationMessages: ChatMessage[] = [];
      for (const t of tasks) {
        if (t.prompt) {
          conversationMessages.push({
            id: `user-${t.id}`,
            type: 'user',
            text: t.prompt,
            time: t.created_at,
          });
        }
        if (t.result_summary) {
          conversationMessages.push({
            id: `agent-${t.id}`,
            type: 'agent',
            text: t.result_summary === 'Task completed without text output'
              ? 'Task completed successfully.'
              : t.result_summary,
            time: t.finished_at || t.created_at,
          });
        } else if (t.status === 'failed' && t.error) {
          conversationMessages.push({
            id: `error-${t.id}`,
            type: 'error',
            text: t.error,
            time: t.finished_at || t.created_at,
          });
        }
      }
      if (conversationMessages.length > 0) {
        setMessages(conversationMessages);
      }
    }).catch(() => {});

    return () => {
      isCancelled = true;
    };
  }, [task?.conversation_id]);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const chatScrollAreaRef = useRef<HTMLDivElement | null>(null);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const [viewportOffsetTop, setViewportOffsetTop] = useState<number>(0);
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);

  const scrollToBottom = (smooth = true) => {
    const el = chatScrollAreaRef.current;
    if (!el) return;
    if (smooth && typeof el.scrollTo === 'function') {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: 'smooth',
      });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  };

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.add('chat-mode-active');
      document.body.classList.add('chat-mode-active');
    }
    return () => {
      if (typeof document !== 'undefined') {
        document.documentElement.classList.remove('chat-mode-active');
        document.body.classList.remove('chat-mode-active');
      }
    };
  }, []);

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;

    const updateViewport = () => {
      if (!vv) return;
      const height = Math.round(vv.height);
      const offsetTop = Math.round(vv.offsetTop);
      const keyboardOpen = typeof window !== 'undefined' && window.innerHeight - height > 100;

      setViewportHeight(height);
      setViewportOffsetTop(offsetTop);
      setIsKeyboardOpen(keyboardOpen);

      if (typeof document !== 'undefined') {
        document.documentElement.style.setProperty('--visual-viewport-height', `${height}px`);
        document.documentElement.style.setProperty('--visual-viewport-offset-top', `${offsetTop}px`);
      }

      if (typeof window !== 'undefined' && (window.scrollY !== 0 || window.scrollX !== 0)) {
        window.scrollTo(0, 0);
      }
    };

    updateViewport();

    if (vv) {
      vv.addEventListener('resize', updateViewport);
      vv.addEventListener('scroll', updateViewport);
    }

    const handleWindowScroll = () => {
      if (typeof window !== 'undefined' && (window.scrollY !== 0 || window.scrollX !== 0)) {
        window.scrollTo(0, 0);
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('scroll', handleWindowScroll, { passive: true });
    }

    return () => {
      if (vv) {
        vv.removeEventListener('resize', updateViewport);
        vv.removeEventListener('scroll', updateViewport);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('scroll', handleWindowScroll);
      }
      if (typeof document !== 'undefined') {
        document.documentElement.style.removeProperty('--visual-viewport-height');
        document.documentElement.style.removeProperty('--visual-viewport-offset-top');
      }
    };
  }, []);

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
    scrollToBottom(true);
  }, [messages, isWorking]);

  useEffect(() => {
    if (viewportHeight !== null) {
      scrollToBottom(false);
    }
  }, [viewportHeight]);

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
      } else if (kind === 'approval_rejected') {
        const reason = payload?.reason;
        if (reason) {
          setMessages((prev) => {
            const alreadyPresent = prev.some(
              (m) => m.type === 'user' && m.text?.includes(reason)
            );
            if (alreadyPresent) return prev;
            return [
              ...prev,
              {
                id: `rejection-${Date.now()}-${Math.random()}`,
                type: 'user',
                text: `Rejected with feedback: ${reason}`,
                time: new Date().toISOString(),
              },
            ];
          });
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
        const text = typeof payload === 'object' && payload?.text !== undefined ? String(payload.text) : String(payload || 'Analyzing...');
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.type === 'thinking') {
            const updated = [...prev];
            updated[updated.length - 1] = {
              ...last,
              text,
            };
            return updated;
          }
          return [
            ...prev,
            {
              id: `thinking-${Date.now()}-${Math.random()}`,
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
          return [
            ...prev,
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
          const lastUserIdx = mapped.findLastIndex((m) => m.type === 'user');
          const hasAgentAfterLastUser = mapped
            .slice(lastUserIdx + 1)
            .some((m) => m.type === 'agent' && (m.text?.length ?? 0) > 0);
          if (!hasAgentAfterLastUser && payload?.summary) {
            const rawSummary = String(payload.summary).trim();
            const text = rawSummary === 'Task completed without text output'
              ? 'Task completed successfully.'
              : rawSummary;
            return [
              ...mapped,
              {
                id: `result-${Date.now()}`,
                type: 'agent',
                text,
                time: new Date().toISOString(),
              },
            ];
          }
          return mapped;
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

      try {
        const approvals = await apiClient.listTaskApprovals(currentTaskId!);
        if (closed) return;
        const pending = approvals.find(
          (a) =>
            a.decision === 'pending' &&
            Date.now() < Date.parse(a.expires_at) &&
            !dismissedApprovalIdsRef.current.has(a.id)
        );
        if (pending) {
          setActiveApproval((prev) => {
            if (!prev) return pending;
            return {
              ...pending,
              frame_path: pending.frame_path || (prev.id === pending.id ? prev.frame_path : null) || frameBase64 || null,
            };
          });
        } else {
          setActiveApproval((prev) =>
            prev &&
            prev.decision === 'pending' &&
            Date.now() < Date.parse(prev.expires_at) &&
            !dismissedApprovalIdsRef.current.has(prev.id)
              ? prev
              : null
          );
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
        if (closed) return;
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
          if (msg.task_id && currentTaskId && msg.task_id !== currentTaskId) return;
          updateFrame(msg.jpeg_base64);
        } else if (msg.type === 'task.event') {
          if ((msg.event as any)?.id) {
            seenEventIds.add(String((msg.event as any).id));
          }
          processIncomingEvent(msg.event.kind, msg.event.payload);
        } else if (msg.type === 'approval.requested') {
          if (dismissedApprovalIdsRef.current.has(msg.approval_id)) return;
          setActiveApproval({
            id: msg.approval_id,
            task_id: msg.task_id,
            owner_id: task?.owner_id || '',
            action_kind: ((msg as any).action_kind || 'publish') as any,
            summary: (msg as any).summary || 'Action requires confirmation',
            risk: ((msg as any).risk || 'high') as any,
            tool_payload: {},
            frame_path: (msg as any).frame_base64 || frameBase64 || null,
            decision: 'pending',
            decided_at: null,
            expires_at: new Date(Date.now() + 60000).toISOString(),
            created_at: new Date().toISOString(),
          });
          apiClient.getApproval(msg.approval_id).then((res) => {
            if (res.approval) {
              setActiveApproval((prev) => {
                if (!prev || prev.id !== res.approval.id) return res.approval;
                return {
                  ...res.approval,
                  frame_path: res.approval.frame_path || prev.frame_path || frameBase64 || null,
                };
              });
            }
          }).catch(() => {});
        } else if (msg.type === 'approval.decided') {
          setActiveApproval((prev) => (prev?.id === msg.approval_id ? null : prev));
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
          ws.onmessage = null;
          ws.onopen = null;
          ws.onerror = null;
          ws.onclose = null;
          ws.close();
        } catch {}
      }
    };
  }, [currentTaskId, webSocketFactory]);

  const [autoSendVoice, setAutoSendVoice] = useState(false);
  const voiceBasePromptRef = useRef('');

  const handleSendMessage = async (textToSend?: string) => {
    const text = (textToSend ?? chatInput).trim();
    if (!text || sendingMessage || !targetMachineId) return;

    setSendingMessage(true);
    setChatInput('');
    setFrameBase64(null);

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

      const targetKind = inferTaskKind(text);
      setTaskKind(targetKind);

      const nextTask = await apiClient.createTask({
        machine_id: targetMachineId,
        prompt: text,
        kind: targetKind,
        mode: task?.mode ?? 'default',
        conversation_id: resolvedConversationId,
        workspace_path: task?.workspace_path ?? undefined,
        model: 'gemini-3.8-flash-high',
        effort: 'high',
      });
      setFrameBase64(null);
      setCurrentTaskId(nextTask.id);
      if (nextTask.conversation_id) {
        setConversationId(nextTask.conversation_id);
      }
    } catch (err: any) {
      setChatInput(text);
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
    cancelListening: cancelVoiceListening,
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
    cancelVoiceListening();
    setChatInput(voiceBasePromptRef.current);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleFocus = () => {
    if (typeof window !== 'undefined') {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    }
    setTimeout(() => {
      if (typeof window !== 'undefined') {
        window.scrollTo(0, 0);
      }
      scrollToBottom(false);
    }, 50);
    setTimeout(() => {
      if (typeof window !== 'undefined') {
        window.scrollTo(0, 0);
      }
      scrollToBottom(true);
    }, 250);
  };

  const handleApprove = async (approvalId: string) => {
    setDecidingApproval(true);
    try {
      await apiClient.decideApproval(approvalId, 'approved');
      handleDismissApproval(approvalId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('expired')) {
        handleDismissApproval(approvalId);
        setMessages((prev) => [
          ...prev,
          {
            id: `approval-expired-${Date.now()}`,
            type: 'error',
            text: 'Action approval expired. The pending request timed out.',
            time: new Date().toISOString(),
          },
        ]);
      } else {
        alert(msg);
      }
    } finally {
      setDecidingApproval(false);
    }
  };

  const handleReject = async (approvalId: string, reason?: string) => {
    setDecidingApproval(true);
    try {
      await apiClient.decideApproval(approvalId, 'rejected', reason);
      handleDismissApproval(approvalId);
      if (reason) {
        setMessages((prev) => [
          ...prev,
          {
            id: `rejection-${Date.now()}-${Math.random()}`,
            type: 'user',
            text: `Rejected with feedback: ${reason}`,
            time: new Date().toISOString(),
          },
        ]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('expired')) {
        handleDismissApproval(approvalId);
        setMessages((prev) => [
          ...prev,
          {
            id: `approval-expired-${Date.now()}`,
            type: 'error',
            text: 'Action approval expired. The pending request timed out.',
            time: new Date().toISOString(),
          },
        ]);
      } else {
        alert(msg);
      }
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
  const formatMessageTime = (iso?: string) => {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  };
  const promptSuggestions: { title: string; sub: string; icon: string }[] = [
    { title: 'Check git status & recent changes', sub: 'Review diffs and history', icon: '🌿' },
    { title: 'Open browser and search web', sub: 'Navigate and research', icon: '🌐' },
    { title: 'Inspect running processes', sub: 'Check system health', icon: '⚡' },
    { title: 'Run tests and verify build', sub: 'Validate your code', icon: '✅' },
  ];

  return (
    <div
      className="chat-screen"
      style={{
        height: viewportHeight ? `${viewportHeight}px` : undefined,
        maxHeight: viewportHeight ? `${viewportHeight}px` : undefined,
        transform: viewportOffsetTop > 0 ? `translateY(${viewportOffsetTop}px)` : undefined,
      }}
    >
      <header className="chat-nav-header" style={{ position: 'sticky', top: 0, zIndex: 50 }}>
        <button className="chat-nav-back-circle" onClick={onBack} aria-label="Back to machines">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div className="chat-nav-center">
          <div className="chat-machine-avatar" aria-hidden="true">
            {(resolvedMachineName || 'R').trim().charAt(0).toUpperCase()}
          </div>
          <div className="chat-nav-info">
            <div className="chat-nav-title">{resolvedMachineName}</div>
            <div
              className={`chat-nav-status ${isWorking ? 'working' : isMachineOnline ? 'ready' : 'offline'}`}
              onClick={handleCheckConnection}
              title="Tap to check connection"
              style={{ cursor: 'pointer' }}
            >
              <span className={`status-dot ${isWorking ? 'working' : ''}`} style={!isWorking && !isMachineOnline ? { background: 'var(--chat-warning)', boxShadow: '0 0 8px rgba(251, 191, 36, 0.6)' } : undefined} />
              <span>{isWorking ? 'Working...' : isMachineOnline ? 'Online' : 'Offline'}</span>
              {isWorking && <span aria-hidden="true" style={{ opacity: 0.55 }}>· agy active</span>}
            </div>
          </div>
        </div>
        {frameBase64 ? (
          <button className="chat-nav-btn" onClick={() => setShowFrame(!showFrame)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <span>{showFrame ? 'Hide screen' : 'View screen'}</span>
          </button>
        ) : (
          <div style={{ width: 32 }} />
        )}
      </header>

      <div ref={chatScrollAreaRef} className="chat-scroll-area">
        {messages.length === 0 && (
          <div className="chat-welcome-state">
            <div className="chat-welcome-icon">
              <div className="chat-welcome-orb-glow">
                <ThinkingOrb state="breathing" size={64} theme="dark" role="presentation" />
              </div>
            </div>
            <div className="chat-welcome-eyebrow">
              <span className="status-dot" />
              <span>{isMachineOnline ? 'Connected' : 'Ready'} · {resolvedMachineName}</span>
            </div>
            <h3 className="chat-welcome-title">New Task on {resolvedMachineName}</h3>
            <p className="chat-welcome-desc">
              Message <span className="chat-welcome-title-accent" style={{ fontWeight: 650 }}>agy</span> below to browse, code, and run system actions directly on this machine.
            </p>
            {!isMachineOnline && (
              <div className="chat-offline-notice">
                <span aria-hidden="true">⚠️</span>
                <span>Computer offline. Run <code>rh start</code> in terminal to connect.</span>
              </div>
            )}
            <div className="chat-suggestions-grid">
              {promptSuggestions.map((suggestion) => (
                <button
                  key={suggestion.title}
                  type="button"
                  className="chat-suggestion-chip"
                  onClick={() => {
                    setChatInput(suggestion.title);
                    textareaRef.current?.focus();
                  }}
                >
                  <span className="chat-suggestion-icon" aria-hidden="true">{suggestion.icon}</span>
                  <span className="chat-suggestion-text">
                    <span className="chat-suggestion-title">{suggestion.title}</span>
                    <span className="chat-suggestion-sub">{suggestion.sub}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {groupMessages(messages, isWorking).map((item) => {
          if (item.kind === 'user') {
            return (
              <div key={item.message.id} className="chat-message-user-wrap">
                <div className="chat-bubble-user">
                  {item.message.text}
                </div>
                {item.message.time && (
                  <div className="chat-user-time">{formatMessageTime(item.message.time)}</div>
                )}
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
              <div key={item.message.id} className="chat-message-agent-wrap">
                <div className="chat-agent-row">
                  <div className="chat-agent-avatar" aria-hidden="true">✦</div>
                  <span className="chat-agent-name">agy</span>
                  {item.message.time && (
                    <span className="chat-agent-time">{formatMessageTime(item.message.time)}</span>
                  )}
                </div>
                <div className="chat-bubble-agent">
                  <MarkdownView
                    content={item.message.text || ''}
                    isLatest={isWorking && item.isLatest}
                  />
                </div>
              </div>
            );
          }

          if (item.kind === 'error') {
            return (
              <div key={item.message.id} className="error-banner" style={{ margin: '4px 0' }}>
                <div className="error-banner-title">Something went wrong</div>
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
            <div className="frame-meta-bar">
              <span className="frame-profile-badge">🌐 Logged-in Chrome Profile</span>
            </div>
            <FrameViewer frameBase64={frameBase64} onClose={() => setShowFrame(false)} />
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className={`chat-input-container ${isKeyboardOpen ? 'keyboard-open' : ''}`}>
        {isVoiceListening && (
          <div className="voice-listening-banner" data-testid="voice-listening-banner">
            <div className="voice-listening-left">
              <div className="voice-soundwave" aria-hidden="true">
                <span className="voice-soundwave-bar" />
                <span className="voice-soundwave-bar" />
                <span className="voice-soundwave-bar" />
                <span className="voice-soundwave-bar" />
                <span className="voice-soundwave-bar" />
                <span className="voice-soundwave-bar" />
                <span className="voice-soundwave-bar" />
              </div>
              <span className="voice-listening-text">
                {chatInput ? 'Transcribing...' : 'Listening...'}
              </span>
            </div>
            <div className="voice-listening-actions">
              <button
                type="button"
                className={`voice-autosend-pill ${autoSendVoice ? 'active' : ''}`}
                onClick={() => setAutoSendVoice(!autoSendVoice)}
                title="Automatically dispatch when you stop speaking"
              >
                <span className="voice-autosend-dot" />
                <span>Auto-send {autoSendVoice ? 'On' : 'Off'}</span>
              </button>
              <button
                type="button"
                className="voice-stop-btn"
                onClick={stopVoiceListening}
                title="Finish speaking"
              >
                Done
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
            aria-label={`Message agy on ${resolvedMachineName}`}
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
        key={activeApproval?.id || 'none'}
        approval={activeApproval}
        frameBase64={frameBase64}
        onApprove={handleApprove}
        onReject={handleReject}
        onDismiss={() => handleDismissApproval(activeApproval?.id)}
        loading={decidingApproval}
      />
    </div>
  );
}
