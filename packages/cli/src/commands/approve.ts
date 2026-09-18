import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { CloudflareControlPlaneClient, DefaultFrameSource } from '@remote-hands/daemon';
import type { ActionKind, RiskLevel } from '@remote-hands/shared';
import type { CommandContext } from './setup.js';

export interface ApproveOptions {
  summary: string;
  action?: ActionKind | undefined;
  risk?: RiskLevel | undefined;
  taskId?: string | undefined;
  timeoutSeconds?: number | undefined;
}

export interface ParsedApproveArgs {
  summary?: string | undefined;
  action: ActionKind;
  risk: RiskLevel;
  taskId?: string | undefined;
  timeoutSeconds: number;
}

export function parseApproveArgs(args: string[]): ParsedApproveArgs {
  let summary: string | undefined;
  let action: ActionKind = 'other';
  let risk: RiskLevel = 'medium';
  let taskId: string | undefined = process.env.REMOTE_HANDS_TASK_ID;
  let timeoutSeconds = 60;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--action=')) {
      action = arg.slice('--action='.length) as ActionKind;
    } else if (arg === '--action' && i + 1 < args.length) {
      action = args[++i] as ActionKind;
    } else if (arg.startsWith('--risk=')) {
      risk = arg.slice('--risk='.length) as RiskLevel;
    } else if (arg === '--risk' && i + 1 < args.length) {
      risk = args[++i] as RiskLevel;
    } else if (arg.startsWith('--task=')) {
      taskId = arg.slice('--task='.length);
    } else if (arg === '--task' && i + 1 < args.length) {
      taskId = args[++i];
    } else if (arg.startsWith('--timeout=')) {
      const parsed = parseInt(arg.slice('--timeout='.length), 10);
      if (!isNaN(parsed) && parsed > 0) timeoutSeconds = parsed;
    } else if (arg === '--timeout' && i + 1 < args.length) {
      const parsed = parseInt(args[++i]!, 10);
      if (!isNaN(parsed) && parsed > 0) timeoutSeconds = parsed;
    } else if (!arg.startsWith('-') && !summary) {
      summary = arg;
    }
  }

  return { summary, action, risk, taskId, timeoutSeconds };
}

export async function approveCommand(args: string[], context: CommandContext = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const stderr = context.stderr ?? console.error;

  const parsed = parseApproveArgs(args);
  if (!parsed.summary) {
    stderr('Usage: rh approve "<summary>" [--action=<kind>] [--risk=<level>] [--task=<task_id>] [--timeout=<seconds>]');
    return 1;
  }

  if (!parsed.taskId) {
    stderr('Error: No task ID provided and REMOTE_HANDS_TASK_ID is not set.');
    return 1;
  }

  const configDir = context.configDir ?? path.join(os.homedir(), '.remote-hands');
  const daemonConfigFile = path.join(configDir, 'daemon.json');

  if (!fs.existsSync(daemonConfigFile)) {
    stderr(`Daemon configuration not found at ${daemonConfigFile}. Run "rh setup" first.`);
    return 1;
  }

  let rawConfig: any;
  try {
    const content = await fs.promises.readFile(daemonConfigFile, 'utf-8');
    rawConfig = JSON.parse(content);
  } catch (err: any) {
    stderr(`Failed to read daemon configuration: ${err.message}`);
    return 1;
  }

  const client =
    context.client ??
    new CloudflareControlPlaneClient({
      baseUrl: rawConfig.cloudflareApiUrl,
      sessionToken: rawConfig.sessionToken,
    });

  let framePath: string | null = null;
  try {
    const frameSource =
      context.frameSource ??
      new DefaultFrameSource({ taskStartTime: Date.now() - 10000, browserActive: true });
    const frame = await frameSource.captureFrame();
    if (frame?.jpegBase64) {
      framePath = frame.jpegBase64;
    }
  } catch {}

  let approval: any;
  try {
    approval = await client.createApproval({
      task_id: parsed.taskId,
      action_kind: parsed.action,
      summary: parsed.summary,
      risk: parsed.risk,
      frame_path: framePath,
      timeout_ms: parsed.timeoutSeconds * 1000,
    });
  } catch (err: any) {
    stderr(`Failed to create approval request: ${err.message || err}`);
    return 1;
  }

  stdout(`Approval request created (${approval.id}). Waiting for decision on mobile app...`);

  const startTime = Date.now();
  const timeoutMs = parsed.timeoutSeconds * 1000;

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const current = await client.getApproval(approval.id);
      if (current.decision === 'approved') {
        stdout('Approval granted.');
        return 0;
      }
      if (current.decision === 'rejected') {
        const reason =
          current.rejection_reason ||
          (typeof current.tool_payload === 'object' && current.tool_payload !== null
            ? (current.tool_payload as any).rejection_reason
            : null);
        if (reason) {
          stderr(`Approval rejected by user: ${reason}`);
        } else {
          stderr('Approval rejected by user.');
        }
        return 1;
      }
    } catch {}
  }

  stderr('Approval request timed out.');
  return 1;
}
