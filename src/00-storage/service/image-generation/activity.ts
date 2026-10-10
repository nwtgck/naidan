import {
  ExperimentalImageGenerationActivityJournalSchemaDto,
  type ExperimentalImageGenerationActivityJournalDto,
  type ExperimentalImageGenerationSessionDto,
} from '@/00-storage/00-dto/experimental-image-generation.dto';
import type { ImageGenerationReadWarning } from '@/01-models/image-generation';
import { assertImageGenerationReplacement } from './context';
import { readImageGenerationText, writeImageGenerationText } from './files';
import { imageGenerationRunTable, imageGenerationSessionDirectory, imageGenerationSessionTable } from './tables';

const journalName = 'session-activity.json';
type PendingActivity = ExperimentalImageGenerationActivityJournalDto['pending'][number];

// DTO reads deliberately accept future numeric values. Mutating/replaying the
// clock still requires unambiguous, representable ordering; never reset corrupt
// state to zero or rewrite it during a read-only recovery visit.
function assertActivityOrder({ order }: { order: number }): void {
  if (!Number.isSafeInteger(order) || order < 1 || order > Number.MAX_SAFE_INTEGER - 1) {
    throw new Error('Invalid Image Generation activity order; preserve the store for recovery.');
  }
}

function assertActivityJournal({ journal }: { journal: ExperimentalImageGenerationActivityJournalDto }): void {
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
    keys.add(key); orders.add(entry.order);
  }
}


/** Storage-local: every operation runs under the existing image store lock.
 * Reserve before publishing a run, then replay only after its canonical record
 * exists. Gaps are harmless; a lost acknowledgement must never allocate twice. */
export async function readImageGenerationActivity({ directory }: { directory: FileSystemDirectoryHandle }): Promise<ExperimentalImageGenerationActivityJournalDto> {
  const text = await readImageGenerationText({ directory, name: journalName });
  if (text !== undefined) return ExperimentalImageGenerationActivityJournalSchemaDto.parse(JSON.parse(text));
  // Only a legacy store may start a new clock. Do not quietly restart a clock
  // after its file was deleted from an already ordered workspace.
  const sessions = await (await imageGenerationSessionTable({ directory, create: false })).list();
  if (sessions.warningCount || sessions.items.some(session => session.activityOrder !== undefined)) throw new Error('Image Generation activity clock is missing; preserve the store for recovery.');
  return { version: 1, sequence: 0, pending: [] };
}

async function writeActivity({ directory, journal }: { directory: FileSystemDirectoryHandle, journal: ExperimentalImageGenerationActivityJournalDto }): Promise<void> {
  assertActivityJournal({ journal });
  const value = ExperimentalImageGenerationActivityJournalSchemaDto.parse(journal);
  await writeImageGenerationText({ directory, name: journalName, text: JSON.stringify(value) });
}

export async function reserveImageGenerationActivity({ directory, run }: {
  directory: FileSystemDirectoryHandle, run: { sessionId: string, runId: string } | undefined,
}): Promise<number> {
  const current = await readImageGenerationActivity({ directory });
  assertActivityJournal({ journal: current });
  const previous = run && current.pending.find(entry => entry.sessionId === run.sessionId && entry.runId === run.runId);
  if (previous) return previous.order;
  const order = current.sequence + 1;
  assertActivityOrder({ order });
  await writeActivity({ directory, journal: { ...current, sequence: order, pending: run ? [...current.pending, { ...run, order }] : current.pending } });
  return order;
}

export async function finishImageGenerationActivity({ directory, sessionId, runId }: {
  directory: FileSystemDirectoryHandle, sessionId: string, runId: string,
}): Promise<void> {
  const current = await readImageGenerationActivity({ directory });
  assertActivityJournal({ journal: current });
  const pending = current.pending.filter(entry => entry.sessionId !== sessionId || entry.runId !== runId);
  if (pending.length !== current.pending.length) await writeActivity({ directory, journal: { ...current, pending } });
}

