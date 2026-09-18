import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StepsDropdown, type ChatStep } from './StepsDropdown.js';

describe('StepsDropdown', () => {
  const sampleSteps: ChatStep[] = [
    {
      id: 'step-1',
      type: 'tool',
      toolName: 'view_file',
      toolInput: {
        AbsolutePath: '/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/hermes-brain.ts',
        StartLine: 1,
        EndLine: 80,
      },
      toolOutput: 'const x = 1;\nconst y = 2;',
      toolStatus: 'done',
      time: new Date(Date.now() - 10000).toISOString(),
    },
    {
      id: 'step-2',
      type: 'thinking',
      text: 'Thought for 3s, 665 tokens\nChecking for new recipes that can be extracted.',
      time: new Date(Date.now() - 8000).toISOString(),
    },
    {
      id: 'step-3',
      type: 'tool',
      toolName: 'replace_file_content',
      toolInput: {
        TargetFile: '/Users/kushal/Desktop/project/remote-hands/packages/daemon/src/hermes-brain.ts',
        StartLine: 52,
        EndLine: 52,
        TargetContent: 'initialProjects.push(defaultProject);',
        ReplacementContent: 'initialProjects.push({\n  ...defaultProject,\n  aliases: [],\n});',
        Instruction: 'Update default project registration',
      },
      toolOutput: 'Successfully replaced content',
      toolStatus: 'done',
      time: new Date(Date.now() - 4000).toISOString(),
    },
    {
      id: 'step-4',
      type: 'tool',
      toolName: 'run_command',
      toolInput: {
        CommandLine: 'pnpm test',
      },
      toolOutput: 'Tests passed: 12 suites, 67 tests',
      toolStatus: 'done',
      time: new Date(Date.now() - 1000).toISOString(),
    },
  ];

  it('renders dropdown header with net diff and action count', () => {
    render(<StepsDropdown steps={sampleSteps} isWorking={false} />);

    expect(screen.getByText(/Completed 4 actions/)).toBeDefined();
    expect(screen.getAllByText('+4').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('-1').length).toBeGreaterThanOrEqual(1);
  });

  it('displays categorized action rows with paths, line counts, and diff stats', () => {
    render(<StepsDropdown steps={sampleSteps} isWorking={false} />);

    expect(screen.getByText('Read')).toBeDefined();
    expect(screen.getByText('Edit')).toBeDefined();
    expect(screen.getByText('Bash')).toBeDefined();
    expect(screen.getByText(/Thought for 3s/)).toBeDefined();

    expect(screen.getAllByText('(~/Desktop/project/remote-hands/packages/daemon/src/hermes-brain.ts)').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Read 80 lines')).toBeDefined();
    expect(screen.getAllByText('+4').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('-1').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('(pnpm test)')).toBeDefined();
    expect(screen.getByText('exit 0')).toBeDefined();
  });

  it('expands line-by-line diff when edit item is clicked', () => {
    render(<StepsDropdown steps={sampleSteps} isWorking={false} />);

    expect(screen.queryByText('initialProjects.push(defaultProject);')).toBeNull();

    fireEvent.click(screen.getByText('Edit'));

    expect(screen.getByText('initialProjects.push(defaultProject);')).toBeDefined();
    expect(screen.getByText('Instruction')).toBeDefined();
    expect(screen.getByText('Update default project registration')).toBeDefined();
    expect(screen.getByText('Successfully replaced content')).toBeDefined();
  });

  it('expands bash terminal console when bash item is clicked', () => {
    render(<StepsDropdown steps={sampleSteps} isWorking={false} />);

    expect(screen.queryByText('Tests passed: 12 suites, 67 tests')).toBeNull();

    fireEvent.click(screen.getByText('Bash'));

    expect(screen.getByText('Tests passed: 12 suites, 67 tests')).toBeDefined();
    expect(screen.getByText('$')).toBeDefined();
  });

  it('expands thought details when thought row is clicked', () => {
    render(<StepsDropdown steps={sampleSteps} isWorking={false} />);

    expect(screen.queryByText(/Checking for new recipes that can be extracted/)).toBeNull();

    fireEvent.click(screen.getByText(/Thought for 3s/));

    expect(screen.getByText(/Checking for new recipes that can be extracted/)).toBeDefined();
  });

  it('filters actions by category pill', () => {
    render(<StepsDropdown steps={sampleSteps} isWorking={false} />);

    expect(screen.getByText('Edits (1)')).toBeDefined();
    expect(screen.getByText('Reads (1)')).toBeDefined();
    expect(screen.getByText('Bash (1)')).toBeDefined();
    expect(screen.getByText('Thoughts (1)')).toBeDefined();

    fireEvent.click(screen.getByText('Edits (1)'));

    expect(screen.getByText('Edit')).toBeDefined();
    expect(screen.queryByText('Bash')).toBeNull();
    expect(screen.queryByText('Read')).toBeNull();

    fireEvent.click(screen.getByText('All (4)'));

    expect(screen.getByText('Edit')).toBeDefined();
    expect(screen.getByText('Bash')).toBeDefined();
    expect(screen.getByText('Read')).toBeDefined();
  });

  it('expands and collapses all visible steps with toggle all button', () => {
    render(<StepsDropdown steps={sampleSteps} isWorking={false} />);

    const toggleBtn = screen.getByText('Expand all');
    fireEvent.click(toggleBtn);

    expect(screen.getByText('initialProjects.push(defaultProject);')).toBeDefined();
    expect(screen.getByText('Tests passed: 12 suites, 67 tests')).toBeDefined();
    expect(screen.getByText(/Checking for new recipes that can be extracted/)).toBeDefined();

    expect(screen.getByText('Collapse all')).toBeDefined();
    fireEvent.click(screen.getByText('Collapse all'));

    expect(screen.queryByText('initialProjects.push(defaultProject);')).toBeNull();
    expect(screen.queryByText('Tests passed: 12 suites, 67 tests')).toBeNull();
  });
});
