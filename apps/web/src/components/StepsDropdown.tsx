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
      icon: '$',
      title: cmd ? `Ran ${cmd}` : 'Ran terminal command',
    };
  }

  if (name === 'view_file') {
    const p = input?.AbsolutePath || input?.path || '';
    const base = p.split('/').filter(Boolean).pop() || 'file';
    return {
      icon: '📄',
      title: `Explored ${base}`,
    };
  }

  if (name === 'replace_file_content' || name === 'multi_replace_file_content' || name === 'write_to_file') {
    const p = input?.TargetFile || input?.path || '';
    const base = p.split('/').filter(Boolean).pop() || 'file';
    const ext = base.includes('.') ? base.split('.').pop()?.toUpperCase() : undefined;
    return {
      icon: '✏️',
      title: `Edited ${base}`,
      tag: ext && ext.length <= 4 ? ext : undefined,
    };
  }

  if (name === 'list_dir') {
    const dir = input?.DirectoryPath || input?.path || '';
    const base = dir.split('/').filter(Boolean).pop() || 'directory';
    return {
      icon: '📁',
      title: `Explored /${base}`,
    };
  }

  if (name === 'grep_search') {
    const q = input?.Query || '';
    return {
      icon: '🔍',
      title: q ? `Explored search "${q.slice(0, 30)}"` : 'Explored search',
    };
  }

  if (name === 'search_web') {
    const q = input?.query || '';
    return {
      icon: '🌐',
      title: q ? `Searched web for "${q.slice(0, 30)}"` : 'Searched web',
    };
  }

  if (name === 'call_mcp_tool') {
    const tool = input?.ToolName || 'tool';
    return {
      icon: '🔌',
      title: `Ran ${tool}`,
    };
  }

  return {
    icon: '⚙️',
    title: `Ran ${name}`,
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
    ? `Working on task (${steps.length} ${steps.length === 1 ? 'step' : 'steps'})`
    : duration
      ? `Worked for ${duration}`
      : `Completed ${steps.length} ${steps.length === 1 ? 'action' : 'actions'}`;

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
            <span style={{ fontSize: '0.8125rem' }}>⚙️</span>
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
                    {step.toolStatus === 'active' ? (
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
                      <div style={{ marginBottom: 6 }}>
                        <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 2 }}>
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
                        <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 2 }}>
                          Output
                        </div>
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>
                          {step.toolOutput.slice(0, 1000)}
                          {step.toolOutput.length > 1000 ? '\n... (truncated)' : ''}
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
