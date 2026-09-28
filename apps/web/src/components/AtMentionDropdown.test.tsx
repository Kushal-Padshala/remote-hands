import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AtMentionDropdown } from './AtMentionDropdown.js';
import { AttachmentChips } from './AttachmentChips.js';
import type { ContextHierarchy, ContextAttachment } from '@remote-hands/shared';

const mockHierarchy: ContextHierarchy = {
  browsers: [
    {
      id: 'chrome',
      name: 'Google Chrome',
      profiles: [
        {
          id: 'Personal',
          name: 'Personal',
          tabs: [
            { id: 'c1', title: 'Property Details 101', url: 'https://example.com/prop/101', tabIndex: 1 },
            { id: 'c2', title: 'Analytics Dashboard', url: 'https://example.com/dash', tabIndex: 2 },
          ],
        },
      ],
    },
    {
      id: 'arc',
      name: 'Arc',
      profiles: [
        {
          id: 'default',
          name: 'Default',
          tabs: [
            { id: 'a1', title: 'Meta Ads Manager', url: 'https://adsmanager.facebook.com' },
          ],
        },
      ],
    },
  ],
  apps: [
    {
      id: 'vscode',
      name: 'Visual Studio Code',
      windows: [{ id: 'w1', title: 'remote-hands' }],
    },
  ],
  files: [
    {
      id: 'f1',
      name: 'banner.png',
      path: '/mock/banner.png',
      isDir: false,
    },
  ],
};

describe('AtMentionDropdown and AttachmentChips', () => {
  it('renders dropdown and allows drilling down into browser tabs and multi-selecting', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <AtMentionDropdown
        isOpen={true}
        hierarchy={mockHierarchy}
        onSelectAttachments={onSelect}
        onClose={onClose}
      />
    );

    expect(screen.getByText(/Google Chrome/)).toBeDefined();
    expect(screen.getByText(/Arc/)).toBeDefined();
    expect(screen.getByText(/Visual Studio Code/)).toBeDefined();
    expect(screen.getByText(/banner\.png/)).toBeDefined();

    fireEvent.click(screen.getByText(/Google Chrome/));

    expect(screen.getByText('Property Details 101')).toBeDefined();
    expect(screen.getByText('Analytics Dashboard')).toBeDefined();

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBe(2);

    fireEvent.click(checkboxes[0]!);
    fireEvent.click(checkboxes[1]!);

    const attachBtn = screen.getByText('Attach Selected (2)');
    fireEvent.click(attachBtn);

    expect(onSelect).toHaveBeenCalledTimes(1);
    const selected = onSelect.mock.calls[0]![0] as ContextAttachment[];
    expect(selected.length).toBe(2);
    expect(selected[0]?.type).toBe('browser_tab');
  });

  it('renders attachment chips and allows removing them', () => {
    const onRemove = vi.fn();
    const attachments: ContextAttachment[] = [
      {
        type: 'browser_tab',
        id: 'tab-1',
        browser: 'chrome',
        title: 'Property Details 101',
        url: 'https://example.com/prop/101',
      },
      {
        type: 'local_file',
        id: 'file-1',
        name: 'banner.png',
        path: '/mock/banner.png',
      },
    ];

    render(<AttachmentChips attachments={attachments} onRemove={onRemove} />);

    expect(screen.getByText(/Property Details 101/)).toBeDefined();
    expect(screen.getByText(/banner.png/)).toBeDefined();

    const removeButtons = screen.getAllByRole('button', { name: /remove/i });
    expect(removeButtons.length).toBe(2);

    fireEvent.click(removeButtons[0]!);
    expect(onRemove).toHaveBeenCalledWith('tab-1');
  });
});
