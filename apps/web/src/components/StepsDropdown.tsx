import { useState, useEffect } from 'react';

export interface ChatStep {
  id: string;
  type: 'tool' | 'thinking';
  text?: string;
  toolName?: string;
  toolInput?: any;
  toolOutput?: string;
  toolStatus?: 'active' | 'done';
  time?: string;
}

interface StepsDropdownProps {
  steps: ChatStep[];
  isWorking: boolean;
}

function formatStepDetails(step: ChatStep): {
  icon: string;
  title: string;
  tag?: string;
} {
  if (step.type === 'thinking') {
    const raw = step.text || 'Thinking...';
    const match = raw.match(/(?:Reasoned|Thought) for ([0-9.]+s?)/i);
    if (match) {
      return { icon: '🧠', title: `Thought for ${match[1]}` };
    }
    return {
      icon: '🧠',
      title: raw.length > 50 ? raw.slice(0, 50) + '...' : raw,
    };
  }

  const name = step.toolName || 'tool';
  const input = step.toolInput;

  if (name === 'run_command') {
    const cmd = input?.CommandLine || input?.command || '';
    return {
      icon: '⚡',
      title: cmd ? `$ ${cmd}` : 'Ran terminal command',
      tag: 'CMD',
    };
  }

  if (name === 'view_file') {
    const p = input?.AbsolutePath || input?.path || '';
    const base = p.split('/').filter(Boolean).pop() || 'file';
    const ext = base.includes('.') ? base.split('.').pop()?.toUpperCase() : undefined;
    return {
      icon: '📄',
      title: base,
      tag: ext && ext.length <= 4 ? ext : 'READ',
    };
  }

  if (name === 'replace_file_content' || name === 'multi_replace_file_content' || name === 'write_to_file') {
    const p = input?.TargetFile || input?.path || '';
    const base = p.split('/').filter(Boolean).pop() || 'file';
    const ext = base.includes('.') ? base.split('.').pop()?.toUpperCase() : undefined;
    return {
      icon: '✏️',
      title: base,
      tag: ext && ext.length <= 4 ? ext : 'EDIT',
    };
  }

  if (name === 'list_dir') {
    const dir = input?.DirectoryPath || input?.path || '';
    const base = dir.split('/').filter(Boolean).pop() || 'directory';
    return {
      icon: '📁',
      title: `/${base}`,
      tag: 'DIR',
    };
  }

  if (name === 'grep_search') {
    const q = input?.Query || '';
    return {
      icon: '🔍',
      title: q ? `"${q.slice(0, 32)}"` : 'Search',
      tag: 'GREP',
    };
  }

  if (name === 'search_web') {
    const q = input?.query || '';
    return {
      icon: '🌐',
      title: q ? `"${q.slice(0, 32)}"` : 'Web',
      tag: 'WEB',
    };
  }

  if (name === 'call_mcp_tool') {
    const tool = input?.ToolName || 'tool';
    return {
      icon: '🔌',
      title: tool,
      tag: 'MCP',
    };
  }

  return {
    icon: '⚙️',
    title: name,
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

export function StepsDropdown({ steps, isWorking }: StepsDropdownProps) {
  const [isOpen, setIsOpen] = useState(isWorking);
  const [userToggled, setUserToggled] = useState(false);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);

  useEffect(() => {
    if (!userToggled) {
      setIsOpen(isWorking);
    }
  }, [isWorking, userToggled]);

  if (steps.length === 0) return null;

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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent-emerald)' }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
          <span>{headerText}</span>
        </div>
        <span className={`steps-chevron ${isOpen ? 'open' : ''}`}>⌵</span>
      </div>

      {isOpen && (
        <div className="steps-dropdown-body">
          {steps.map((step) => {
            const formatted = formatStepDetails(step);
            const isStepExpanded = expandedStepId === step.id;
            const hasExtra = Boolean(step.toolInput || step.toolOutput);

            return (
              <div key={step.id} className="step-item-wrapper">
                <div
                  className="step-row"
                  onClick={() => {
                    if (hasExtra) {
                      setExpandedStepId(isStepExpanded ? null : step.id);
                    }
                  }}
                  style={{ cursor: hasExtra ? 'pointer' : 'default' }}
                >
                  <div className="step-row-left">
                    <span className="step-icon">{formatted.icon}</span>
                    {formatted.tag && <span className="step-tag">{formatted.tag}</span>}
                    <span className="step-title">{formatted.title}</span>
                  </div>

                  <div className="step-row-right">
                    {step.toolStatus === 'active' && isWorking ? (
                      <span className="step-status running">● running</span>
                    ) : (
                      <span className="step-status done">✓</span>
                    )}
                    {hasExtra && (
                      <span className={`step-subchevron ${isStepExpanded ? 'open' : ''}`}>›</span>
                    )}
                  </div>
                </div>

                {isStepExpanded && (
                  <div className="step-details">
                    {step.toolInput && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 3, fontWeight: 600 }}>
                          Input
                        </div>
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>
                          {typeof step.toolInput === 'object'
                            ? JSON.stringify(step.toolInput, null, 2)
                            : String(step.toolInput)}
                        </pre>
                      </div>
                    )}
                    {step.toolOutput && (
                      <div>
                        <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 3, fontWeight: 600 }}>
                          Output
                        </div>
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>
                          {step.toolOutput.slice(0, 1500)}
                          {step.toolOutput.length > 1500 ? '\n... (truncated)' : ''}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
