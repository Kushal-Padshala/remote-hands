import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from './App.js';
import { apiClient } from './api/client.js';

describe('App Smoke Test', () => {
  it('renders machine list placeholder when no machines are connected', async () => {
    vi.spyOn(apiClient, 'listMachines').mockResolvedValue([]);

    render(<App />);

    expect(screen.getByText('Remote Hands')).toBeDefined();

    await waitFor(() => {
      const placeholder = screen.getByTestId('machines-placeholder');
      expect(placeholder).toBeDefined();
      expect(screen.getByText('No machines connected')).toBeDefined();
    });
  });

  it('renders machine list when machines are returned', async () => {
    vi.spyOn(apiClient, 'listMachines').mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        owner_id: '22222222-2222-4222-8222-222222222222',
        name: 'Work Laptop',
        hostname: 'macbook.local',
        daemon_version: '0.1.0',
        agy_version: '0.2.0',
        status: 'online',
        last_seen_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
    ]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Work Laptop')).toBeDefined();
      expect(screen.getByText('macbook.local')).toBeDefined();
    });
  });
});
