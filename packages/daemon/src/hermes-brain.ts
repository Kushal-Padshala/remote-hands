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

  generateProjectAliases(name: string, projectPath?: string): string[] {
    const aliases = new Set<string>();
    const trimmed = name.trim().toLowerCase();
    aliases.add(trimmed);

    const spaceVersion = trimmed.replace(/[-_.]+/g, ' ');
    aliases.add(spaceVersion);

    const noSpaceVersion = trimmed.replace(/[-_.\s]+/g, '');
    aliases.add(noSpaceVersion);

    const parts = spaceVersion.split(/\s+/).filter(Boolean);
    if (parts.length > 1) {
      const acronym = parts.map((p) => p[0]).join('');
      if (acronym.length >= 2) {
        aliases.add(acronym);
      }
    }

    if (projectPath && fs.existsSync(path.join(projectPath, 'package.json'))) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf-8'));
        if (pkg.name) {
          const rawPkgName = String(pkg.name).replace(/^@[^/]+\//, '');
          aliases.add(rawPkgName.toLowerCase());
          aliases.add(rawPkgName.replace(/[-_.]+/g, ' ').toLowerCase());
          aliases.add(rawPkgName.replace(/[-_.\s]+/g, '').toLowerCase());
        }
      } catch {}
    }

    return Array.from(aliases).filter((a) => a.length >= 2);
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
      initialProjects.push({
        ...defaultProject,
        aliases: Array.from(new Set([...defaultProject.aliases, ...this.generateProjectAliases(defaultProject.name, defaultProject.path)])),
      });
    } else {
      const currentCwd = process.cwd();
      if (fs.existsSync(path.join(currentCwd, 'package.json'))) {
        const base = path.basename(currentCwd);
        initialProjects.push({
          name: base,
          path: currentCwd,
          aliases: this.generateProjectAliases(base, currentCwd),
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
      const baseCandidates = [project.name, ...project.aliases, path.basename(project.path)];
      const candidateSet = new Set<string>();
      for (const c of baseCandidates) {
        const lower = c.toLowerCase().trim();
        candidateSet.add(lower);
        candidateSet.add(lower.replace(/[-_.]+/g, ' ').trim());
        candidateSet.add(lower.replace(/[-_.\s]+/g, '').trim());
      }
      for (const candidate of candidateSet) {
        if (candidate.length >= 2) {
          candidatesWithProjects.push({ candidate, path: project.path });
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

  async extractLearnedRecipes(): Promise<string[]> {
    const content = await this.loadMemory();
    const lines = content.split('\n');
    const recipes: string[] = [];
    let inRecipes = false;

    for (const line of lines) {
      if (/^#{1,3}\s+Learned Skills & Recipes/i.test(line.trim())) {
        inRecipes = true;
        continue;
      }
      if (inRecipes && /^#{1,3}\s+/.test(line.trim())) {
        inRecipes = false;
        break;
      }
      if (inRecipes && line.trim().startsWith('- ')) {
        recipes.push(line.trim().slice(2).trim());
      }
    }
    return recipes;
  }

  discoverWorkspaceArchitecture(workspacePath: string, prompt?: string): string {
    if (!fs.existsSync(workspacePath)) return '';

    const lines: string[] = [];
    const lowerPrompt = (prompt || '').toLowerCase();
    const pkgJsonPath = path.join(workspacePath, 'package.json');

    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        const pkgName = pkg.name || path.basename(workspacePath);
        lines.push(`Workspace: ${pkgName}`);

        const workspaces = Array.isArray(pkg.workspaces)
          ? pkg.workspaces
          : (pkg.workspaces?.packages && Array.isArray(pkg.workspaces.packages))
            ? pkg.workspaces.packages
            : null;

        if (workspaces && workspaces.length > 0) {
          lines.push('Monorepo Packages:');
          const matchedPackages: string[] = [];
          for (const pattern of workspaces) {
            const cleanPattern = pattern.replace(/\/\*$/, '');
            const targetDir = path.join(workspacePath, cleanPattern);
            if (fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory()) {
              const entries = fs.readdirSync(targetDir, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.')) {
                  const subDir = path.join(targetDir, entry.name);
                  const relPath = path.relative(workspacePath, subDir);
                  const subPkgPath = path.join(subDir, 'package.json');
                  let subDesc = '';
                  if (fs.existsSync(subPkgPath)) {
                    try {
                      const subPkg = JSON.parse(fs.readFileSync(subPkgPath, 'utf-8'));
                      const subName = subPkg.name || entry.name;
                      const deps = { ...(subPkg.dependencies || {}), ...(subPkg.devDependencies || {}) };
                      const frameworks: string[] = [];
                      if (deps.react) frameworks.push('React');
                      if (deps.vite) frameworks.push('Vite');
                      if (deps.next) frameworks.push('Next.js');
                      if (deps.vue) frameworks.push('Vue');
                      if (deps.express) frameworks.push('Express');
                      if (deps.hono) frameworks.push('Hono');
                      if (deps.wrangler || subPkg.name?.includes('cloudflare')) frameworks.push('Cloudflare');
                      if (deps.vitest) frameworks.push('Vitest');
                      if (deps.jest) frameworks.push('Jest');
                      subDesc = `${subName}${frameworks.length > 0 ? ` (${frameworks.join(', ')})` : ''}`;
                    } catch {}
                  }
                  lines.push(`- \`${relPath}\`${subDesc ? `: ${subDesc}` : ''}`);

                  if (lowerPrompt) {
                    const words = relPath.toLowerCase().split(/[\/_-]/);
                    if (words.some((w) => w.length > 2 && lowerPrompt.includes(w))) {
                      matchedPackages.push(relPath);
                    }
                  }
                }
              }
            }
          }
          if (matchedPackages.length > 0) {
            lines.push(`Relevant Package(s) for task: ${matchedPackages.map((p) => `\`${p}\``).join(', ')}`);
          }
        } else {
          const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
          const scripts = pkg.scripts || {};
          const details: string[] = [];
          if (deps.react) details.push('React');
          if (deps.vue) details.push('Vue');
          if (deps.next) details.push('Next.js');
          if (deps.express) details.push('Express');
          if (scripts.test) details.push(`test: \`${scripts.test}\``);
          if (details.length > 0) {
            lines.push(`Stack: ${details.join(', ')}`);
          }
        }
      } catch {}
    } else if (fs.existsSync(path.join(workspacePath, 'Cargo.toml'))) {
      lines.push('Workspace Type: Rust (Cargo)');
    } else if (
      fs.existsSync(path.join(workspacePath, 'pyproject.toml')) ||
      fs.existsSync(path.join(workspacePath, 'requirements.txt'))
    ) {
      lines.push('Workspace Type: Python');
    } else if (fs.existsSync(path.join(workspacePath, 'go.mod'))) {
      lines.push('Workspace Type: Go');
    }

    try {
      const topDirs = fs
        .readdirSync(workspacePath, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
        .map((e) => e.name);
      if (topDirs.length > 0 && !lines.some((l) => l.includes('Monorepo Packages'))) {
        lines.push(`Directories: ${topDirs.map((d) => `\`${d}/\``).join(', ')}`);
      }
    } catch {}

    return lines.join('\n');
  }

  async prepareTaskContext(task: {
    prompt: string;
    workspace_path?: string | null;
    effort?: string | null;
  }): Promise<HermesContext> {
    await this.ensureInitialized();
    const resolvedPath = task.workspace_path || (await this.resolveWorkspace(task.prompt));
    const recommendedEffort = this.determineEffort(task.prompt, task.effort);

    const snippets: string[] = [];
    if (resolvedPath) {
      snippets.push(`Target workspace: "${resolvedPath}". Execute directly in this workspace.`);
      const archMap = this.discoverWorkspaceArchitecture(resolvedPath, task.prompt);
      if (archMap) {
        snippets.push(archMap);
      }
    }

    const recipes = await this.extractLearnedRecipes();
    const lowerPrompt = task.prompt.toLowerCase();
    const matchingRecipes = recipes.filter((r) => {
      const words = r.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      return words.some((w) => lowerPrompt.includes(w));
    });

    if (matchingRecipes.length > 0) {
      snippets.push(`Learned Recipes:\n${matchingRecipes.map((r) => `- ${r}`).join('\n')}`);
    }

    const recentActivity = await this.findRelevantRecentActivity(resolvedPath, task.prompt);
    if (recentActivity.length > 0) {
      snippets.push(`Recent Relevant Activity:\n${recentActivity.join('\n')}`);
    }

    snippets.push(
      'Execution Speed Directives: Target relevant source files directly without full repo exploratory sweeps. Read generous line ranges. Run targeted test files (e.g. `npx vitest run <path>`) rather than full repo test suites.',
    );

    const contextSnippet = snippets.length > 0 ? `\n[Hermes Memory:\n${snippets.join('\n\n')}\n]` : '';

    return {
      resolvedWorkspacePath: resolvedPath || undefined,
      recommendedEffort,
      augmentedPrompt: `${task.prompt}${contextSnippet}`,
    };
  }

  async findRelevantRecentActivity(workspacePath?: string, prompt?: string): Promise<string[]> {
    const content = await this.loadMemory();
    const match = content.match(/^#{1,3}\s+Recent Activity([\s\S]*)$/m);
    if (!match || !match[1]) return [];

    const activityText = match[1];
    const entries = activityText
      .split(/\n(?=- \*\*\[)/)
      .map((e) => e.trim())
      .filter(Boolean);

    const relevant: string[] = [];
    const lowerPrompt = (prompt || '').toLowerCase();
    const promptKeywords = lowerPrompt
      .split(/\W+/)
      .filter((w) => w.length > 3 && !['make', 'this', 'that', 'with', 'from', 'have', 'been', 'about'].includes(w));

    for (const entry of entries) {
      const isMatchingWorkspace = workspacePath && entry.includes(workspacePath);
      const isMatchingPrompt = promptKeywords.some((w) => entry.toLowerCase().includes(w));

      if (isMatchingWorkspace || isMatchingPrompt) {
        const promptLine = entry.match(/Prompt:\s*"([^"]+)"/);
        const summaryLine = entry.match(/Summary:\s*([^\n]+)/);
        if (promptLine && summaryLine) {
          const shortPrompt = promptLine[1]!.slice(0, 80);
          const shortSummary = summaryLine[1]!.slice(0, 140);
          relevant.push(`- "${shortPrompt}": ${shortSummary}`);
          if (relevant.length >= 2) break;
        }
      }
    }

    return relevant;
  }

  extractActionableRecipes(prompt: string, summary: string): string[] {
    const recipes: string[] = [];
    const lines = summary.split('\n');

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const bulletMatch = line.match(/^[-*]\s+\*\*([^*]+)\*\*:\s*(.+)$/);
      if (bulletMatch) {
        const title = bulletMatch[1]!.trim();
        const body = bulletMatch[2]!.trim().replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
        if (body.length > 10 && !title.toLowerCase().includes('summary') && !title.toLowerCase().includes('verification')) {
          recipes.push(`${title}: ${body}`);
        }
        continue;
      }

      const patternMatch = line.match(/^(?:Recipe|Solution|Fix|Skill):\s*(.+)$/i);
      if (patternMatch) {
        recipes.push(patternMatch[1]!.trim());
      }
    }

    return recipes.slice(0, 3);
  }

  private appendRecipesToContent(content: string, newRecipes: string[]): string {
    const recipeHeaderRegex = /^#{1,3}\s+Learned Skills & Recipes/m;
    const match = content.match(recipeHeaderRegex);
    if (!match || match.index === undefined) return content;

    const headerPos = match.index;
    const afterHeader = content.slice(headerPos + match[0].length);
    const nextHeaderMatch = afterHeader.match(/\n#{1,3}\s+/);
    const recipeBlock = nextHeaderMatch
      ? afterHeader.slice(0, nextHeaderMatch.index)
      : afterHeader;
    const remainder = nextHeaderMatch
      ? afterHeader.slice(nextHeaderMatch.index)
      : '';

    const existingRecipes = recipeBlock
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim());

    const combined = [...existingRecipes];
    for (const r of newRecipes) {
      const normalized = r.toLowerCase();
      const alreadyExists = combined.some((e) => e.toLowerCase() === normalized);
      if (!alreadyExists) {
        combined.push(r);
      }
    }

    const capped = combined.slice(-20);
    const newBlock = capped.map((r) => `- ${r}`).join('\n');
    const beforeHeader = content.slice(0, headerPos + match[0].length);

    return `${beforeHeader}\n${newBlock}\n${remainder.replace(/^\n*/, '\n')}`;
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
          aliases: this.generateProjectAliases(baseName, params.workspacePath),
        };
        content = this.appendProjectToContent(content, newProject);
      }
    }

    const learnedRecipes = this.extractActionableRecipes(params.prompt, params.summary);
    if (learnedRecipes.length > 0) {
      content = this.appendRecipesToContent(content, learnedRecipes);
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
