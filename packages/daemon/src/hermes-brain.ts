import * as fs from 'node:fs';
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
      const existing = fs.readFileSync(memoryFile, 'utf-8');
      if (defaultProject) {
        const projects = await this.listProjects();
        if (!projects.some((p) => p.path === defaultProject.path || p.name === defaultProject.name)) {
          const updated = this.appendProjectToContent(existing, defaultProject);
          fs.writeFileSync(memoryFile, updated, 'utf-8');
          return updated;
        }
      }
      return existing;
    }

    fs.mkdirSync(this.memoryDir, { recursive: true });

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

    fs.writeFileSync(memoryFile, initialContent, 'utf-8');
    return initialContent;
  }

  async loadMemory(): Promise<string> {
    const memoryFile = this.getMemoryPath();
    if (!fs.existsSync(memoryFile)) {
      return this.ensureInitialized();
    }
    return fs.readFileSync(memoryFile, 'utf-8');
  }

  async listProjects(): Promise<HermesProjectEntry[]> {
    const content = await this.loadMemory();
    const projects: HermesProjectEntry[] = [];
    const sectionIndex = content.indexOf('## Known Projects');
    if (sectionIndex === -1) return projects;

    const nextSectionIndex = content.indexOf('## ', sectionIndex + 17);
    const sectionText =
      nextSectionIndex === -1
        ? content.slice(sectionIndex + 17)
        : content.slice(sectionIndex + 17, nextSectionIndex);

    const projectBlocks = sectionText.split(/\n- \*\*/).filter(Boolean);
    for (const block of projectBlocks) {
      const nameMatch = block.match(/^([^*]+)\*\*/);
      const pathMatch = block.match(/Path:\s*`([^`]+)`/);
      const aliasMatch = block.match(/Aliases:\s*([^\n]+)/);

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
    }

    return projects;
  }

  async resolveWorkspace(prompt: string): Promise<string | undefined> {
    const projects = await this.listProjects();
    const lowerPrompt = prompt.toLowerCase();

    for (const project of projects) {
      const candidates = [project.name, ...project.aliases, path.basename(project.path)];
      for (const candidate of candidates) {
        const normalized = candidate.toLowerCase().trim();
        if (normalized.length < 2) continue;
        const regex = new RegExp(`\\b${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if ((regex.test(lowerPrompt) || lowerPrompt.includes(normalized)) && fs.existsSync(project.path)) {
          return project.path;
        }
      }
    }

    return undefined;
  }

  determineEffort(prompt: string, currentEffort?: string | null): 'low' | 'medium' | 'high' {
    if (currentEffort === 'low' || currentEffort === 'medium' || currentEffort === 'high') {
      return currentEffort;
    }

    const lower = prompt.toLowerCase();

    const lowPatterns = ['git status', 'git diff', 'ls ', 'which ', 'list files', 'status check', 'view log'];
    for (const p of lowPatterns) {
      if (lower.includes(p)) return 'low';
    }

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

    const content = fs.readFileSync(memoryFile, 'utf-8');
    const timestamp = new Date().toISOString();
    const entry = [
      `- **[${timestamp}]**`,
      `  - Prompt: "${params.prompt.replace(/\n/g, ' ')}"`,
      `  - Summary: ${params.summary.replace(/\n/g, ' ')}`,
      params.workspacePath ? `  - Workspace: \`${params.workspacePath}\`` : '',
      params.conversationId ? `  - Conversation: \`${params.conversationId}\`` : '',
    ]
      .filter(Boolean)
      .join('\n');

    let updated: string;
    if (content.includes('## Recent Activity')) {
      updated = content.replace('## Recent Activity', `## Recent Activity\n${entry}\n`);
    } else {
      updated = `${content}\n\n## Recent Activity\n${entry}\n`;
    }

    fs.writeFileSync(memoryFile, updated, 'utf-8');
  }

  private appendProjectToContent(content: string, project: HermesProjectEntry): string {
    const projectSnippet = `- **${project.name}**\n  - Path: \`${project.path}\`\n  - Aliases: ${project.aliases.map((a) => `\`${a}\``).join(', ')}`;
    if (content.includes('## Known Projects\n- None registered yet')) {
      return content.replace('## Known Projects\n- None registered yet', `## Known Projects\n${projectSnippet}`);
    }
    if (content.includes('## Known Projects')) {
      return content.replace('## Known Projects', `## Known Projects\n${projectSnippet}\n`);
    }
    return `${content}\n\n## Known Projects\n${projectSnippet}\n`;
  }
}
