import { useState, useEffect } from 'react';
import {
  safeParseRealtimeMessage,
  type TaskRow,
  type ApprovalRow,
} from '@remote-hands/shared';
import { apiClient } from '../api/client.js';
import { FrameViewer } from '../components/FrameViewer.js';
import { EventTimeline, type TimelineEventItem } from '../components/EventTimeline.js';
import { ApprovalSheet } from '../components/ApprovalSheet.js';

export interface LiveTaskScreenProps {
  task: TaskRow;
  onBack: () => void;
  webSocketFactory?: ((taskId: string) => any) | undefined;
}

export function LiveTaskScreen({ task, onBack, webSocketFactory }: LiveTaskScreenProps) {
  const [currentTask, setCurrentTask] = useState<TaskRow>(task);
  const [frameBase64, setFrameBase64] = useState<string | null>(null);
  const [events, setEvents] = useState<TimelineEventItem[]>([]);
  const [activeApproval, setActiveApproval] = useState<ApprovalRow | null>(null);
  const [decidingApproval, setDecidingApproval] = useState(false);

  useEffect(() => {
    let ws: any = null;
    let closed = false;

    async function loadInitial() {
      try {
        const initialEvents = await apiClient.listEvents(currentTask.id);
        if (!closed && initialEvents.length > 0) {
          const mapped = initialEvents.map((e) => ({
            id: e.id,
            kind: e.kind,
            text: typeof e.payload === 'object' && e.payload && 'text' in e.payload ? String((e.payload as any).text) : undefined,
            time: e.created_at,
          }));
          setEvents((prev) => {
            const existingIds = new Set(prev.map((p) => p.id));
            const newOnes = mapped.filter((m) => !existingIds.has(m.id));
            return [...newOnes, ...prev];
          });
        }
      } catch {}
    }
    loadInitial();

    try {
      const socket = webSocketFactory
        ? webSocketFactory(currentTask.id)
        : apiClient.createTaskWebSocket(currentTask.id);
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
          const payloadObj = msg.event.payload as any;
          let text: string | undefined;
          if (payloadObj && typeof payloadObj === 'object') {
            if ('text' in payloadObj) text = String(payloadObj.text);
            else if ('label' in payloadObj) text = String(payloadObj.label);
            else if ('summary' in payloadObj) text = String(payloadObj.summary);
            else if ('message' in payloadObj) text = String(payloadObj.message);
          }
          setEvents((prev) => [
            ...prev,
            {
              id: Date.now() + Math.random(),
              kind: msg.event.kind,
              text,
              time: new Date().toISOString(),
            },
          ]);
        } else if (msg.type === 'approval.requested') {
          setActiveApproval({
            id: msg.approval_id,
            task_id: msg.task_id,
            owner_id: currentTask.owner_id,
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
      if (ws) {
        try {
          ws.close();
        } catch {}
      }
    };
  }, [currentTask.id, webSocketFactory]);

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
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <button
          className="btn"
          style={{ width: 'auto', padding: '6px 12px', background: 'transparent', color: 'var(--text-secondary)' }}
          onClick={onBack}
        >
          ← Machines
        </button>
        <span className="badge badge-online">Live Task</span>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>Prompt</div>
        <div style={{ fontSize: '0.875rem', color: 'var(--text-primary)', fontWeight: 500 }}>
          {currentTask.prompt}
        </div>
      </div>

      <FrameViewer frameBase64={frameBase64} />

      <div style={{ marginBottom: 8 }}>
        <h3 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
          Live Events
        </h3>
      </div>

      <EventTimeline events={events} />

      <ApprovalSheet
        approval={activeApproval}
        onApprove={handleApprove}
        onReject={handleReject}
        loading={decidingApproval}
      />
    </div>
  );
}
