import { useState, useEffect } from 'react';
import type { MachineRow, TaskRow, TaskKind, TaskMode } from '@remote-hands/shared';
import { apiClient } from './api/client.js';
import { MachinesScreen } from './screens/MachinesScreen.js';
import { NewTaskScreen } from './screens/NewTaskScreen.js';
import { LiveTaskScreen } from './screens/LiveTaskScreen.js';
import { PairingModal } from './components/PairingModal.js';

export function App() {
  const [machines, setMachines] = useState<MachineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [currentScreen, setCurrentScreen] = useState<'machines' | 'new-task' | 'live-task'>('machines');
  const [selectedMachine, setSelectedMachine] = useState<MachineRow | null>(null);
  const [activeTask, setActiveTask] = useState<TaskRow | null>(null);
  const [submittingTask, setSubmittingTask] = useState(false);
  const [showPairModal, setShowPairModal] = useState(false);
  const [pairingCode, setPairingCode] = useState<string | undefined>(undefined);
  const [pasteUrlInput, setPasteUrlInput] = useState('');

  const handleClearCache = () => {
    try {
      localStorage.removeItem('rh_token');
      localStorage.removeItem('rh_pairing_code');
      localStorage.removeItem('rh_api_url');
    } catch {}
    setPairingCode(undefined);
    setError(null);
    setMachines([]);
    if (typeof window !== 'undefined') {
      window.location.href = window.location.origin;
    }
  };

  const handleConnectUrl = (rawUrl: string) => {
    try {
      const parsed = new URL(rawUrl.trim());
      const secret = parsed.searchParams.get('secret') || parsed.searchParams.get('token');
      const api = parsed.searchParams.get('api');
      const code = parsed.searchParams.get('code');
      if (api) apiClient.setBaseUrl(api);
      if (secret) apiClient.setToken(secret);
      if (code) {
        setPairingCode(code);
        try {
          localStorage.setItem('rh_pairing_code', code);
        } catch {}
      }
      setPasteUrlInput('');
      loadMachines();
    } catch {
      alert('Invalid pairing URL');
    }
  };

  async function loadMachines() {
    setLoading(true);
    setError(null);
    try {
      const list = await apiClient.listMachines();
      setMachines(list);
    } catch (err: any) {
      const msg = err?.message || 'Failed to load machines';
      setError(msg);
      if (msg.includes('Valid session token required') || msg.includes('401') || msg.includes('Unauthorized')) {
        setPairingCode(undefined);
        try {
          localStorage.removeItem('rh_pairing_code');
        } catch {}
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const api = params.get('api');
      if (api) {
        apiClient.setBaseUrl(api);
      }
      const secret = params.get('secret') || params.get('token');
      if (secret) {
        apiClient.setToken(secret);
      }
      const code = params.get('code');
      if (code) {
        setPairingCode(code);
        try {
          localStorage.setItem('rh_pairing_code', code);
        } catch {}
      } else {
        try {
          const cached = localStorage.getItem('rh_pairing_code');
          if (cached) {
            setPairingCode(cached);
          }
        } catch {}
      }
    }
    loadMachines();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadMachines();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    const interval = setInterval(loadMachines, 10000);
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      clearInterval(interval);
    };
  }, []);

  const handleSelectMachine = (machine: MachineRow) => {
    setSelectedMachine(machine);
    setCurrentScreen('new-task');
  };

  const handleCreateTask = async (prompt: string, kind: TaskKind, mode: TaskMode) => {
    if (!selectedMachine) return;
    setSubmittingTask(true);
    try {
      const task = await apiClient.createTask({
        machine_id: selectedMachine.id,
        prompt,
        kind,
        mode,
      });
      setActiveTask(task);
      setCurrentScreen('live-task');
    } catch (err: any) {
      alert(err?.message || 'Failed to create task');
    } finally {
      setSubmittingTask(false);
    }
  };

  return (
    <div className="app-container">
      <header className="header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h1>Remote Hands</h1>
          <span className="badge badge-online">PWA</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            className="btn"
            style={{ width: 'auto', padding: '6px 10px', fontSize: '0.75rem' }}
            onClick={handleClearCache}
          >
            Reset
          </button>
          <button
            className="btn"
            style={{ width: 'auto', padding: '6px 12px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: 4 }}
            onClick={() => setShowPairModal(true)}
          >
            📱 QR Code
          </button>
        </div>
      </header>

      <main>
        {pairingCode && (
          <div
            className="card"
            style={{
              borderColor: 'var(--accent-teal)',
              backgroundColor: 'rgba(20, 184, 166, 0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 16,
              padding: '10px 14px',
            }}
          >
            <span style={{ fontSize: '0.8125rem', color: 'var(--accent-teal)', fontWeight: 600 }}>
              📱 Direct Pairing Active: {pairingCode}
            </span>
            <button
              className="btn"
              style={{ width: 'auto', padding: '3px 10px', fontSize: '0.75rem' }}
              onClick={() => setShowPairModal(true)}
            >
              QR Code
            </button>
          </div>
        )}

        {error && (
          <div className="card" style={{ borderColor: 'var(--accent-rose)', marginBottom: 16 }}>
            <div style={{ color: 'var(--accent-rose)', fontWeight: 600, marginBottom: 8 }}>
              {error.includes('session token') ? 'Phone Not Paired' : error}
            </div>
            {error.includes('session token') && (
              <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                <p style={{ marginBottom: 10 }}>
                  This device does not have an active session with your computer.
                </p>
                <p style={{ marginBottom: 10 }}>
                  Run <code>rh pair</code> on your computer to view your pairing QR code or direct link.
                </p>
                <div style={{ display: 'flex', gap: 8, marginTop: 12, marginBottom: 12 }}>
                  <input
                    type="text"
                    className="input"
                    placeholder="Paste pairing URL or token..."
                    value={pasteUrlInput}
                    onChange={(e) => setPasteUrlInput(e.target.value)}
                    style={{ flex: 1, padding: '8px 12px', fontSize: '0.75rem' }}
                  />
                  <button
                    className="btn btn-primary"
                    style={{ width: 'auto', padding: '8px 14px', fontSize: '0.75rem' }}
                    onClick={() => handleConnectUrl(pasteUrlInput)}
                  >
                    Connect
                  </button>
                </div>
                <button
                  className="btn"
                  style={{ width: 'auto', padding: '6px 12px', fontSize: '0.75rem' }}
                  onClick={handleClearCache}
                >
                  Clear Cache
                </button>
              </div>
            )}
          </div>
        )}

        {currentScreen === 'machines' && (
          <MachinesScreen
            machines={machines}
            onSelectMachine={handleSelectMachine}
            onRefresh={loadMachines}
            loading={loading}
            onShowPairQr={() => setShowPairModal(true)}
          />
        )}

        {currentScreen === 'new-task' && selectedMachine && (
          <NewTaskScreen
            machine={selectedMachine}
            onCreateTask={handleCreateTask}
            onCancel={() => setCurrentScreen('machines')}
            loading={submittingTask}
          />
        )}

        {currentScreen === 'live-task' && activeTask && (
          <LiveTaskScreen
            task={activeTask}
            onBack={() => {
              setActiveTask(null);
              setCurrentScreen('machines');
            }}
          />
        )}
      </main>

      <PairingModal
        isOpen={showPairModal}
        onClose={() => setShowPairModal(false)}
        pairingCode={pairingCode}
      />
    </div>
  );
}

export default App;
