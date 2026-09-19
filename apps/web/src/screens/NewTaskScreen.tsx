import { useState, useRef } from 'react';
import type { MachineRow, TaskKind, TaskMode } from '@remote-hands/shared';
import { SafeThinkingOrb as ThinkingOrb } from '../components/SafeThinkingOrb.js';
import { useVoiceInput } from '../hooks/useVoiceInput.js';
import {
  SUPPORTED_MODELS,
  EFFORT_OPTIONS,
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  isClaudeModel,
  getModelOption,
  getValidEffortForModel,
} from '../models.js';

export interface NewTaskScreenProps {
  machine: MachineRow;
  onCreateTask: (prompt: string, kind: TaskKind, mode: TaskMode, model?: string, effort?: string) => Promise<void>;
  onCancel: () => void;
  loading: boolean;
}

const KINDS: { value: TaskKind; label: string; icon: string }[] = [
  { value: 'browser', label: 'Browser', icon: '🌐' },
  { value: 'coding', label: 'Coding', icon: '💻' },
  { value: 'mixed', label: 'Mixed', icon: '⚡' },
];

const MODES: { value: TaskMode; label: string }[] = [
  { value: 'default', label: 'Direct' },
  { value: 'plan', label: 'Plan First' },
  { value: 'accept-edits', label: 'Auto-Accept' },
];

