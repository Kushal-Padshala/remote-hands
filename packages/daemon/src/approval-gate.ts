import type {
  ActionKind,
  ApprovalRow,
  RiskLevel,
  ApprovalDecision,
} from '@remote-hands/shared';
import type { CloudflareControlPlaneClient } from './cloudflare-client.js';
import type { RealtimeClient } from './realtime-client.js';

export interface ApprovalGateOptions {
  client: CloudflareControlPlaneClient;
  realtime?: RealtimeClient | undefined;
  defaultTimeoutMs?: number | undefined;
}

export interface RequestApprovalInput {
  taskId: string;
  actionKind: ActionKind;
  summary: string;
  risk: RiskLevel;
  toolPayload?: unknown;
  framePath?: string | null | undefined;
  timeoutMs?: number | undefined;
}

export interface ApprovalDecisionResult {
  status: ApprovalDecision;
  approvalId: string;
}

export class ApprovalGate {
  private readonly client: CloudflareControlPlaneClient;
  private readonly realtime?: RealtimeClient | undefined;
  private readonly defaultTimeoutMs: number;

  constructor(options: ApprovalGateOptions) {
    this.client = options.client;
    this.realtime = options.realtime;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60000;
  }

  async requestApproval(input: RequestApprovalInput): Promise<ApprovalRow> {
    const approval = await this.client.createApproval({
      task_id: input.taskId,
      action_kind: input.actionKind,
      summary: input.summary,
      risk: input.risk,
      tool_payload: input.toolPayload ?? {},
      frame_path: input.framePath ?? null,
      timeout_ms: input.timeoutMs,
    });

    if (this.realtime) {
      this.realtime.send({
        type: 'approval.requested',
        task_id: input.taskId,
        approval_id: approval.id,
      });
    }

    return approval;
  }

  waitForApprovalDecision(
    approvalId: string,
    timeoutMs?: number,
  ): Promise<ApprovalDecisionResult> {
    const timeout = timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<ApprovalDecisionResult>((resolve) => {
      let resolved = false;
      let unsubscribe: (() => void) | null = null;
      let timer: any = null;

      const finish = (result: ApprovalDecisionResult) => {
        if (resolved) return;
        resolved = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        resolve(result);
      };

      if (this.realtime) {
        unsubscribe = this.realtime.onMessage((msg) => {
          if (msg.type === 'approval.decided' && msg.approval_id === approvalId) {
            finish({
              status: msg.decision,
              approvalId,
            });
          }
        });
      }

      timer = setTimeout(() => {
        finish({
          status: 'expired',
          approvalId,
        });
      }, timeout);
    });
  }

  async resolveApprovalOrTimeout(input: RequestApprovalInput): Promise<ApprovalDecisionResult> {
    const approval = await this.requestApproval(input);
    const timeout = input.timeoutMs ?? this.defaultTimeoutMs;
    return await this.waitForApprovalDecision(approval.id, timeout);
  }
}
