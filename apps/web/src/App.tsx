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

  async function loadMachines() {
    setLoading(true);
    setError(null);
    try {
      const list = await apiClient.listMachines();
      setMachines(list);
    } catch (err: any) {
      setError(err?.message || 'Failed to load machines');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadMachines();
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      if (code) {
        setPairingCode(code);
      }
    }
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
        <button
          className="btn"
          style={{ width: 'auto', padding: '6px 12px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: 4 }}
          onClick={() => setShowPairModal(true)}
        >
          📱 QR Code
        </button>
      </header>

      <main>
        {error && (
          <div className="card" style={{ borderColor: 'var(--accent-rose)', color: 'var(--accent-rose)', marginBottom: 16 }}>
            {error}
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
