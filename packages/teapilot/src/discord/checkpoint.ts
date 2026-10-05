import type { CheckpointDecision } from '../agents/checkpoint.js';

/**
 * A checkpoint on Discord: a short card that continues by itself, with steer (a form), stop and private details.
 * The gateway and the simulated Discord both build it from here, so the simulator shows what Discord would.
 */
export const checkpointPrefix = 'teapilot-checkpoint:';
export const checkpointModalPrefix = 'teapilot-checkpoint-modal:';
export type CheckpointButton = 'continue' | 'steer' | 'stop' | 'details';

/** Buttons as Discord's raw component JSON: success, primary, danger, secondary. */
export function checkpointRow(nonce: string) {
  const button = (action: CheckpointButton, style: number) => ({ type: 2, style, label: action, custom_id: `${checkpointPrefix}${nonce}:${action}` });
  return { type: 1, components: [button('continue', 3), button('steer', 1), button('stop', 4), button('details', 2)] };
}

export function checkpointModal(nonce: string) {
  return { custom_id: `${checkpointModalPrefix}${nonce}`, title: 'steer teapilot', components: [{ type: 1, components: [
    { type: 4, custom_id: 'steer', label: 'what should change from here?', style: 2, required: true, max_length: 2000 }] }] };
}

export const checkpointWaiting = (text: string, timeoutMs: number) => `${text}\n-# continuing in ${Math.round(timeoutMs / 1000)}s unless you steer or stop`;

const verdicts = { continue: 'continued', steer: 'steered', stop: 'stopped and parked' } as const;
export function checkpointVerdict(decision: CheckpointDecision, actor?: string): string {
  return `-# ${verdicts[decision.action]}${actor ? ` by <@${actor}>` : ''}${decision.action === 'steer' ? `: ${decision.text.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`;
}

/** Details are private and stay inside one message. */
export const checkpointDetailsText = (details: string, limit: number) => `\`\`\`\n${details.slice(0, limit - 8)}\n\`\`\``;

/** How long a card waits before the work continues by itself. */
export const checkpointWaitMs = 200_000;

/** Writing a direction takes longer than the card waits: steering holds it, though never for more than this. */
export const steerHoldMs = 5 * 60_000;
