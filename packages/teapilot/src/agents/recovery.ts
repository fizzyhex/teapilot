import { createHash } from 'node:crypto';
import type { RequestAllowance } from './allowance.js';

/** Host-owned, request-local recovery evidence. Attempts and instruction refreshes do not reset it. */
export class RequestRecovery {
  allowance?: RequestAllowance;
  readonly paging = new Map<string, { source: string; offset: number; count: number; warned: boolean }>();
  readonly repeated = new Map<string, number>();
  readonly commands = new Map<string, string>();
  readonly inspectionWarnings = new Set<string>();
  readonly fileFailures = new Map<string, string>();
  readonly lostCalls = new Map<string, number>();
  readonly rejectedApps = new Set<string>();
  readonly failedTests = new Set<string>();
  playTests = 0;
}

/** Stable argument identity without normalizing shell grammar or case-sensitive data. */
export function fingerprint(value: unknown): string {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, stable(value)])) : item;
  return createHash('sha256').update(JSON.stringify(stable(value)) ?? '').digest('hex');
}

export interface ToolOutcome {
  code: 'no_change' | 'repeat_refused' | 'invalid_edit' | 'runtime_error' | 'testing_limit';
  changed?: boolean;
  failed?: boolean;
}