export function NewTaskScreen({ machine, onCreateTask, onCancel, loading }: NewTaskScreenProps) {
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<TaskKind>('browser');
  const [mode, setMode] = useState<TaskMode>('default');
  const [model, setModel] = useState<string>(() => {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem('rh_model') || DEFAULT_MODEL;
    }
    return DEFAULT_MODEL;
  });
  const [effort, setEffort] = useState<string>(() => {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem('rh_effort') || DEFAULT_EFFORT;
    }
    return DEFAULT_EFFORT;
  });
  const voiceBasePromptRef = useRef('');

  const isClaude = isClaudeModel(model);
  const currentModelOption = getModelOption(model);

  const handleModelChange = (nextModel: string) => {
    setModel(nextModel);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('rh_model', nextModel);
    }
    const nextEffort = getValidEffortForModel(nextModel, effort);
    if (nextEffort !== effort) {
      setEffort(nextEffort);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('rh_effort', nextEffort);
      }
    }
  };

  const handleEffortChange = (nextEffort: string) => {
    setEffort(nextEffort);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('rh_effort', nextEffort);
    }
  };

  const handleTranscriptChange = (spokenText: string) => {
    const fullText = voiceBasePromptRef.current
      ? `${voiceBasePromptRef.current} ${spokenText.trim()}`
      : spokenText.trim();
    setPrompt(fullText);
  };

  const {
    isSupported: isVoiceSupported,
    isListening: isVoiceListening,
    startListening: startVoiceListening,
    stopListening: stopVoiceListening,
  } = useVoiceInput({
    onTranscriptChange: handleTranscriptChange,
    silenceTimeoutMs: 0,
  });

  const handleToggleVoice = () => {
    if (isVoiceListening) {
      stopVoiceListening();
    } else {
      voiceBasePromptRef.current = prompt.trim();
      startVoiceListening();
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isVoiceListening) {
      stopVoiceListening();
    }
    if (!prompt.trim() || loading) return;
    onCreateTask(prompt.trim(), kind, mode, model, isClaude ? undefined : effort);
  };

  return (
    <div className="screen-content new-task-content">
      <div className="section-header" style={{ marginBottom: 8 }}>
        <button className="chat-nav-back" onClick={onCancel} type="button">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>Machines</span>
        </button>
        <span className="badge-badge">{machine.name}</span>
      </div>

      <div style={{ marginBottom: 12 }}>
        <h2 className="section-title">New Task on {machine.name}</h2>
        <p className="section-subtitle">Dispatch remote commands and browser actions to your Mac</p>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label className="segmented-label">Instructions</label>
            <button
              type="button"
              className={`voice-section-btn ${isVoiceListening ? 'listening' : ''}`}
              onClick={handleToggleVoice}
              disabled={loading || !isVoiceSupported}
              title={isVoiceListening ? 'Click to stop listening' : 'Speak prompt'}
              data-testid="new-task-voice-btn"
            >
              {isVoiceListening ? (
                <>
                  <span className="voice-soundwave" style={{ height: 12 }}>
                    <span className="voice-soundwave-bar" style={{ width: 2 }} />
                    <span className="voice-soundwave-bar" style={{ width: 2 }} />
                    <span className="voice-soundwave-bar" style={{ width: 2 }} />
                  </span>
                  <span>Listening...</span>
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                  <span>Speak Prompt</span>
                </>
              )}
            </button>
          </div>
          <textarea
            className="textarea"
            data-testid="task-prompt-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g., Navigate to my WordPress admin, add a privacy policy page with standard GDPR template and publish it."
            rows={5}
            required
            autoFocus
          />
        </div>

        <div className="segmented-group">
          <label className="segmented-label">Execution Environment</label>
          <div className="segmented-control">
            {KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                className={`segmented-button ${kind === k.value ? 'active' : ''}`}
                onClick={() => setKind(k.value)}
              >
                <span>{k.icon} {k.label}</span>
              </button>
            ))}
          </div>
          <select
            data-testid="task-kind-select"
            value={kind}
            onChange={(e) => setKind(e.target.value as TaskKind)}
            style={{ display: 'none' }}
          >
            <option value="browser">Browser</option>
            <option value="coding">Coding</option>
            <option value="mixed">Mixed</option>
          </select>
        </div>

        <div className="segmented-group">
          <label className="segmented-label">Approval Strategy</label>
          <div className="segmented-control">
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                className={`segmented-button ${mode === m.value ? 'active' : ''}`}
                onClick={() => setMode(m.value)}
              >
                <span>{m.label}</span>
              </button>
            ))}
          </div>
          <select
            data-testid="task-mode-select"
            value={mode}
            onChange={(e) => setMode(e.target.value as TaskMode)}
            style={{ display: 'none' }}
          >
            <option value="default">Default</option>
            <option value="plan">Plan</option>
            <option value="accept-edits">Accept Edits</option>
          </select>
        </div>

        <div className="segmented-group">
          <label className="segmented-label" htmlFor="task-model-select">Model</label>
          <div className="model-select-wrapper">
            <select
              id="task-model-select"
              data-testid="task-model-select"
              className="select-input model-select"
              value={model}
              onChange={(e) => handleModelChange(e.target.value)}
            >
              {SUPPORTED_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <span className="select-arrow" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </span>
          </div>
        </div>

        <div className="segmented-group" data-testid="task-effort-group">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label className="segmented-label">Reasoning Effort</label>
            {isClaude && <span className="effort-badge-hint" data-testid="effort-claude-hint">Adaptive Thinking</span>}
          </div>
          <div className={`segmented-control ${isClaude ? 'is-disabled' : ''}`}>
            {EFFORT_OPTIONS.map((eff) => {
              const isSupported = !isClaude && currentModelOption.supportedEfforts.includes(eff.value);
              return (
                <button
                  key={eff.value}
                  type="button"
                  data-testid={`effort-btn-${eff.value}`}
                  className={`segmented-button ${!isClaude && effort === eff.value ? 'active' : ''} ${!isSupported ? 'disabled' : ''}`}
                  disabled={!isSupported}
                  onClick={() => isSupported && handleEffortChange(eff.value)}
                >
                  <span>{eff.label}</span>
                </button>
              );
            })}
          </div>
          <select
            data-testid="task-effort-select"
            value={effort}
            disabled={isClaude}
            onChange={(e) => handleEffortChange(e.target.value)}
            style={{ display: 'none' }}
          >
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          data-testid="submit-task-btn"
          disabled={!prompt.trim() || loading}
          style={{ marginTop: 8 }}
        >
          {loading ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ThinkingOrb state="connecting" size={20} theme="dark" role="presentation" />
              <span>Starting agy...</span>
            </span>
          ) : (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>Dispatch Task</span>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </span>
          )}
        </button>
      </form>
    </div>
  );
}
