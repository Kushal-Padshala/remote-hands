import { describe, expect, it } from 'vitest';
import type {
  BrowserTabAttachment,
  ContextAttachment,
  ContextHierarchy,
  Task,
} from './index.js';

describe('Context Attachment Types', () => {
  it('validates attachment interfaces and task attachment property', () => {
    const tab: BrowserTabAttachment = {
      type: 'browser_tab',
      id: 'tab-1',
      browser: 'chrome',
      profile: 'Personal',
      title: 'Property Details',
      url: 'https://example.com/prop/101',
      tabIndex: 2,
    };

    const task: Task = {
      id: 'task-test-1',
      user_id: 'user-1',
      machine_id: 'machine-1',
      prompt: 'Check property details',
      kind: 'browser',
      workspace_path: null,
      model: null,
      effort: null,
      mode: 'default',
      status: 'queued',
      conversation_id: null,
      parent_task_id: null,
      result_summary: null,
      error: null,
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      attachments: [tab],
    };

    const hierarchy: ContextHierarchy = {
      browsers: [
        {
          id: 'chrome',
          name: 'Google Chrome',
          profiles: [
            {
              id: 'Default',
              name: 'Personal',
              tabs: [{ id: 'tab-1', title: 'Property Details', url: 'https://example.com/prop/101' }],
            },
          ],
        },
      ],
      apps: [],
      files: [],
    };

    expect(task.attachments?.length).toBe(1);
    expect(task.attachments?.[0]?.type).toBe('browser_tab');
    expect(hierarchy.browsers[0]?.profiles[0]?.tabs.length).toBe(1);
  });
});
