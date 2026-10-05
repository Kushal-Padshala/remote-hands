import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearActiveTask, readActiveTask, writeActiveTask } from './action-gate.js';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-active-task-')), 'active-task.json');
}

describe('active task marker', () => {
  it('reports marker initialization errors instead of running without a task', () => {
    const parent = tmpFile();
    fs.writeFileSync(parent, 'not a directory');
    expect(() => writeActiveTask('task-1', path.join(parent, 'marker.json'))).toThrow();
  });

  it.each(['{', '{}', '{"taskId":"task-1"}', '{"taskId":"task-1","pid":0}'])(
    'blocks a malformed marker: %s', (contents) => {
      const file = tmpFile();
      fs.writeFileSync(file, contents);
      expect(() => readActiveTask(file)).toThrow();
    },
  );

  it('reports unreadable markers instead of treating them as idle', () => {
    const file = tmpFile();
    fs.mkdirSync(file);
    expect(() => readActiveTask(file)).toThrow();
  });

  it('records, reads and clears the running task', () => {
    const file = tmpFile();
    expect(readActiveTask(file)).toBeNull();
    writeActiveTask('task-1', file);
    expect(readActiveTask(file)).toBe('task-1');
    clearActiveTask('task-2', file);
    expect(readActiveTask(file)).toBe('task-1');
    clearActiveTask('task-1', file);
    expect(readActiveTask(file)).toBeNull();
  });

  it('ignores a marker left by a daemon that is no longer running', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ taskId: 'task-1', pid: 2 ** 22 + 12345 }));
    expect(readActiveTask(file)).toBeNull();
  });

  it('never touches the real marker in tests', () => {
    expect(readActiveTask()).toBeNull();
  });
});
