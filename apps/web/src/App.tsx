import { useState, useEffect } from 'react';
import type { MachineRow } from '@remote-hands/shared';
import { apiClient } from './api/client.js';

export function App() {
  const [machines, setMachines] = useState<MachineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const list = await apiClient.listMachines();
        setMachines(list);
      } catch (err: any) {
        setError(err?.message || 'Failed to load machines');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  return (
    <div className="app-container">
      <header className="header">
        <h1>Remote Hands</h1>
        <span className="badge badge-online">PWA</span>
      </header>

      <main>
        <div style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
            Available Machines
          </h2>
        </div>

        {loading && (
          <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
            Loading machines...
          </div>
        )}

        {error && (
          <div className="card" style={{ borderColor: 'var(--accent-rose)', color: 'var(--accent-rose)' }}>
            {error}
          </div>
        )}

        {!loading && !error && machines.length === 0 && (
          <div className="card" data-testid="machines-placeholder" style={{ textAlign: 'center', padding: '32px 16px' }}>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>No machines connected</p>
            <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
              Run <code>remote-hands daemon</code> on your computer to pair.
            </p>
          </div>
        )}

        {!loading && !error && machines.length > 0 && (
          <div>
            {machines.map((machine) => (
              <div key={machine.id} className="card" style={{ cursor: 'pointer' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong>{machine.name}</strong>
                  <span className={`badge ${machine.status === 'online' ? 'badge-online' : 'badge-offline'}`}>
                    {machine.status}
                  </span>
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
                  {machine.hostname}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
