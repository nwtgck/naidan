import type { WorkflowToolExecutionPolicy, WorkflowStep } from '@/01-models/workflow';
import { idToRaw } from '@/01-models/ids';

export function resolveWorkflowToolPolicy({ policy }: { policy: WorkflowToolExecutionPolicy | undefined }): WorkflowToolExecutionPolicy {
  const value = policy ?? { maxRounds: 8, maxCalls: 32, shell: undefined };
  if (!Number.isSafeInteger(value.maxRounds) || value.maxRounds < 1 || value.maxRounds > 64
    || !Number.isSafeInteger(value.maxCalls) || value.maxCalls < 1 || value.maxCalls > 256) {
    throw new Error('Tool limits require 1–64 generation rounds and 1–256 tool calls.');
  }
  if (value.shell && (!idToRaw({ id: value.shell.volumeId }).trim() || !['read-only', 'read-write'].includes(value.shell.access))) {
    throw new Error('Select a shell folder and its access mode.');
  }
  return structuredClone(value);
}


export function workflowToolConfigurationIssues({ step }: { step: Extract<WorkflowStep, { type: 'text_generation' }> }): { path: string, message: string }[] {
  const issues: { path: string, message: string }[] = [];
  try {
    resolveWorkflowToolPolicy({ policy: step.toolExecution });
  } catch (error) {
    issues.push({ path: 'toolExecution', message: error instanceof Error ? error.message : String(error) });
  }
  const seen = new Set<string>();
  for (const tool of step.toolConfigs) {
    if (seen.has(tool.key)) {
      issues.push({ path: 'toolConfigs', message: 'Duplicate tool configuration.' });
    }
    seen.add(tool.key);
    if (tool.key === 'builtin.wesh' && tool.status === 'enabled' && (tool.naidanSysfs.accessScope !== 'none' || !step.toolExecution?.shell)) {
      issues.push({ path: 'toolExecution.shell', message: 'Choose one shell folder; Workflow tools cannot access chat/sysfs mounts.' });
    }
  }
  return issues;
}

export const TEST_ONLY = {
};
