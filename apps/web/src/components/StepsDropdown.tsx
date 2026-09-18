import { useState, useEffect, useMemo } from 'react';

export interface ChatStep {
  id: string;
  type: 'tool' | 'thinking';
  text?: string;
  tokens?: number;
  duration?: string;
  toolName?: string;
  toolInput?: any;
  toolOutput?: string;
  toolStatus?: 'active' | 'done';
  time?: string;
}

export type StepCategory = 'edit' | 'read' | 'bash' | 'thought' | 'search' | 'tool';

export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  lineNum?: number;
  text: string;
}

export interface ParsedStepInfo {
  category: StepCategory;
  name: string;
  target?: string | undefined;
  subline: string;
  diffStats?: { added: number; removed: number } | undefined;
  diffLines?: DiffLine[] | undefined;
  instruction?: string | undefined;
  readLinesCount?: number | undefined;
  command?: string | undefined;
  thoughtText?: string | undefined;
  output?: string | undefined;
}


function formatDisplayPath(fullPath: string): string {
  if (!fullPath) return '';
  const homeMatch = fullPath.match(/^\/(?:Users|home)\/[^/]+(\/.*)$/);
  if (homeMatch && homeMatch[1]) {
    return `~${homeMatch[1]}`;
  }
  return fullPath;
}

function parseEditDiff(input: any): { lines: DiffLine[]; stats: { added: number; removed: number } } {
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;

  if (input?.TargetContent !== undefined || input?.ReplacementContent !== undefined) {
    const startLine = Number(input.StartLine) || 1;
    const target = String(input.TargetContent || '');
    const replacement = String(input.ReplacementContent || '');

    const targetLines = target ? target.split('\n') : [];
    const replLines = replacement ? replacement.split('\n') : [];

    removed = target ? targetLines.length : 0;
    added = replacement ? replLines.length : 0;

    targetLines.forEach((text, idx) => {
      lines.push({
        type: 'del',
        lineNum: startLine + idx,
        text,
      });
    });

    replLines.forEach((text, idx) => {
      lines.push({
        type: 'add',
        lineNum: startLine + idx,
        text,
      });
    });
  } else if (input?.CodeContent !== undefined) {
    const code = String(input.CodeContent);
    const codeLines = code.split('\n');
    added = codeLines.length;
    codeLines.forEach((text, idx) => {
      lines.push({
        type: 'add',
        lineNum: idx + 1,
        text,
      });
    });
  }

  return { lines, stats: { added, removed } };
}

function parseStepInfo(step: ChatStep): ParsedStepInfo {
  if (step.type === 'thinking') {
    const raw = (step.text || 'Thinking...').trim();
    const durationMatch = raw.match(/(?:Reasoned|Thought) for ([0-9.]+s?)/i);
    const tokensMatch = raw.match(/([0-9.]+[kM]?)\s+tokens/i);

    const durationStr = durationMatch ? durationMatch[1] : step.duration;
    const tokenStr = tokensMatch ? `${tokensMatch[1]} tokens` : step.tokens ? `${step.tokens} tokens` : undefined;

    let subline = '';
    if (durationStr && tokenStr) {
      subline = `${durationStr}, ${tokenStr}`;
    } else if (durationStr) {
      subline = durationStr;
    } else if (tokenStr) {
      subline = tokenStr;
    }

    const title = durationStr
      ? `Thought for ${durationStr}${tokenStr ? `, ${tokenStr}` : ''}`
      : 'Thought';

    return {
      category: 'thought',
      name: title,
      subline,
      thoughtText: raw,
    };
  }

  const name = step.toolName || 'tool';
  const input = step.toolInput;
  const output = step.toolOutput;

  if (name === 'replace_file_content' || name === 'multi_replace_file_content' || name === 'write_to_file') {
    const targetFile = input?.TargetFile || input?.path || '';
    const formattedPath = formatDisplayPath(targetFile);
    const { lines, stats } = parseEditDiff(input);
    const instruction = input?.Instruction || input?.Description;

    const subline = stats.added > 0 || stats.removed > 0
      ? `+${stats.added} / -${stats.removed} lines`
      : 'Updated file';

    return {
      category: 'edit',
      name: 'Edit',
      target: formattedPath ? `(${formattedPath})` : undefined,
      subline,
      diffStats: stats,
      diffLines: lines,
      instruction,
      output,
    };
  }

  if (name === 'view_file' || name === 'read_url_content' || name === 'read_resource') {
    const filePath = input?.AbsolutePath || input?.Url || input?.Uri || input?.path || '';
    const formattedPath = formatDisplayPath(filePath);

    let lineCount = 0;
    if (input?.StartLine && input?.EndLine) {
      lineCount = Math.max(1, Number(input.EndLine) - Number(input.StartLine) + 1);
    } else if (output) {
      lineCount = output.split('\n').length;
    }

    const subline = lineCount > 0 ? `Read ${lineCount} lines` : 'Read file';

    return {
      category: 'read',
      name: 'Read',
      target: formattedPath ? `(${formattedPath})` : undefined,
      subline,
      readLinesCount: lineCount,
      output,
    };
  }

  if (name === 'run_command') {
    const cmd = input?.CommandLine || input?.command || '';
    const isDone = step.toolStatus === 'done';
    const subline = isDone ? 'exit 0' : 'running...';

    return {
      category: 'bash',
      name: 'Bash',
      target: cmd ? `(${cmd})` : undefined,
      subline,
      command: cmd,
      output,
    };
  }

  if (name === 'grep_search' || name === 'find_by_name' || name === 'list_dir') {
    const query = input?.Query || input?.Pattern || input?.DirectoryPath || '';
    const target = query ? `("${query}")` : undefined;
    let matchCount = 0;
    if (output) {
      try {
        const parsed = JSON.parse(output);
        if (Array.isArray(parsed)) matchCount = parsed.length;
      } catch {
        matchCount = output.split('\n').filter(Boolean).length;
      }
    }

    return {
      category: 'search',
      name: name === 'list_dir' ? 'Dir' : 'Grep',
      target,
      subline: matchCount > 0 ? `Found ${matchCount} matches` : 'Search completed',
      output,
    };
  }

  return {
    category: 'tool',
    name: name,
    subline: 'Tool execution',
    output,
  };
}

