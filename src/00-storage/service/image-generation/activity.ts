import { assertActivityOrder } from '@/00-format/image-generation-activity';
import { idToRaw, type ImageGenerationRunId, type ImageGenerationSessionId } from '@/01-models/ids';
import { opfsFormat } from '@/00-format/01-layout/layout';
import { imageGenerationOperationTable } from './operations';
import type { ImageGenerationActivityJournal } from '@/00-format/image-generation-workspace';
import type { ImageGenerationReadWarning, ImageGenerationSession } from '@/01-models/image-generation';
import { assertImageGenerationReplacement, imageGenerationRootIo } from './context';
import { imageGenerationRunTable, imageGenerationSessionDirectory, imageGenerationSessionTable } from './tables';

type PendingActivity = ImageGenerationActivityJournal['pending'][number];

/** Storage-local: every operation runs under the existing image store lock.
 * Reserve before publishing a run, then replay only after its canonical record
 * exists. Gaps are harmless; a lost acknowledgement must never allocate twice. */
export async function readImageGenerationActivity({ directory }: { directory: FileSystemDirectoryHandle }): Promise<ImageGenerationActivityJournal> {
  const journal = await opfsFormat.storage.experimental.imageGeneration.activity.read({ io: imageGenerationRootIo({ directory }) });
  if (journal !== undefined) {
    return journal;
  }
  const sessions = await (await imageGenerationSessionTable({ directory, create: false })).list();
  return opfsFormat.storage.experimental.imageGeneration.activity.initializeLegacy({ sessions: sessions.items, warningCount: sessions.warningCount });
}

async function writeActivity({ directory, journal }: { directory: FileSystemDirectoryHandle, journal: ImageGenerationActivityJournal }): Promise<void> {
  await opfsFormat.storage.experimental.imageGeneration.activity.write({ io: imageGenerationRootIo({ directory }), journal });
}

export async function reserveImageGenerationActivity({ directory, run }: {
  directory: FileSystemDirectoryHandle, run: { sessionId: ImageGenerationSessionId, runId: ImageGenerationRunId } | undefined,
}): Promise<number> {
  const current = await readImageGenerationActivity({ directory });
  const previous = run && current.pending.find(entry => entry.sessionId === run.sessionId && entry.runId === run.runId);
  if (previous) {
    return previous.order;
  }
  const order = current.sequence + 1;
  assertActivityOrder({ order });
  await writeActivity({ directory, journal: { ...current, sequence: order, pending: run ? [...current.pending, { ...run, order }] : current.pending } });
  return order;
}

export async function finishImageGenerationActivity({ directory, sessionId, runId }: {
  directory: FileSystemDirectoryHandle, sessionId: ImageGenerationSessionId, runId: ImageGenerationRunId,
}): Promise<void> {
  const current = await readImageGenerationActivity({ directory });
  const pending = current.pending.filter(entry => entry.sessionId !== sessionId || entry.runId !== runId);
  if (pending.length !== current.pending.length) {
    await writeActivity({ directory, journal: { ...current, pending } });
  }
}

