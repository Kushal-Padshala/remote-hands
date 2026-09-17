import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface HermesProjectEntry {
  name: string;
  path: string;
  aliases: string[];
}

export interface HermesContext {
  resolvedWorkspacePath?: string | undefined;
  recommendedEffort: 'low' | 'medium' | 'high';
  augmentedPrompt: string;
}

export class HermesBrain {
  private memoryDir: string;

  constructor(memoryDir?: string) {
    this.memoryDir = memoryDir || path.join(os.homedir(), '.remote-hands/memory');
  }

  getMemoryDir(): string {
    return this.memoryDir;
  }

  getMemoryPath(): string {
    return path.join(this.memoryDir, 'MEMORY.md');
  }

  async ensureInitialized(defaultProject?: HermesProjectEntry): Promise<string> {
    const memoryFile = this.getMemoryPath();
    if (fs.existsSync(memoryFile)) {
      const existing = await fsPromises.readFile(memoryFile, 'utf-8');
      if (defaultProject) {
        const projects = await this.listProjects();
        if (!projects.some((p) => p.path === defaultProject.path || p.name === defaultProject.name)) {
          const updated = this.appendProjectToContent(existing, defaultProject);
          await fsPromises.writeFile(memoryFile, updated, 'utf-8');
          return updated;
        }
      }
      return existing;
    }

    await fsPromises.mkdir(this.memoryDir, { recursive: true });

    const initialProjects: HermesProjectEntry[] = [];
    if (defaultProject) {
      initialProjects.push(defaultProject);
    } else {
      const currentCwd = process.cwd();
      if (fs.existsSync(path.join(currentCwd, 'package.json'))) {
        const base = path.basename(currentCwd);
        initialProjects.push({
          name: base,
          path: currentCwd,
          aliases: [base.replace(/-/g, ' '), base],
        });
      }
    }

    const projectsMarkdown = initialProjects
      .map(
        (p) =>
          `- **${p.name}**\n  - Path: \`${p.path}\`\n  - Aliases: ${p.aliases.map((a) => `\`${a}\``).join(', ')}`,
      )
      .join('\n\n');

    const initialContent = [
      '# Hermes Persistent Machine Memory',
      '',
      '## Machine Profile',
      `- Platform: \`${os.platform()} (${os.arch()})\``,
      `- Hostname: \`${os.hostname()}\``,
      `- User Home: \`${os.homedir()}\``,
      '- Preferred Engineering Style: clean code, no comments, high speed execution, zero unnecessary scans',
      '',
      '## Known Projects',
      projectsMarkdown || '- None registered yet',
      '',
      '## Learned Skills & Recipes',
      '- Mobile chat sticky header: use `position: sticky; top: 0; z-index: 50;` with `overflow-x: clip` on `html, body` and flex constraints (`min-height: 0`)',
      '',
      '## Recent Activity',
      '',
    ].join('\n');

    await fsPromises.writeFile(memoryFile, initialContent, 'utf-8');
    return initialContent;
  }

  async loadMemory(): Promise<string> {
    const memoryFile = this.getMemoryPath();
    if (!fs.existsSync(memoryFile)) {
      return this.ensureInitialized();
    }
    return fsPromises.readFile(memoryFile, 'utf-8');
  }

  async listProjects(): Promise<HermesProjectEntry[]> {
    const content = await this.loadMemory();
    const projects: HermesProjectEntry[] = [];
    const lines = content.split('\n');

    let inKnownProjects = false;
    let currentBlock: string[] = [];

    const flushBlock = (block: string[]) => {
      if (block.length === 0) return;
      const text = block.join('\n');
      const nameMatch = text.match(/^- \*\*([^*]+)\*\*/);
      const pathMatch = text.match(/Path:\s*`([^`]+)`/);
      const aliasMatch = text.match(/Aliases:\s*([^\n]+)/);

      if (nameMatch && pathMatch) {
        const name = nameMatch[1]!.trim();
        const projectPath = pathMatch[1]!.trim();
        const rawAliases = aliasMatch ? aliasMatch[1]! : '';
        const aliases = Array.from(rawAliases.matchAll(/`([^`]+)`/g)).map((m) => m[1]!.trim());
        projects.push({
          name,
          path: projectPath,
          aliases: aliases.length > 0 ? aliases : [name],
        });
      }
    };

    for (const line of lines) {
      if (/^#{1,3}\s+Known Projects/i.test(line.trim())) {
        inKnownProjects = true;
        continue;
      }
      if (inKnownProjects && /^#{1,3}\s+/.test(line.trim())) {
        inKnownProjects = false;
        flushBlock(currentBlock);
        currentBlock = [];
        continue;
      }
      if (inKnownProjects) {
        if (line.trim().startsWith('- **')) {
          flushBlock(currentBlock);
          currentBlock = [line];
        } else if (currentBlock.length > 0) {
          currentBlock.push(line);
        }
      }
    }
    flushBlock(currentBlock);

    return projects;
  }

  async resolveWorkspace(prompt: string): Promise<string | undefined> {
    const projects = await this.listProjects();
    const lowerPrompt = prompt.toLowerCase();

    const candidatesWithProjects: { candidate: string; path: string }[] = [];
    for (const project of projects) {
      const candidates = [project.name, ...project.aliases, path.basename(project.path)];
      for (const candidate of candidates) {
        const normalized = candidate.toLowerCase().trim();
        if (normalized.length >= 2) {
          candidatesWithProjects.push({ candidate: normalized, path: project.path });
        }
      }
    }

    candidatesWithProjects.sort((a, b) => b.candidate.length - a.candidate.length);

    for (const { candidate, path: candidatePath } of candidatesWithProjects) {
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const boundaryRegex = new RegExp(`(^|[^\\w@])${escaped}([^\\w]|$)`, 'i');
      if (boundaryRegex.test(lowerPrompt) && fs.existsSync(candidatePath)) {
        return candidatePath;
      }
    }

    return undefined;
  }

  determineEffort(prompt: string, currentEffort?: string | null): 'low' | 'medium' | 'high' {
    if (currentEffort === 'low' || currentEffort === 'medium' || currentEffort === 'high') {
      return currentEffort;
    }

    const lower = prompt.toLowerCase();

    const highPatterns = [
      'architect',
      'redesign',
      'rearchitect',
      'refactor',
      'migration',
      'overhaul',
      'new subsystem',
      'superpower',
    ];
    for (const p of highPatterns) {
      if (lower.includes(p)) return 'high';
    }

    const lowPatterns = ['git status', 'git diff', 'ls ', 'which ', 'list files', 'status check', 'view log'];
    for (const p of lowPatterns) {
      if (lower.includes(p)) return 'low';
    }

    return 'medium';
  }

  async prepareTaskContext(task: {
    prompt: string;
    workspace_path?: string | null;
    effort?: string | null;
  }): Promise<HermesContext> {
    await this.ensureInitialized();
    const resolvedPath = task.workspace_path || (await this.resolveWorkspace(task.prompt));
    const recommendedEffort = this.determineEffort(task.prompt, task.effort);

    let contextSnippet = '';
    if (resolvedPath) {
      contextSnippet = `\n[Hermes Memory: Target workspace resolved to "${resolvedPath}". Execute directly in this workspace.]`;
    }

    return {
      resolvedWorkspacePath: resolvedPath || undefined,
      recommendedEffort,
      augmentedPrompt: `${task.prompt}${contextSnippet}`,
    };
  }

  async recordTaskCompletion(params: {
    prompt: string;
    summary: string;
    workspacePath?: string | undefined;
    conversationId?: string | null | undefined;
  }): Promise<void> {
    const memoryFile = this.getMemoryPath();
    if (!fs.existsSync(memoryFile)) {
      await this.ensureInitialized();
    }

    let content = await fsPromises.readFile(memoryFile, 'utf-8');

    if (params.workspacePath && fs.existsSync(params.workspacePath)) {
      const projects = await this.listProjects();
      const alreadyKnown = projects.some(
        (p) => p.path === params.workspacePath || path.resolve(p.path) === path.resolve(params.workspacePath!),
      );
      if (!alreadyKnown) {
        const baseName = path.basename(params.workspacePath);
        const newProject: HermesProjectEntry = {
          name: baseName,
          path: params.workspacePath,
          aliases: [baseName.replace(/-/g, ' '), baseName],
        };
        content = this.appendProjectToContent(content, newProject);
      }
    }

    const timestamp = new Date().toISOString();
    const newEntry = [
      `- **[${timestamp}]**`,
      `  - Prompt: "${params.prompt.replace(/\n/g, ' ')}"`,
      `  - Summary: ${params.summary.replace(/\n/g, ' ')}`,
      params.workspacePath ? `  - Workspace: \`${params.workspacePath}\`` : '',
      params.conversationId ? `  - Conversation: \`${params.conversationId}\`` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const activityHeaderRegex = /^#{1,3}\s+Recent Activity/m;
    const match = content.match(activityHeaderRegex);

    if (match && match.index !== undefined) {
      const headerPos = match.index;
      const afterHeader = content.slice(headerPos + match[0].length);
      const existingEntries = afterHeader
        .split(/\n(?=- \*\*\[)/)
        .map((e) => e.trim())
        .filter(Boolean);

      const cappedEntries = [newEntry, ...existingEntries].slice(0, 25);
      const beforeHeader = content.slice(0, headerPos + match[0].length);
      content = `${beforeHeader}\n${cappedEntries.join('\n\n')}\n`;
    } else {
      content = `${content.trim()}\n\n## Recent Activity\n${newEntry}\n`;
    }

    await fsPromises.writeFile(memoryFile, content, 'utf-8');
  }

  private appendProjectToContent(content: string, project: HermesProjectEntry): string {
    const projectSnippet = `- **${project.name}**\n  - Path: \`${project.path}\`\n  - Aliases: ${project.aliases.map((a) => `\`${a}\``).join(', ')}`;
    if (content.includes('## Known Projects\n- None registered yet')) {
      return content.replace('## Known Projects\n- None registered yet', `## Known Projects\n${projectSnippet}`);
    }
    const match = content.match(/^#{1,3}\s+Known Projects/m);
    if (match && match.index !== undefined) {
      const insertPos = match.index + match[0].length;
      return `${content.slice(0, insertPos)}\n${projectSnippet}\n${content.slice(insertPos).replace(/^\n*/, '')}`;
    }
    return `${content.trim()}\n\n## Known Projects\n${projectSnippet}\n`;
  }
}