function calculateDuration(steps: ChatStep[]): string {
  if (steps.length === 0) return '';
  const first = steps[0]?.time ? new Date(steps[0].time).getTime() : null;
  const last = steps[steps.length - 1]?.time ? new Date(steps[steps.length - 1]!.time!).getTime() : null;

  if (first && last && !isNaN(first) && !isNaN(last)) {
    const diffSec = Math.max(1, Math.round((last - first) / 1000));
    if (diffSec < 60) return `${diffSec}s`;
    const mins = Math.floor(diffSec / 60);
    const rem = diffSec % 60;
    return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
  }
  return '';
}

function DiffViewer({ lines, instruction, output }: { lines: DiffLine[]; instruction?: string | undefined; output?: string | undefined }) {
  return (
    <div className="diff-container">
      {instruction && (
        <div className="diff-instruction-banner">
          <span className="diff-instruction-label">Instruction</span>
          <span className="diff-instruction-text">{instruction}</span>
        </div>
      )}
      <div className="diff-code-block">
        {lines.map((line, idx) => (
          <div key={idx} className={`diff-line diff-${line.type}`}>
            <span className="diff-gutter">{line.lineNum ?? ''}</span>
            <span className="diff-marker">{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}</span>
            <span className="diff-text">{line.text || ' '}</span>
          </div>
        ))}
      </div>
      {output && (
        <div className="diff-output-footer">
          <span>{output.length > 250 ? output.slice(0, 250) + '...' : output}</span>
        </div>
      )}
    </div>
  );
}

function CodeViewer({ code, startLine = 1 }: { code: string; startLine?: number | undefined }) {
  const lines = code.split('\n');
  return (
    <div className="code-viewer-container">
      <div className="code-viewer-block">
        {lines.slice(0, 160).map((line, idx) => (
          <div key={idx} className="code-viewer-line">
            <span className="code-viewer-gutter">{startLine + idx}</span>
            <span className="code-viewer-text">{line || ' '}</span>
          </div>
        ))}
        {lines.length > 160 && (
          <div className="code-viewer-truncated">
            ... and {lines.length - 160} more lines
          </div>
        )}
      </div>
    </div>
  );
}

function TerminalViewer({ command, output }: { command: string; output?: string | undefined }) {
  return (
    <div className="terminal-container">
      <div className="terminal-header">
        <span className="terminal-dots">
          <span className="term-dot red" />
          <span className="term-dot yellow" />
          <span className="term-dot green" />
        </span>
        <span className="terminal-title">bash</span>
      </div>
      <div className="terminal-body">
        <div className="terminal-cmd">
          <span className="terminal-prompt">$</span>
          <span className="terminal-cmd-text">{command}</span>
        </div>
        {output && (
          <pre className="terminal-output">
            {output.slice(0, 3000)}
            {output.length > 3000 ? '\n... (output truncated)' : ''}
          </pre>
        )}
      </div>
    </div>
  );
}

