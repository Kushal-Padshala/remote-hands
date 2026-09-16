import { describe, expectTypeOf, it } from 'vitest';
import type { Database } from './database.generated.js';
import type { Machine } from './machine.js';
import type { Task } from './task.js';
import type { Approval } from './approval.js';

// vitest 5 / expect-type 1.4 deprecated `toMatchTypeOf` in favour of
// `toExtend`, which asserts the same thing: the generated row type must be
// assignable to (extend) the hand-written interface shape.
type Row<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];

describe('hand-written types match the generated schema', () => {
  // `status` comes back as a plain `string` from the generator because it is
  // constrained by a SQL `check`, not an enum type. The hand-written
  // `MachineStatus` union is stricter and more useful, so it is excluded here
  // rather than widened to match the generator.
  it('machines', () => {
    expectTypeOf<Row<'machines'>>().toExtend<Omit<Machine, 'status'>>();
  });

  // `kind`, `mode`, and `status` are all `check`-constrained columns.
  it('tasks', () => {
    expectTypeOf<Row<'tasks'>>().toExtend<Omit<Task, 'kind' | 'mode' | 'status'>>();
  });

  // `action_kind`, `risk`, and `decision` are `check`-constrained columns;
  // `tool_payload` is `jsonb` and comes back as `Json`, narrower than the
  // hand-written `unknown`, so it is excluded too.
  it('approvals', () => {
    expectTypeOf<Row<'approvals'>>().toExtend<
      Omit<Approval, 'action_kind' | 'risk' | 'decision' | 'tool_payload'>
    >();
  });
});
