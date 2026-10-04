import type { AgentTool } from '@earendil-works/pi-agent-core';
import { automaticCommand } from '../execution/policy.js';

// A presentation template is not a permission boundary. Only host-marked proposals use this allow-list.
const readable = new Set(['read', 'ls', 'find', 'grep', 'web_search', 'web_read', 'play_inspect', 'play_list',
  'task_state', 'artifact_read', 'skill', 'delegate_task', 'report', 'request_capabilities', 'request_escalation']);
export function planningTools(tools: AgentTool[]): AgentTool[] {
  return tools.filter(tool => readable.has(tool.name) || tool.name === 'bash').map(tool => tool.name !== 'bash' ? tool : {
    ...tool,
    description: `${tool.description} Planning allows only fixed git inspection commands: git status --short, git ls-files, git --no-pager log -5 --oneline, git --no-pager diff --no-ext-diff --no-textconv (optionally --stat). Use read, find and grep for file contents.`,
    execute: async (id, args, ...rest) => {
      if (!automaticCommand(String((args as { command?: unknown }).command ?? ''), [])) throw new Error('planning shell refuses this command; use file tools or the fixed git inspection commands');
      return tool.execute(id, args, ...rest);
    },
  });
}