export async function applyImageGenerationActivity({ directory, sessionId, runId }: {
  directory: FileSystemDirectoryHandle, sessionId: string, runId: string,
}): Promise<ExperimentalImageGenerationSessionDto | undefined> {
  const table = await imageGenerationSessionTable({ directory, create: false });
  const current = await table.load({ id: sessionId });
  if (!current || current.state === 'deleted' || current.state === 'deleting') {
    await finishImageGenerationActivity({ directory, sessionId, runId });
    return undefined;
  }
  const location = await imageGenerationSessionDirectory({ directory, sessionId });
  if (!location) return undefined;
  const run = await (await imageGenerationRunTable({ directory: location, sessionId, create: false })).load({ id: runId });
  // The store lock proves no publisher is still between reservation and record.
  // Missing records are unaccepted attempts, not an excuse to reorder a session.
  // Retrying such an attempt later may reserve a new order.
  if (!run) {
    await finishImageGenerationActivity({ directory, sessionId, runId });
    return undefined;
  }
  const journal = await readImageGenerationActivity({ directory });
  assertActivityJournal({ journal });
  if (current.activityOrder !== undefined) {
    assertActivityOrder({ order: current.activityOrder });
    if (current.activityOrder > journal.sequence) throw new Error('Image Generation session order exceeds its clock.');
  }
  if (run.acceptedOrder !== undefined) assertActivityOrder({ order: run.acceptedOrder });
  if (run.acceptedOrder !== undefined && run.acceptedOrder > journal.sequence) throw new Error('Image Generation activity order exceeds its clock.');
  const reservation = journal.pending.find(entry => entry.sessionId === sessionId && entry.runId === runId);
  if (reservation && reservation.order !== run.acceptedOrder) throw new Error('Image Generation activity reservation does not match its run.');
  const activityOrder = run.acceptedOrder === undefined ? current.activityOrder : Math.max(current.activityOrder ?? 0, run.acceptedOrder);
  const shouldApply = run.acceptedOrder === undefined
    ? current.activityOrder === undefined && current.updatedAt < run.createdAt
    : activityOrder !== current.activityOrder;
  let next = current;
  if (shouldApply) {
    next = { ...current, activityOrder, revision: current.revision + 1, updatedAt: Math.max(current.updatedAt, run.createdAt) };
    await table.write({ record: next, assertCurrent: ({ current: latest }) => assertImageGenerationReplacement({ current: latest, next, expectedRevision: current.revision }), async beforeCommit() {} });
  }
  await finishImageGenerationActivity({ directory, sessionId, runId });
  return next;
}

/** A published run itself proves acceptance. Recovery never invokes inference,
 * depends on in-memory retry objects, or uses a new wall-clock timestamp. */
export async function recoverImageGenerationActivities({ directory }: { directory: FileSystemDirectoryHandle }): Promise<{ warnings: ImageGenerationReadWarning[], warningCount: number }> {
  const warnings: ImageGenerationReadWarning[] = [];
  let warningCount = 0;
  function warn({ path, error }: { path: string, error: unknown }): void {
    warningCount++;
    if (warnings.length < 100) warnings.push({ path, message: (error instanceof Error ? error.message : String(error)).slice(0, 1024) });
  }
  let pending: PendingActivity[];
  try {
    // Do not create a journal during an ordinary read-only legacy visit.
    const text = await readImageGenerationText({ directory, name: journalName });
    if (text === undefined) return { warnings, warningCount };
    const journal = ExperimentalImageGenerationActivityJournalSchemaDto.parse(JSON.parse(text));
    assertActivityJournal({ journal });
    pending = journal.pending;
  } catch (error) {
    warn({ path: journalName, error }); return { warnings, warningCount };
  }
  for (const entry of pending) {
    try {
      await applyImageGenerationActivity({ directory, sessionId: entry.sessionId, runId: entry.runId });
    } catch (error) {
      warn({ path: `${journalName}/${entry.sessionId}/${entry.runId}`, error });
    }
  }
  return { warnings, warningCount };
}

export const TEST_ONLY = {
};
