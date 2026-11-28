import type {
  ExperimentalImageGenerationActivityJournalDto,
  ExperimentalImageGenerationSessionDto,
} from './00-dto/experimental-image-generation.dto';

// DTO reads deliberately accept future numeric values. Mutating/replaying the
// clock still requires unambiguous, representable ordering; never reset corrupt
// state to zero or rewrite it during a read-only recovery visit.
export function assertActivityOrder({ order }: { order: number }): void {
  if (!Number.isSafeInteger(order) || order < 1 || order > Number.MAX_SAFE_INTEGER - 1) {
    throw new Error('Invalid Image Generation activity order; preserve the store for recovery.');
  }
}

export function assertActivityJournal({ journal }: { journal: ExperimentalImageGenerationActivityJournalDto }): void {
  if (!Number.isSafeInteger(journal.sequence) || journal.sequence < 0 || journal.sequence > Number.MAX_SAFE_INTEGER - 1) {
    throw new Error('Invalid Image Generation activity clock; preserve the store for recovery.');
  }
  const keys = new Set<string>(), orders = new Set<number>();
  for (const entry of journal.pending) {
    assertActivityOrder({ order: entry.order });
    const key = JSON.stringify([entry.sessionId, entry.runId]);
    if (entry.order > journal.sequence || keys.has(key) || orders.has(entry.order)) {
      throw new Error('Ambiguous Image Generation activity reservations; preserve the store for recovery.');
    }
    keys.add(key);
    orders.add(entry.order);
  }
}

export function initializeLegacyActivityJournal({ sessions, warningCount }: {
  sessions: readonly Pick<ExperimentalImageGenerationSessionDto, 'activityOrder'>[],
  warningCount: number,
}): ExperimentalImageGenerationActivityJournalDto {
  // Only a legacy store may start a new clock. Do not quietly restart a clock
  // after its file was deleted from an already ordered workspace.
  if (warningCount || sessions.some(session => session.activityOrder !== undefined)) {
    throw new Error('Image Generation activity clock is missing; preserve the store for recovery.');
  }
  return { version: 1, sequence: 0, pending: [] };
}

export const TEST_ONLY = {
};
