/** Local cleanup evidence; never a wire error or an application failure code. */
export class RpcRetirementError extends Error {
  constructor({ cause }: { cause: unknown }) {
    super('RPC resource retirement failed', { cause }); this.name = 'RpcRetirementError';
  }
}
/** Commits the first cleanup failure before joining the remaining owners. */
export class RetirementFailures {
  private first: RpcRetirementError | undefined;
  private readonly onFailure: (({ error }: { error: unknown }) => void) | undefined;
  constructor({ onFailure }: { onFailure: (({ error }: { error: unknown }) => void) | undefined }) {
    this.onFailure = onFailure;
  }
  add({ error }: { error: unknown }): void {
    if (this.first) return;
    this.first = error instanceof RpcRetirementError ? error : new RpcRetirementError({ cause: error });
    // A notification is advisory. Its failure cannot skip cleanup or replace
    // the already committed retirement cause.
    try {
      this.onFailure?.({ error: this.first.cause });
    } catch { /* The primary cleanup failure remains authoritative. */ }
  }
  async join({ work }: { work: Promise<void> }): Promise<void> {
    try {
      await work;
    } catch (error) {
      this.add({ error });
    }
  }
  check(): void {
    if (this.first) throw this.first;
  }
}
export type ReaderLease = Pick<ReadableStreamDefaultReader<unknown>, 'closed' | 'cancel' | 'releaseLock'>;
export type WriterLease = Pick<WritableStreamDefaultWriter<unknown>, 'closed' | 'abort' | 'releaseLock' | 'desiredSize'>;

export async function cancelReader({ reader, reason }: { reader: ReaderLease; reason: unknown }): Promise<void> {
  try {
    const terminal = reader.closed; void terminal.catch(() => {});
    const [operation, closed] = await Promise.allSettled([reader.cancel(reason), terminal]);
    // Native cancel on an already-errored readable rejects its stored logical
    // error without invoking the underlying cancel algorithm. A real cancel
    // algorithm failure instead leaves reader.closed fulfilled.
    if (operation.status === 'rejected' && !(closed.status === 'rejected' && Object.is(operation.reason, closed.reason))) {
      throw operation.reason;
    }
  } catch (error) {
    throw new RpcRetirementError({ cause: error });
  }
}
export async function abortWriter({ writer, reason, ownedClose }: { writer: WriterLease; reason: unknown; ownedClose?: Promise<void> }): Promise<void> {
  try {
    // Native desiredSize is null in errored/erroring state. Snapshot BEFORE abort:
    // an initially writable sink may genuinely reject abort with the very same
    // object as its logical abort reason, which must not conceal cleanup failure.
    // An abort-signal listener may also synchronously error an initially writable
    // sink. Public APIs cannot distinguish that case from a failed abort
    // algorithm: conservatively leave retirement unconfirmed on rejection.
    const alreadyErroring = writer.desiredSize === null;
    const terminal = writer.closed; void terminal.catch(() => {});
    // Invoke abort before joining close: the sink may need controller.signal
    // to settle its in-flight close. ownedClose is only valid for this sole
    // writer's own close, with no other pending abort request.
    const [operation, closed, closing] = await Promise.allSettled([writer.abort(reason), terminal, ownedClose]);
    const closeRejectedAbort = operation.status === 'rejected' && closing.status === 'rejected' &&
      Object.is(operation.reason, closing.reason) && !Object.is(closing.reason, reason);
    // A queued (not in-flight) close is rejected with the abort reason; exclude
    // that case so a genuine sink.abort failure cannot be hidden by equality.
    if (!closeRejectedAbort && operation.status === 'rejected' && !(alreadyErroring && closed.status === 'rejected' && Object.is(operation.reason, closed.reason))) {
      throw operation.reason;
    }
  } catch (error) {
    throw new RpcRetirementError({ cause: error });
  }
}
export function releaseLocks({ reader, writer }: { reader: ReaderLease | undefined; writer: WriterLease | undefined }): void {
  const failures: unknown[] = [];
  try {
    reader?.releaseLock();
  } catch (error) {
    failures.push(error);
  }
  try {
    writer?.releaseLock();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new RpcRetirementError({ cause: failures[0] });
}

/** Discard owns only leases it can acquire. Preexisting locks belong to another
 * owner; their provider-native work remains under the borrowed transport.closed
 * barrier. This does not reinterpret a raw stream's logical closed promise. */
export async function retireUnadoptedStreams({ readable, writable, reason, onFailure }: {
  readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; reason: unknown;
  onFailure?: ({ error }: { error: unknown }) => void;
}): Promise<void> {
  let reader: ReaderLease | undefined, writer: WriterLease | undefined;
  const failures = new RetirementFailures({ onFailure });
  try {
    if (!readable.locked) reader = readable.getReader();
  } catch (error) {
    failures.add({ error });
  }
  try {
    if (!writable.locked) writer = writable.getWriter();
  } catch (error) {
    failures.add({ error });
  }
  await Promise.all([
    failures.join({ work: reader ? cancelReader({ reader, reason }) : Promise.resolve() }),
    failures.join({ work: writer ? abortWriter({ writer, reason }) : Promise.resolve() }),
  ]);
  try {
    releaseLocks({ reader, writer });
  } catch (error) {
    failures.add({ error });
  }
  failures.check();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
