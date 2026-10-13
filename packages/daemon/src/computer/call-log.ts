import fs from 'node:fs';
import path from 'node:path';

/** One computer-use tool call: no arguments, no results, no page content. */
export interface ToolCallRecord {
  at: string;
  tool: string;
  ms: number;
  ok: boolean;
  kind?: 'timeout' | 'stale' | 'other';
}

const ROTATE_ABOVE_BYTES = 200_000;

export function callLogPath(homeDir: string): string {
  return path.join(homeDir, '.remote-hands', 'computer', 'calls.jsonl');
}

/** Buckets an error message by its shape so the log never stores page content. */
export function classifyError(message: string): 'timeout' | 'stale' | 'other' {
  if (/timed out after/i.test(message)) return 'timeout';
  if (/Call browser_snapshot|no longer present|not in last snapshot|not on the page I last showed/i.test(message)) return 'stale';
  return 'other';
}

/**
 * Appends a record (known fields only). Never throws: logging must not break a tool call.
 * When the file grows past ROTATE_ABOVE_BYTES it is renamed to `calls.jsonl.1` (replacing the
 * previous one) and the next call starts a fresh file. Renaming never rewrites existing lines, so
 * a full disk or a second server process cannot corrupt or drop records that were already written.
 */
export function appendCallRecord(homeDir: string, record: ToolCallRecord): void {
  try {
    const safe: ToolCallRecord = { at: record.at, tool: record.tool, ms: Math.round(record.ms), ok: record.ok };
    if (record.kind !== undefined) safe.kind = record.kind;
    const file = callLogPath(homeDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(safe)}\n`);
    if (fs.statSync(file).size > ROTATE_ABOVE_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // best effort
  }
}
