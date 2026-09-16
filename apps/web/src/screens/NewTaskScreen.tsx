import { useState } from 'react';
import type { MachineRow, TaskKind, TaskMode } from '@remote-hands/shared';

export interface NewTaskScreenProps {
  machine: MachineRow;
  onCreateTask: (prompt: string, kind: TaskKind, mode: TaskMode) => Promise<void>;
  onCancel: () => void;
  loading: boolean;
}

export function NewTaskScreen({ machine, onCreateTask, onCancel, loading }: NewTaskScreenProps) {
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<TaskKind>('browser');
  const [mode, setMode] = useState<TaskMode>('default');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || loading) return;
    onCreateTask(prompt.trim(), kind, mode);
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <button
          className="btn"
          style={{ width: 'auto', padding: '6px 12px', background: 'transparent', color: 'var(--text-secondary)' }}
          onClick={onCancel}
        >
          ← Back
        </button>
        <h2 style={{ fontSize: '1.125rem', fontWeight: 600 }}>
          New Task on {machine.name}
        </h2>
      </div>

      <form onSubmit={handleSubmit} className="card">
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
            Task Instructions
          </label>
          <textarea
            className="textarea"
            data-testid="task-prompt-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g., Navigate to my WordPress admin, add a privacy policy page with standard GDPR template and publish it."
            rows={4}
            required
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
              Kind
            </label>
            <select
              className="input"
              data-testid="task-kind-select"
              value={kind}
              onChange={(e) => setKind(e.target.value as TaskKind)}
            >
              <option value="browser">Browser</option>
              <option value="coding">Coding</option>
              <option value="mixed">Mixed</option>
            </select>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
              Mode
            </label>
            <select
              className="input"
              data-testid="task-mode-select"
              value={mode}
              onChange={(e) => setMode(e.target.value as TaskMode)}
            >
              <option value="default">Default</option>
              <option value="plan">Plan</option>
              <option value="accept-edits">Accept Edits</option>
            </select>
          </div>
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          data-testid="submit-task-btn"
          disabled={!prompt.trim() || loading}
        >
          {loading ? 'Submitting...' : 'Dispatch Task to Machine'}
        </button>
      </form>
    </div>
  );
}
