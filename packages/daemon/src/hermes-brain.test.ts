import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HermesBrain } from './hermes-brain.js';

describe('HermesBrain Memory Operations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-brain-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes MEMORY.md with default structure and detects projects', async () => {
    const brain = new HermesBrain(tmpDir);
    const content = await brain.ensureInitialized({
      name: 'remote-hands',
      path: '/mock/path/remote-hands',
      aliases: ['remote hands', 'rh'],
    });

    expect(content).toContain('# Known Projects');
    expect(content).toContain('/mock/path/remote-hands');

    const projects = await brain.listProjects();
    expect(projects.length).toBeGreaterThan(0);
    expect(projects[0]?.name).toBe('remote-hands');
  });

  it('records task completion into MEMORY.md history', async () => {
    const brain = new HermesBrain(tmpDir);
    await brain.ensureInitialized();
    await brain.recordTaskCompletion({
      prompt: 'make header sticky',
      summary: 'Updated LiveTaskScreen.tsx with sticky styling',
      workspacePath: '/mock/path/remote-hands',
      conversationId: 'conv-123',
    });

    const content = await brain.loadMemory();
    expect(content).toContain('make header sticky');
    expect(content).toContain('conv-123');
  });

  it('resolves workspace path from prompt referencing project name or alias', async () => {
    const brain = new HermesBrain(tmpDir);
    await brain.ensureInitialized({
      name: 'remote-hands',
      path: '/mock/path/remote-hands',
      aliases: ['remote hands', 'rh'],
    });

    const resolved1 = await brain.resolveWorkspace('Can you go to remote hands and fix the header?');
    expect(resolved1).toBe('/mock/path/remote-hands');

    const resolved2 = await brain.resolveWorkspace('in remote-hands update styles');
    expect(resolved2).toBe('/mock/path/remote-hands');

    const resolvedNone = await brain.resolveWorkspace('tell me a joke');
    expect(resolvedNone).toBeUndefined();
  });

  it('determines appropriate effort level based on task complexity', () => {
    const brain = new HermesBrain(tmpDir);
    expect(brain.determineEffort('make the header sticky')).toBe('medium');
    expect(brain.determineEffort('fix css padding bug')).toBe('medium');
    expect(brain.determineEffort('rearchitect the entire database and redesign control plane')).toBe('high');
    expect(brain.determineEffort('check git status')).toBe('low');
  });

  it('prepares task context with auto-resolved path and tuned effort', async () => {
    const brain = new HermesBrain(tmpDir);
    await brain.ensureInitialized({
      name: 'remote-hands',
      path: '/mock/path/remote-hands',
      aliases: ['remote hands'],
    });

    const ctx = await brain.prepareTaskContext({
      prompt: 'in remote hands make header sticky',
      workspace_path: null,
      effort: null,
    });

    expect(ctx.resolvedWorkspacePath).toBe('/mock/path/remote-hands');
    expect(ctx.recommendedEffort).toBe('medium');
    expect(ctx.augmentedPrompt).toContain('in remote hands make header sticky');
  });
});
