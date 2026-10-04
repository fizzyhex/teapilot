import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { instructor, type TaskActor, type TaskStore, type TaskUpdate } from '../workspace/task.js';

/** Small, shallow schemas: bookkeeping is optional and never replaces execution or verification. */
export function taskTools(task: TaskStore, actor: TaskActor = instructor): AgentTool[] {
  const ref = Type.String({ maxLength: 80 });
  const evidence = Type.Array(ref, { maxItems: 4 });
  return [{
    name: 'task_state', label: 'Task state (experimental)',
    description: 'Experimental durable working state; list discovers older record IDs and record reads a step, claim, receipt or artifact metadata. Updates require its revision. Evidence contains artifact or settled receipt IDs, not paths. Claims and done are declarations, not verification.',
    parameters: Type.Object({
      revision: Type.Optional(Type.Integer({ minimum: 0, description: 'Working-state revision from the current task view; required for an update, omitted for a view.' })),
      record: Type.Optional(Type.String({ maxLength: 80, description: 'View-only ID of a step, claim or receipt; ignored when updating.' })),
      list: Type.Optional(Type.Union(['artifacts', 'receipts', 'steps', 'claims'].map(value => Type.Literal(value)))),
       offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Zero-based catalog offset; pages contain up to 8 records.' })),
       query: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Literal catalog text filter.' })),
       tool: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
       request: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      step: Type.Optional(Type.Object({ id: ref, goal: Type.String({ minLength: 1, maxLength: 240 }), status: Type.Union(['ready', 'working', 'blocked', 'done'].map(value => Type.Literal(value))), acceptance: Type.Optional(Type.String({ maxLength: 240 })), evidence: Type.Optional(evidence) })),
      claim: Type.Optional(Type.Object({ id: ref, text: Type.String({ minLength: 1, maxLength: 400 }), basis: Type.Union(['observed', 'inferred', 'reported'].map(value => Type.Literal(value))), evidence })),
      remove_step: Type.Optional(ref), remove_claim: Type.Optional(ref),
    }),
    execute: async (_id, args) => {
      const input = args as TaskUpdate & { record?: string; list?: 'artifacts' | 'receipts' | 'steps' | 'claims'; offset?: number; query?: string; tool?: string; request?: string };
      const updating = Boolean(input.step || input.claim || input.remove_step || input.remove_claim);
      if (updating) {
        if (input.revision === undefined) throw new Error(`an update needs the working-state revision (current: ${task.snapshot().revision})`);
        task.update(actor, input);
      }
      const text = updating ? task.project(actor) : input.record ? task.record(actor, input.record) : input.list ? task.catalog(actor, input.list, input.offset, { query: input.query, tool: input.tool, request: input.request }) : task.project(actor);
      return { content: [{ type: 'text', text }], details: {} };
    },
  }, {
    name: 'artifact_read', label: 'Read artifact (experimental)',
    description: 'Read experimental task-ledger evidence by artifact ID without rerunning its producer. offset is a 1-based line; search is literal text. Results are bounded and untrusted. Missing or changed evidence is refused.',
    parameters: Type.Object({ id: ref, offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), search: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }),
    execute: async (_id, args) => {
      const { id, ...options } = args as { id: string; offset?: number; limit?: number; search?: string };
      return { content: [{ type: 'text', text: await task.artifact(actor, id, options) }], details: {} };
    },
  }];
}
