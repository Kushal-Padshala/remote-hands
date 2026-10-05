import fs from 'node:fs';
import path from 'node:path';

/** One fast-lane request, with no request text and no typed values. */
export interface FastLaneRunRecord {
  at: string;
  lane: 'skill' | 'pilot' | 'brain';
  result: 'handled' | 'continued' | 'stopped';
  elapsedMs: number;
  skill?: string;
  steps?: number;
  handoffReason?: string;
}

export interface RunSummary {
  total: number;
  handled: number;
  continued: number;
  stopped: number;
  medianHandledMs: number | null;
}

const MAX_LINES = 1000;
const KEEP_LINES = 500;

export function runLogPath(homeDir: string): string {
  return path.join(homeDir, '.remote-hands', 'fast-lane', 'runs.jsonl');
}

/** Appends a record (only its known fields) and trims old ones. Never throws: logging must not break a request. */
export function appendRunRecord(homeDir: string, record: FastLaneRunRecord): void {
  try {
    const safe: FastLaneRunRecord = { at: record.at, lane: record.lane, result: record.result, elapsedMs: Math.round(record.elapsedMs) };
    if (record.skill !== undefined) safe.skill = record.skill;
    if (record.steps !== undefined) safe.steps = record.steps;
    if (record.handoffReason !== undefined) safe.handoffReason = record.handoffReason;
    const file = runLogPath(homeDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(safe)}\n`);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) fs.writeFileSync(file, `${lines.slice(-KEEP_LINES).join('\n')}\n`);
  } catch {
    // best effort
  }
}

export function readRunSummary(homeDir: string, last = 50): RunSummary {
  const empty: RunSummary = { total: 0, handled: 0, continued: 0, stopped: 0, medianHandledMs: null };
  let lines: string[];
  try {
    lines = fs.readFileSync(runLogPath(homeDir), 'utf8').split('\n').filter(Boolean);
  } catch {
    return empty;
  }
  const records: FastLaneRunRecord[] = [];
  for (const line of lines.slice(-last * 2)) {
    try {
      const r = JSON.parse(line) as FastLaneRunRecord;
      if (r && (r.result === 'handled' || r.result === 'continued' || r.result === 'stopped') && typeof r.elapsedMs === 'number') records.push(r);
    } catch {
      // skip corrupt lines
    }
  }
  const recent = records.slice(-last);
  const handledTimes = recent.filter((r) => r.result === 'handled').map((r) => r.elapsedMs).sort((a, b) => a - b);
  return {
    total: recent.length,
    handled: handledTimes.length,
    continued: recent.filter((r) => r.result === 'continued').length,
    stopped: recent.filter((r) => r.result === 'stopped').length,
    medianHandledMs: handledTimes.length === 0 ? null : handledTimes[Math.floor(handledTimes.length / 2)]!,
  };
}
