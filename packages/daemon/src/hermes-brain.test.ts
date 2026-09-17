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

  it('records task completion into MEMORY.md history and caps at 25 entries', async () => {
    const brain = new HermesBrain(tmpDir);
    await brain.ensureInitialized();

    for (let i = 1; i <= 30; i++) {
      await brain.recordTaskCompletion({
        prompt: `prompt ${i}`,
        summary: `summary ${i}`,
        conversationId: `conv-${i}`,
      });
    }

    const content = await brain.loadMemory();
    expect(content).toContain('prompt 30');
    expect(content).toContain('prompt 6');
    expect(content).not.toContain('prompt 5\n');
  });

  it('automatically learns new workspace into Known Projects on task completion', async () => {
    const newRepoDir = path.join(tmpDir, 'new-service');
    fs.mkdirSync(newRepoDir, { recursive: true });
    const brain = new HermesBrain(tmpDir);
    await brain.ensureInitialized();

    await brain.recordTaskCompletion({
      prompt: 'build new service',
      summary: 'scaffolded new-service',
      workspacePath: newRepoDir,
    });

    const projects = await brain.listProjects();
    expect(projects.some((p) => p.path === newRepoDir && p.name === 'new-service')).toBe(true);

    const resolved = await brain.resolveWorkspace('run tests in new service');
    expect(resolved).toBe(newRepoDir);
  });

  it('resolves workspace path from prompt referencing project name or alias', async () => {
    const projectDir = path.join(tmpDir, 'remote-hands');
    fs.mkdirSync(projectDir, { recursive: true });
    const brain = new HermesBrain(tmpDir);
    await brain.ensureInitialized({
      name: 'remote-hands',
      path: projectDir,
      aliases: ['remote hands', 'rh'],
    });

    const resolved1 = await brain.resolveWorkspace('Can you go to remote hands and fix the header?');
    expect(resolved1).toBe(projectDir);

    const resolved2 = await brain.resolveWorkspace('in remote-hands update styles');
    expect(resolved2).toBe(projectDir);

    const resolvedNone = await brain.resolveWorkspace('tell me a joke');
    expect(resolvedNone).toBeUndefined();
  });

  it('does not trigger false-positive matches on substrings of English words', async () => {
    const cliDir = path.join(tmpDir, 'cli');
    fs.mkdirSync(cliDir, { recursive: true });
    const rhDir = path.join(tmpDir, 'rh');
    fs.mkdirSync(rhDir, { recursive: true });

    const brain = new HermesBrain(tmpDir);
    await brain.ensureInitialized({
      name: 'cli',
      path: cliDir,
      aliases: ['cli'],
    });
    await brain.ensureInitialized({
      name: 'rh',
      path: rhDir,
      aliases: ['rh'],
    });

    expect(await brain.resolveWorkspace('please click the login button')).toBeUndefined();
    expect(await brain.resolveWorkspace('listen to the musical rhythm')).toBeUndefined();
    expect(await brain.resolveWorkspace('apply changes')).toBeUndefined();

    expect(await brain.resolveWorkspace('run the cli tool')).toBe(cliDir);
    expect(await brain.resolveWorkspace('start rh daemon')).toBe(rhDir);
  });

  it('determines appropriate effort level based on task complexity', () => {
    const brain = new HermesBrain(tmpDir);
    expect(brain.determineEffort('make the header sticky')).toBe('medium');
    expect(brain.determineEffort('fix css padding bug')).toBe('medium');
    expect(brain.determineEffort('rearchitect the entire database and redesign control plane')).toBe('high');
    expect(brain.determineEffort('check git status')).toBe('low');
    expect(brain.determineEffort('rearchitect status check')).toBe('high');
  });

  it('prepares task context with auto-resolved path and tuned effort', async () => {
    const projectDir = path.join(tmpDir, 'remote-hands');
    fs.mkdirSync(projectDir, { recursive: true });
    const brain = new HermesBrain(tmpDir);
    await brain.ensureInitialized({
      name: 'remote-hands',
      path: projectDir,
      aliases: ['remote hands'],
    });

    const ctx = await brain.prepareTaskContext({
      prompt: 'in remote hands make header sticky',
      workspace_path: null,
      effort: null,
    });

    expect(ctx.resolvedWorkspacePath).toBe(projectDir);
    expect(ctx.recommendedEffort).toBe('medium');
    expect(ctx.augmentedPrompt).toContain('in remote hands make header sticky');
    expect(ctx.augmentedPrompt).toContain('[Hermes Memory:');
    expect(ctx.augmentedPrompt).toContain('Target workspace:');
    expect(ctx.augmentedPrompt).toContain('Remote Hands Architecture:');
    expect(ctx.augmentedPrompt).toContain('Learned Recipes:');
    expect(ctx.augmentedPrompt).toContain('Execution Speed Directives:');

    const recipes = await brain.extractLearnedRecipes();
    expect(recipes.length).toBeGreaterThan(0);
    expect(recipes[0]).toContain('Mobile chat sticky header');
  });
});
