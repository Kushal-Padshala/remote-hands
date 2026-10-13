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

const TRIM_ABOVE_BYTES = 200_000;
const KEEP_LINES = 1000;

export function callLogPath(homeDir: string): string {
  return path.join(homeDir, '.remote-hands', 'computer', 'calls.jsonl');
}

/** Buckets an error message by its shape so the log never stores page content. */
export function classifyError(message: string): 'timeout' | 'stale' | 'other' {
  if (/timed out after/i.test(message)) return 'timeout';
  if (/Call browser_snapshot|no longer present|not in last snapshot|not on the page I last showed/i.test(message)) return 'stale';
  return 'other';
}

/** Appends a record (known fields only). Never throws: logging must not break a tool call. */
export function appendCallRecord(homeDir: string, record: ToolCallRecord): void {
  try {
    const safe: ToolCallRecord = { at: record.at, tool: record.tool, ms: Math.round(record.ms), ok: record.ok };
    if (record.kind !== undefined) safe.kind = record.kind;
    const file = callLogPath(homeDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(safe)}\n`);
    if (fs.statSync(file).size > TRIM_ABOVE_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().startsWith('{'));
      fs.writeFileSync(file, `${lines.slice(-KEEP_LINES).join('\n')}\n`);
    }
  } catch {
    // best effort
  }
}