export async function applyImageGenerationActivity({ directory, sessionId, runId }: {
  directory: FileSystemDirectoryHandle, sessionId: ImageGenerationSessionId, runId: ImageGenerationRunId,
}): Promise<ImageGenerationSession | undefined> {
  const table = await imageGenerationSessionTable({ directory, create: false });
  const original = await table.read({ id: sessionId });
  const current = original?.value;
  if (!original || !current || current.state === 'deleted' || current.state === 'deleting') {
    await finishImageGenerationActivity({ directory, sessionId, runId });
    return undefined;
  }
  const location = await imageGenerationSessionDirectory({ directory, sessionId });
  if (!location) {
    return undefined;
  }
  const run = await (await imageGenerationRunTable({ directory: location, sessionId, create: false })).load({ id: runId });
  // The store lock proves no publisher is still between reservation and record.
  // Missing records are unaccepted attempts, not an excuse to reorder a session.
  // Retrying such an attempt later may reserve a new order.
  if (!run) {
    await finishImageGenerationActivity({ directory, sessionId, runId });
    return undefined;
  }
  if (run.operationId !== undefined) {
    const operation = await (await imageGenerationOperationTable({ directory: location, sessionId, create: false })).load({ id: run.operationId });
    if (!operation || !operation.runIds.includes(runId)) {
      // Staged child records do not prove acceptance. Keep the reservation for
      // the parent's idempotent retry, without reordering an unrelated session.
      return undefined;
    }
  }
  const journal = await readImageGenerationActivity({ directory });
  if (current.activityOrder !== undefined) {
    assertActivityOrder({ order: current.activityOrder });
    if (current.activityOrder > journal.sequence) {
      throw new Error('Image Generation session order exceeds its clock.');
    }
  }
  if (run.acceptedOrder !== undefined) {
    assertActivityOrder({ order: run.acceptedOrder });
  }
  if (run.acceptedOrder !== undefined && run.acceptedOrder > journal.sequence) {
    throw new Error('Image Generation activity order exceeds its clock.');
  }
  const reservation = journal.pending.find(entry => entry.sessionId === sessionId && entry.runId === runId);
  if (reservation && reservation.order !== run.acceptedOrder) {
    throw new Error('Image Generation activity reservation does not match its run.');
  }
  const activityOrder = run.acceptedOrder === undefined ? current.activityOrder : Math.max(current.activityOrder ?? 0, run.acceptedOrder);
  const shouldApply = run.acceptedOrder === undefined
    ? current.activityOrder === undefined && current.updatedAt < run.createdAt
    : activityOrder !== current.activityOrder;
  if (!shouldApply) {
    await finishImageGenerationActivity({ directory, sessionId, runId });
    return current;
  }
  const prepared = original.prepareChanges({ changes: { activityOrder, revision: current.revision + 1, updatedAt: Math.max(current.updatedAt, run.createdAt) } });
  await prepared.write({ assertCurrent: ({ current: latest, next }) => assertImageGenerationReplacement({ current: latest, next, expectedRevision: current.revision }), async beforeCommit() {} });
  await finishImageGenerationActivity({ directory, sessionId, runId });
  return prepared.snapshot.value;
}

/** A published run itself proves acceptance. Recovery never invokes inference,
 * depends on in-memory retry objects, or uses a new wall-clock timestamp. */
export async function recoverImageGenerationActivities({ directory }: { directory: FileSystemDirectoryHandle }): Promise<{ warnings: ImageGenerationReadWarning[], warningCount: number }> {
  const warnings: ImageGenerationReadWarning[] = [];
  let warningCount = 0;
  function warn({ path, error }: { path: string, error: unknown }): void {
    warningCount++;
    if (warnings.length < 100) {
      warnings.push({ path, message: (error instanceof Error ? error.message : String(error)).slice(0, 1024) });
    }
  }
  let pending: PendingActivity[];
  try {
    // Do not create a journal during an ordinary read-only legacy visit.
    const journal = await opfsFormat.storage.experimental.imageGeneration.activity.read({ io: imageGenerationRootIo({ directory }) });
    if (journal === undefined) {
      return { warnings, warningCount };
    }
    pending = journal.pending;
  } catch (error) {
    warn({ path: opfsFormat.storage.experimental.imageGeneration.activity.name, error });
    return { warnings, warningCount };
  }
  for (const entry of pending) {
    try {
      await applyImageGenerationActivity({ directory, sessionId: entry.sessionId, runId: entry.runId });
    } catch (error) {
      warn({ path: `${opfsFormat.storage.experimental.imageGeneration.activity.name}/${idToRaw({ id: entry.sessionId })}/${idToRaw({ id: entry.runId })}`, error });
    }
  }
  return { warnings, warningCount };
}

export const TEST_ONLY = {
};