function ThoughtViewer({ text }: { text: string }) {
  return (
    <div className="thought-container">
      <div className="thought-body">{text}</div>
    </div>
  );
}

interface StepsDropdownProps {
  steps: ChatStep[];
  isWorking: boolean;
  initialOpen?: boolean | undefined;
}

export function StepsDropdown({ steps, isWorking, initialOpen }: StepsDropdownProps) {
  const [isOpen, setIsOpen] = useState(initialOpen !== undefined ? initialOpen : true);
  const [userToggled, setUserToggled] = useState(false);
  const [expandedStepIds, setExpandedStepIds] = useState<Set<string>>(() => new Set());
  const [filterCategory, setFilterCategory] = useState<'all' | 'edit' | 'read' | 'bash' | 'thought'>('all');

  useEffect(() => {
    if (!userToggled && isWorking) {
      setIsOpen(true);
    }
  }, [isWorking, userToggled]);

  const parsedSteps = useMemo(() => {
    return steps.map((s) => ({
      step: s,
      info: parseStepInfo(s),
    }));
  }, [steps]);

  useEffect(() => {
    if (isWorking) {
      const activeStep = steps.find((s) => s.toolStatus === 'active');
      if (activeStep) {
        setExpandedStepIds((prev) => {
          if (prev.has(activeStep.id)) return prev;
          const next = new Set(prev);
          next.add(activeStep.id);
          return next;
        });
      }
    }
  }, [steps, isWorking]);

  if (steps.length === 0) return null;

  const toggleStep = (id: string) => {
    setExpandedStepIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const filteredSteps = parsedSteps.filter(({ info }) => {
    if (filterCategory === 'all') return true;
    return info.category === filterCategory;
  });

  const allVisibleExpanded = filteredSteps.length > 0 && filteredSteps.every(({ step }) => expandedStepIds.has(step.id));

  const toggleAllVisible = () => {
    if (allVisibleExpanded) {
      setExpandedStepIds((prev) => {
        const next = new Set(prev);
        filteredSteps.forEach(({ step }) => next.delete(step.id));
        return next;
      });
    } else {
      setExpandedStepIds((prev) => {
        const next = new Set(prev);
        filteredSteps.forEach(({ step }) => next.add(step.id));
        return next;
      });
    }
  };

  const netDiff = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const { info } of parsedSteps) {
      if (info.diffStats) {
        added += info.diffStats.added;
        removed += info.diffStats.removed;
      }
    }
    return { added, removed };
  }, [parsedSteps]);

  const counts = useMemo(() => {
    let edit = 0;
    let read = 0;
    let bash = 0;
    let thought = 0;
    for (const { info } of parsedSteps) {
      if (info.category === 'edit') edit++;
      else if (info.category === 'read') read++;
      else if (info.category === 'bash') bash++;
      else if (info.category === 'thought') thought++;
    }
    return { edit, read, bash, thought, total: parsedSteps.length };
  }, [parsedSteps]);

  const duration = calculateDuration(steps);
  const headerText = isWorking
    ? `Running actions (${steps.length})`
    : duration
      ? `Completed ${steps.length} actions in ${duration}`
      : `Completed ${steps.length} actions`;

  return (
    <div className="steps-dropdown">
      <div
        className={`steps-dropdown-header ${isWorking ? 'working' : ''}`}
        onClick={() => {
          setUserToggled(true);
          setIsOpen(!isOpen);
        }}
      >
        <div className="steps-header-left">
          {isWorking ? (
            <span className="steps-pulse-dot" />
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent-emerald)' }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
          <span className="steps-header-title">{headerText}</span>
          {(netDiff.added > 0 || netDiff.removed > 0) && (
            <span className="diff-pill-stat">
              {netDiff.added > 0 && <span className="diff-pill-add">+{netDiff.added}</span>}
              {netDiff.added > 0 && netDiff.removed > 0 && <span className="diff-pill-sep"> / </span>}
              {netDiff.removed > 0 && <span className="diff-pill-del">-{netDiff.removed}</span>}
            </span>
          )}
        </div>
        <span className={`steps-chevron ${isOpen ? 'open' : ''}`}>⌵</span>
      </div>

      {isOpen && (
        <div className="steps-dropdown-body">
          <div className="step-toolbar">
            <div className="step-filter-pills">
              <button
                type="button"
                className={`step-filter-pill ${filterCategory === 'all' ? 'active' : ''}`}
                onClick={() => setFilterCategory('all')}
              >
                All ({counts.total})
              </button>
              {counts.edit > 0 && (
                <button
                  type="button"
                  className={`step-filter-pill ${filterCategory === 'edit' ? 'active' : ''}`}
                  onClick={() => setFilterCategory('edit')}
                >
                  Edits ({counts.edit})
                </button>
              )}
              {counts.read > 0 && (
                <button
                  type="button"
                  className={`step-filter-pill ${filterCategory === 'read' ? 'active' : ''}`}
                  onClick={() => setFilterCategory('read')}
                >
                  Reads ({counts.read})
                </button>
              )}
              {counts.bash > 0 && (
                <button
                  type="button"
                  className={`step-filter-pill ${filterCategory === 'bash' ? 'active' : ''}`}
                  onClick={() => setFilterCategory('bash')}
                >
                  Bash ({counts.bash})
                </button>
              )}
              {counts.thought > 0 && (
                <button
                  type="button"
                  className={`step-filter-pill ${filterCategory === 'thought' ? 'active' : ''}`}
                  onClick={() => setFilterCategory('thought')}
                >
                  Thoughts ({counts.thought})
                </button>
              )}
            </div>
            <button
              type="button"
              className="step-toggle-all-btn"
              onClick={toggleAllVisible}
            >
              {allVisibleExpanded ? 'Collapse all' : 'Expand all'}
            </button>
          </div>

          <div className="step-items-list">
            {filteredSteps.map(({ step, info }) => {
              const isExpanded = expandedStepIds.has(step.id);
              const isActive = step.toolStatus === 'active' && isWorking;

              if (info.category === 'thought') {
                return (
                  <div key={step.id} className="step-item-card thought">
                    <div className="step-thought-row" onClick={() => toggleStep(step.id)}>
                      <div className="step-thought-left">
                        <span className="step-disclosure-arrow">{isExpanded ? '▼' : '▶'}</span>
                        <span className="step-thought-title">{info.name}</span>
                      </div>
                      <span className={`step-subchevron ${isExpanded ? 'open' : ''}`}>›</span>
                    </div>
                    {isExpanded && info.thoughtText && (
                      <ThoughtViewer text={info.thoughtText} />
                    )}
                  </div>
                );
              }

              return (
                <div key={step.id} className={`step-item-card ${info.category} ${isActive ? 'active' : ''}`}>
                  <div className="step-action-row" onClick={() => toggleStep(step.id)}>
                    <div className="step-action-left">
                      <span className={`step-terminal-dot ${info.category}`} />
                      <span className={`step-action-name ${info.category}`}>{info.name}</span>
                      {info.target && (
                        <span className="step-action-target" title={info.target}>
                          {info.target}
                        </span>
                      )}
                    </div>
                    <div className="step-action-right">
                      {isActive ? (
                        <span className="step-active-pill">
                          <span className="step-mini-spinner" />
                          <span>running</span>
                        </span>
                      ) : (
                        <span className="step-done-check">✓</span>
                      )}
                      <span className={`step-subchevron ${isExpanded ? 'open' : ''}`}>›</span>
                    </div>
                  </div>

                  <div className="step-branch-line" onClick={() => toggleStep(step.id)}>
                    <span className="step-branch-symbol">└</span>
                    {info.category === 'edit' && info.diffStats ? (
                      <span className="step-branch-diff">
                        <span className="diff-stat-add">+{info.diffStats.added}</span>
                        <span className="diff-stat-sep"> / </span>
                        <span className="diff-stat-del">-{info.diffStats.removed}</span>
                        <span className="diff-stat-unit"> lines</span>
                      </span>
                    ) : (
                      <span className="step-branch-text">{info.subline}</span>
                    )}
                  </div>

                  {isExpanded && (
                    <div className="step-expanded-details">
                      {info.category === 'edit' && info.diffLines && info.diffLines.length > 0 && (
                        <DiffViewer
                          lines={info.diffLines}
                          instruction={info.instruction}
                          output={info.output}
                        />
                      )}

                      {info.category === 'read' && (
                        <CodeViewer
                          code={info.output || 'File read successfully'}
                          startLine={step.toolInput?.StartLine ? Number(step.toolInput.StartLine) : 1}
                        />
                      )}

                      {info.category === 'bash' && (
                        <TerminalViewer
                          command={info.command || ''}
                          output={info.output}
                        />
                      )}

                      {info.category !== 'edit' && info.category !== 'read' && info.category !== 'bash' && (
                        <div className="step-details-generic">
                          {step.toolInput && (
                            <pre className="step-json-block">
                              {JSON.stringify(step.toolInput, null, 2)}
                            </pre>
                          )}
                          {step.toolOutput && (
                            <pre className="step-output-block">
                              {step.toolOutput}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
