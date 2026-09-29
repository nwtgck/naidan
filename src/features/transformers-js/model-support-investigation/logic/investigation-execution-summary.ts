import { z } from 'zod';
import type { ModelSupportInvestigationRecovery, ModelSupportInvestigationRun } from '@/features/transformers-js/model-support-investigation/types';

const executionSummarySchema = z.object({
  schemaVersion: z.literal(1),
  state: z.enum(['running', 'completed', 'interrupted', 'unknown']),
  result: z.enum(['passed', 'failed']).optional(),
  completedAt: z.string().optional(),
});

export function investigationExecutionSummary({ run, recovery }: {
  run: ModelSupportInvestigationRun;
  recovery: ModelSupportInvestigationRecovery | undefined;
}): z.infer<typeof executionSummarySchema> {
  // Legacy run.status/completedAt describe the most recent partial boundary.
  // Neither a passed boundary nor a valid ZIP proves the selected run ended.
  // Completion authority is the coordinator's recovery state, never readiness.
  if (recovery === undefined) return executionSummarySchema.parse({ schemaVersion: 1, state: 'unknown' });
  switch (recovery.status) {
  case 'running':
  case 'interrupted': return executionSummarySchema.parse({ schemaVersion: 1, state: recovery.status });
  case 'completed': return executionSummarySchema.parse({
    schemaVersion: 1, state: 'completed', result: run.status, completedAt: recovery.checkpointedAt,
  });
  default: {
    const exhaustive: never = recovery.status;
    throw new Error(`Unhandled execution recovery: ${exhaustive}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
