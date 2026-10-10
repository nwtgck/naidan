import { NaidanRpcByteBudget, type RpcByteOwner } from './byte-budget';
import { cancelReader, releaseLocks, RpcRetirementError } from '@/features/naidan-rpc/stream-retirement';
import { decode, encode } from '@/features/naidan-rpc/codec';
import type { Reference, WireValue } from '@/features/naidan-rpc/codec';
import { FramedDuplex, wireValue } from '@/features/naidan-rpc/framing';
import type { Frame } from '@/features/naidan-rpc/framing';
import { compile, pack, project, references, isStream, returnedStreams } from '@/features/naidan-rpc/schema';
import type { Capability, Packed, Plan, Source } from '@/features/naidan-rpc/schema';
import { CALLBACK_LIMIT, check, deferred, duration, BYTE_PULL_BYTES, ITEM_FRAGMENT_BYTES, VALUE_BYTES, NaidanRpcError, NaidanRpcPublicError, NaidanRpcProtocolError } from '@/features/naidan-rpc/primitives';
import type { NaidanRpcErrorCode } from '@/features/naidan-rpc/primitives';
import type { PreparedMethod } from '@/features/naidan-rpc/contract';
import type { NaidanRpcDuplex } from '@/features/naidan-rpc/transport';
import { ByteAssembly } from '@/features/naidan-rpc/assembly';

type Scope = 'input' | 'result';
const BYTE_SEGMENT = BYTE_PULL_BYTES;
type Phase = 'offered' | 'accepted' | 'pulling' | 'stopping' | 'terminal';
type Exported = Source & { memory: RpcByteOwner; scope: Scope; phase: Phase; sequence: number; reader: ReadableStreamDefaultReader<unknown> | undefined;
  pendingBytes: Uint8Array | undefined; offset: number; sending: Promise<void> | undefined; stopRequested: boolean };
type Imported = { scope: Scope; capability: Capability; phase: Phase; sequence: number;
  controller: ReadableStreamDefaultController<unknown> | undefined; granted: boolean; pending: ReturnType<typeof deferred<void>> | undefined;
  fragment: { bytes: ByteAssembly | undefined; total: number; offset: number } | undefined };
type PendingCallback = { memory: RpcByteOwner; result: ReturnType<typeof deferred<unknown>>; plan: Plan };
export type Observer = ({ value }: { value: unknown }) => void | Promise<void>;

/** One lower duplex owns one root call, its stream references and its reverse invocations. */
export class RpcConversation {
  private readonly memory: RpcByteOwner;
  private readonly values: RpcByteOwner;
  private dispatchMemory: RpcByteOwner | undefined;
  readonly result = deferred<unknown>();
  readonly closed = deferred<void>();
  readonly retired = deferred<void>();
  private readonly channel: FramedDuplex;
  private readonly duplex: NaidanRpcDuplex;
  private readonly role: 'caller' | 'callee';
  private readonly resolveMethod: ({ contract, method }: { contract: string; method: string }) => PreparedMethod;
  private readonly controller = new AbortController();
  private readonly maxTimeoutMs: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadlineAt: number;
  private method: PreparedMethod | undefined;
  private incomingMethod: { contract: string; method: string } | undefined;
  private observers: Readonly<Record<string, Observer | undefined>> = {};
  private nextReference: number;
  private nextInvocation = 1;
  private lastInvocation = 0;
  private readonly exports = new Map<number, Exported>();
  private readonly imports = new Map<number, Imported>();
  private partialBytes = 0;
  private readonly invocations = new Map<number, PendingCallback>();
  private readonly notices = new Map<string, { value: WireValue; memory: RpcByteOwner }>();
  private readonly observed = new Map<string, { running: boolean; latest: WireValue | undefined; present: boolean; memory: RpcByteOwner | undefined }>();
  private noticeSending = false;
  private inputOffered = false;
  private inputAccepted = false;
  private opened = false;
  private resultOffered = false;
  private resultAccepted = false;
  private resultReceived = false;
  private handlerReturned = false;
  private finishSent: 'success' | 'error' | undefined;
  private finishReceived: 'success' | 'error' | undefined;
  private acknowledged = false;
  private wireEnded = false;
  private failure: NaidanRpcError | undefined;
  private retirementFailure: { error: unknown } | undefined;
  private jobs = 0;
  private callbacksRunning = 0;
  private finishing = false;
  private readRetired = false;
  private readonly reading: Promise<void>;
  private networkRetirement: Promise<void> | undefined;

  private readonly onRetirementFailure: ({ error }: { error: unknown }) => void;

  constructor({ duplex, role, timeoutMs, resolveMethod, onRetirementFailure, onProtocolFailure, memory }: {
    memory?: RpcByteOwner;
    onRetirementFailure: ({ error }: { error: unknown }) => void;
    onProtocolFailure: ({ error }: { error: NaidanRpcProtocolError }) => void;
    duplex: NaidanRpcDuplex; role: 'caller' | 'callee'; timeoutMs: number | undefined;
    resolveMethod: ({ contract, method }: { contract: string; method: string }) => PreparedMethod;
  }) {
    if (timeoutMs !== undefined) duration({ milliseconds: timeoutMs });
    this.memory = memory ?? new NaidanRpcByteBudget().owner(); this.values = this.memory.fork();
    this.onRetirementFailure = onRetirementFailure;
    this.duplex = duplex; this.role = role; this.resolveMethod = resolveMethod; this.maxTimeoutMs = timeoutMs;
    this.nextReference = isCaller({ role }) ? 1 : 2;
    this.channel = new FramedDuplex({
      duplex,
      memory: this.memory,
      onProtocolFailure: ({ error }) => {
        if (this.wireEnded) return;
        this.failure ??= error;
        onProtocolFailure({ error }); this.abort({ code: 'PROTOCOL_ERROR' });
      },
      onRetirementFailure: ({ error }) => this.recordRetirementFailure({ error }),
    });
    this.deadlineAt = performance.now() + (timeoutMs ?? Infinity);
    this.timer = timeoutMs === undefined ? undefined : setTimeout(() => this.abort({ code: 'DEADLINE_EXCEEDED' }), timeoutMs);
    void this.channel.preambleSent.catch(cause => {
      this.failure ??= new NaidanRpcError({ code: 'TRANSPORT_ERROR', cause }); this.abort({ code: 'TRANSPORT_ERROR' });
    });
    void duplex.closed.catch(() => this.abort({ code: 'TRANSPORT_ERROR' }));
    // The read loop is separate from cleanup jobs: cleanup may unblock it but
    // must never await itself through the conversation retirement barrier.
    this.reading = this.read().finally(() => {
      this.readRetired = true; this.maybeRetire();
    });
  }

  /** Stop protocol I/O, independently of user handlers and source cleanup.
   * Full retired still owns those jobs and their shared reservations. */
  retireNetwork(): Promise<void> {
    if (this.networkRetirement) return this.networkRetirement;
    this.abort({ code: 'CANCELLED' });
    const closing = this.failure ? this.channel.stop({ error: this.failure }) : this.channel.retire();
    this.networkRetirement = Promise.all([this.reading, closing]).then(() => {});
    void this.networkRetirement.catch(() => {}); return this.networkRetirement;
  }

  private active(): boolean {
    return !this.failure && !this.finishSent && !this.finishReceived && !this.wireEnded;
  }

  private allocate(): number {
    const id = this.nextReference; this.nextReference += 2;
    check({ condition: id <= 65535, code: 'RESOURCE_EXHAUSTED' }); return id;
  }

  private send({ frame }: { frame: Frame }): Promise<void> {
    let pending: Promise<void>;
    try {
      pending = this.channel.send({ frame });
    } catch (error) {
      pending = Promise.reject(error);
    }
    // Queue/encoding failures follow the same owned asynchronous path as transport failures.
    void pending.catch(error => {
      if (error instanceof NaidanRpcPublicError) this.failure ??= error;
      this.abort({ code: error instanceof NaidanRpcError ? error.code : 'TRANSPORT_ERROR' });
    });
    return pending;
  }

  private task({ run, retirement = false, memory }: { run: () => Promise<void>; retirement?: boolean; memory?: RpcByteOwner }): void {
    this.jobs++;
    void Promise.resolve().then(run).catch(error => {
      if (retirement && error instanceof RpcRetirementError) {
        this.recordRetirementFailure({ error: error.cause });
      } else if (this.active()) this.reject({ error: error instanceof NaidanRpcError ? error : new NaidanRpcError({ code: 'HANDLER_FAILED' }) });
    }).finally(() => {
      memory?.clear(); this.jobs--; this.maybeFinish(); this.maybeRetire();
    });
  }

  private recordRetirementFailure({ error }: { error: unknown }): void {
    if (this.retirementFailure) return;
    this.retirementFailure = { error };
    try {
      this.onRetirementFailure({ error });
    } catch { /* Keep the first cleanup cause and continue joining. */ }
    this.abort({ code: 'TRANSPORT_ERROR' });
  }

  private maybeRetire(): void {
    if (!this.wireEnded || !this.readRetired || this.jobs !== 0) return;
    this.exports.clear(); this.imports.clear(); this.partialBytes = 0; this.clearNotices(); this.observed.clear(); this.method = undefined; this.observers = {};
    if (this.retirementFailure) this.retired.reject(this.retirementFailure.error); else {
      this.memory.clear(); this.retired.resolve();
    }
  }

  private register({ packed, scope }: { packed: Packed; scope: Scope }): void {
    for (const [id, source] of packed.sources) {
      check({ condition: !this.exports.has(id) && this.exports.size < 16, code: 'RESOURCE_EXHAUSTED' });
      this.exports.set(id, { ...source, memory: this.memory.fork(), scope, phase: 'offered', sequence: 0, reader: undefined, pendingBytes: undefined, offset: 0, sending: undefined, stopRequested: false });
    }
  }

  start({ contract, method, prepared, packed, on, timeoutMs }: {
    contract: string; method: string; prepared: PreparedMethod; packed: Packed;
    on: Readonly<Record<string, Observer | undefined>>; timeoutMs: number | undefined;
  }): void {
    check({ condition: isCaller({ role: this.role }) && !this.inputOffered, code: 'PROTOCOL_ERROR' });
    this.method = prepared; this.observers = { ...on };
    try {
      this.register({ packed, scope: 'input' }); this.inputOffered = true;
      void this.send({ frame: { type: 'open', contract, method, timeoutMs, value: packed.value } });
    } catch {
      this.abort({ code: 'INVALID_ARGUMENT' });
    }
  }

  private proxy({ reference, capability, scope }: { reference: Reference; capability: Capability; scope: Scope }): unknown {
    const state: Imported = { scope, capability, phase: 'offered', sequence: 0, controller: undefined, granted: false, pending: undefined, fragment: undefined };
    this.imports.set(reference.id, state);
    switch (capability.kind) {
    case 'stream': return new ReadableStream<unknown>({
      start: controller => {
        state.controller = controller;
      },
      pull: async () => {
        check({ condition: this.active() && state.phase === 'accepted', code: 'CANCELLED' });
        state.phase = 'pulling'; state.granted = true; state.sequence++;
        check({ condition: state.sequence <= 0xffffffff, code: 'RESOURCE_EXHAUSTED' });
        const waiting = deferred<void>(); state.pending = waiting;
        await this.send({ frame: { type: 'pull', id: reference.id, sequence: state.sequence } });
        await waiting.promise;
      },
      cancel: () => this.stopImport({ id: reference.id }),
    }, { highWaterMark: 0 });
    case 'callback': {
      const inputPlan = compile({ schema: capability.input, capabilitiesAllowed: false, callbacksAllowed: false });
      const resultPlan = compile({ schema: capability.result, capabilitiesAllowed: false, callbacksAllowed: false });
      // This positional shape is the function's schema-defined argument, not an internal helper signature.
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Preserve the single schema-defined callback value, including scalars, and validate accessors before invoking user code.
      return async (input: unknown): Promise<unknown> => {
        check({ condition: this.active() && state.phase === 'accepted', code: 'CANCELLED' });
        check({ condition: this.invocations.size < CALLBACK_LIMIT && this.nextInvocation <= 1024, code: 'RESOURCE_EXHAUSTED' });
        const memory = this.memory.fork();
        const invocation = this.nextInvocation++, result = deferred<unknown>();
        try {
          const packed = pack({
            memory,
            plan: inputPlan,
            value: input,
            allocate: () => {
              throw new Error('Finite callback input required');
            },
          });
          this.invocations.set(invocation, { result, plan: resultPlan, memory });
          await this.send({ frame: { type: 'invoke', id: reference.id, invocation, value: packed.value } }); return await result.promise;
        } finally {
          this.invocations.delete(invocation); memory.clear(); this.maybeFinish();
        }
      };
    }
    default: { const unreachable: never = capability; throw new Error(String(unreachable)); }
    }
  }

  private receiveValue({ plan, value, scope }: { plan: Plan; value: WireValue; scope: Scope }): unknown {
    const offered = references({ value });
    for (const [id] of offered) {
      check({ condition: id % 2 === (isCaller({ role: this.role }) ? 0 : 1) && !this.imports.has(id), code: 'PROTOCOL_ERROR' });
    }
    const projected = project({ plan, value, memory: this.values, proxy: ({ reference, capability }) => this.proxy({ reference, capability, scope }) });
    for (const id of projected.accepted) {
      check({ condition: offered.has(id), code: 'PROTOCOL_ERROR' });
      const state = this.imports.get(id); if (!state) throw new Error('Missing projected reference'); state.phase = 'accepted';
    }
    // A complete accepted subset also answers all declined references. No source is read before this.
    void this.send({ frame: { type: 'accept', scope, ids: [...projected.accepted] } });
    return projected.value;
  }

  private accept({ scope, ids }: { scope: Scope; ids: number[] }): void {
    switch (scope) {
    case 'input': check({ condition: isCaller({ role: this.role }) && this.inputOffered && !this.inputAccepted, code: 'PROTOCOL_ERROR' }); this.inputAccepted = true; break;
    case 'result': check({ condition: !isCaller({ role: this.role }) && this.resultOffered && !this.resultAccepted, code: 'PROTOCOL_ERROR' }); this.resultAccepted = true; break;
    default: { const unreachable: never = scope; throw new Error(String(unreachable)); }
    }
    const accepted = new Set(ids);
    check({ condition: accepted.size === ids.length, code: 'PROTOCOL_ERROR' });
    for (const id of ids) check({ condition: this.exports.get(id)?.scope === scope, code: 'PROTOCOL_ERROR' });
    for (const [id, state] of this.exports) if (state.scope === scope) {
      check({ condition: state.phase === 'offered', code: 'PROTOCOL_ERROR' });
      if (accepted.has(id)) state.phase = 'accepted';
      else this.stopExport({ id, acknowledge: false });
    }
    this.maybeFinish();
  }

  private stopExport({ id, acknowledge }: { id: number; acknowledge: boolean }): void {
    const state = this.exports.get(id); if (!state) throw new Error('Unknown exported stream');
    check({ condition: isStream(state.capability) || !acknowledge, code: 'PROTOCOL_ERROR' });
    if (acknowledge) {
      check({ condition: !state.stopRequested && state.phase !== 'offered', code: 'PROTOCOL_ERROR' });
      state.stopRequested = true;
    }
    if (phaseIs({ phase: state.phase, expected: 'terminal' })) {
      if (acknowledge) void this.send({ frame: { type: 'stopped', id } }); return;
    }
    state.phase = 'stopping'; state.pendingBytes = undefined;
    const sending = state.sending;
    this.task({
      retirement: true,
      run: async () => {
        const failures: unknown[] = [];
        try {
          if (isStream(state.capability)) {
            state.reader ??= (state.value as ReadableStream<unknown>).getReader();
            await cancelReader({ reader: state.reader, reason: this.failure });
          }
        } catch (error) {
          failures.push(error); this.recordRetirementFailure({ error: error instanceof RpcRetirementError ? error.cause : error });
        }
        // A STOP acknowledgement cannot overtake a fragment already queued.
        await sending?.catch(() => {});
        try {
          releaseLocks({ reader: state.reader, writer: undefined });
        } catch (error) {
          failures.push(error);
        }
        state.phase = 'terminal';
        if (failures.length) {
          const first = failures[0];
          throw first instanceof RpcRetirementError ? first : new RpcRetirementError({ cause: first });
        }
        state.memory.clear();
        // Sending an acknowledgement is ordinary wire work, not source cleanup.
        if (acknowledge && this.active()) void this.send({ frame: { type: 'stopped', id } });
      },
    });
  }

  private stopImport({ id }: { id: number }): Promise<void> {
    const state = this.imports.get(id); if (!state || phaseIs({ phase: state.phase, expected: 'terminal' })) return Promise.resolve();
    if (phaseIs({ phase: state.phase, expected: 'stopping' })) return state.pending?.promise ?? Promise.resolve();
    check({ condition: isStream(state.capability), code: 'PROTOCOL_ERROR' });
    state.phase = 'stopping'; state.pending?.resolve();
    if (state.fragment?.bytes) {
      this.partialBytes -= state.fragment.bytes.byteLength; state.fragment.bytes.dispose(); state.fragment.bytes = undefined;
    }
    const completion = deferred<void>(); state.pending = completion;
    if (this.active()) void this.send({ frame: { type: 'stop', id } }); else completion.reject(this.failure);
    return completion.promise;
  }

  private pullExport({ id, sequence }: { id: number; sequence: number }): void {
    const state = this.exports.get(id);
    check({ condition: state?.phase === 'accepted' && isStream(state.capability) && sequence === state.sequence + 1, code: 'PROTOCOL_ERROR' });
    if (!state || state.capability.kind !== 'stream') throw new Error('Unknown stream');
    const capability = state.capability, previousSend = state.sending;
    state.phase = 'pulling'; state.sequence = sequence;
    const memory = this.memory.fork();
    this.task({
      memory,
      run: async () => {
        if (previousSend) await previousSend;
        if (!this.active() || state.phase !== 'pulling') return;
        state.reader ??= (state.value as ReadableStream<unknown>).getReader();
        let item: unknown, ended = false;
        if (capability.mode === 'bytes' && state.pendingBytes && state.offset < state.pendingBytes.length) {
          item = state.pendingBytes.subarray(state.offset, state.offset + BYTE_SEGMENT); state.offset += (item as Uint8Array).length;
        } else {
          if (state.pendingBytes) state.memory.release({ bytes: state.pendingBytes });
          state.pendingBytes = undefined; state.offset = 0;
          let next = await state.reader.read();
          let skipped = 0;
          while (!next.done && capability.mode === 'bytes' && next.value instanceof Uint8Array && next.value.length === 0) {
          // A zero-length byte chunk carries no data. Yield periodically without granting more wire credit.
            if (!this.active() || state.phase !== 'pulling') return;
            if (++skipped % 64 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
            next = await state.reader.read();
          }
          if (!this.active() || state.phase !== 'pulling') return;
          ended = next.done === true; item = next.value;
          if (!ended && capability.mode === 'bytes') {
            check({ condition: item instanceof Uint8Array && item.buffer instanceof ArrayBuffer && item.length > 0, code: 'INVALID_ARGUMENT' });
            const bytes = item as Uint8Array;
            // Retain one source-owned chunk, never concatenate an unbounded stream.
            state.memory.retain({ bytes }); state.pendingBytes = bytes; item = bytes.subarray(0, BYTE_SEGMENT); state.offset = (item as Uint8Array).length;
          }
        }
        if (!this.active() || state.phase !== 'pulling') return;
        if (ended) {
          try {
            releaseLocks({ reader: state.reader, writer: undefined });
          } catch (error) {
            this.recordRetirementFailure({ error: error instanceof RpcRetirementError ? error.cause : error }); return;
          }
          state.phase = 'terminal';
          await this.send({ frame: { type: 'end', id, sequence } }); return;
        }
        const parsed = capability.item.parse(item);
        if (!this.active() || state.phase !== 'pulling') return;
        const value = decode({ bytes: encode({ value: parsed, limit: VALUE_BYTES, memory }), memory });
        check({ condition: references({ value }).size === 0, code: 'INVALID_ARGUMENT' });
        state.phase = 'accepted';
        const bytes = encode({ value, limit: VALUE_BYTES, memory });
        const sent = Promise.resolve().then(async () => {
          if (capability.mode === 'bytes' || bytes.length <= ITEM_FRAGMENT_BYTES) {
            await this.send({ frame: { type: 'item', id, sequence, value } }); return;
          }
          for (let offset = 0; offset < bytes.length; offset += ITEM_FRAGMENT_BYTES) {
            if (!this.active() || phaseIs({ phase: state.phase, expected: 'stopping' }) || phaseIs({ phase: state.phase, expected: 'terminal' })) return;
            await this.send({ frame: { type: 'item-fragment', id, sequence, total: bytes.length, offset, data: bytes.subarray(offset, offset + ITEM_FRAGMENT_BYTES) } });
          }
        }); state.sending = sent;
        await sent; if (state.sending === sent) state.sending = undefined;
        if (state.pendingBytes && state.offset >= state.pendingBytes.length) {
          state.memory.release({ bytes: state.pendingBytes }); state.pendingBytes = undefined; state.offset = 0;
        }
      },
    });
  }

  private receiveItem({ id, sequence, value, ended }: { id: number; sequence: number; value: WireValue; ended: boolean }): void {
    const state = this.imports.get(id);
    check({ condition: state !== undefined && isStream(state.capability) && sequence === state.sequence, code: 'PROTOCOL_ERROR' });
    if (!state || state.capability.kind !== 'stream') throw new Error('Unknown stream');
    check({ condition: state.granted && (state.phase === 'pulling' || phaseIs({ phase: state.phase, expected: 'stopping' })), code: 'PROTOCOL_ERROR' });
    check({ condition: state.fragment === undefined, code: 'PROTOCOL_ERROR' });
    if (!ended && state.capability.mode === 'bytes') check({ condition: value instanceof Uint8Array && value.length > 0 && value.length <= BYTE_PULL_BYTES, code: 'PROTOCOL_ERROR' });
    const validation = encode({ value, limit: VALUE_BYTES, memory: this.dispatchMemory }); this.dispatchMemory?.release({ bytes: validation }); check({ condition: references({ value }).size === 0, code: 'PROTOCOL_ERROR' });
    state.granted = false;
    if (phaseIs({ phase: state.phase, expected: 'stopping' })) return; // At most the single previously granted item may still arrive.
    const pending = state.pending; state.pending = undefined;
    if (ended) {
      state.phase = 'terminal'; state.controller?.close();
    } else {
      const parsed = state.capability.item.parse(value);
      if (!this.active() || phaseIs({ phase: state.phase, expected: 'stopping' }) || phaseIs({ phase: state.phase, expected: 'terminal' })) return;
      state.phase = 'accepted'; state.controller?.enqueue(parsed);
    }
    pending?.resolve(); this.maybeFinish();
  }

  private receiveFragment({ id, sequence, total, offset, data }: { id: number; sequence: number; total: number; offset: number; data: Uint8Array }): void {
    const state = this.imports.get(id);
    check({
      condition: state?.capability.kind === 'stream' && state.capability.mode === 'items' && state.granted && sequence === state.sequence &&
      (state.phase === 'pulling' || state.phase === 'stopping'),
      code: 'PROTOCOL_ERROR',
    });
    if (!state) throw new Error('Missing item stream');
    if (!state.fragment) {
      check({ condition: offset === 0 && total > ITEM_FRAGMENT_BYTES, code: 'PROTOCOL_ERROR' });
      const discarded = phaseIs({ phase: state.phase, expected: 'stopping' });
      state.fragment = { bytes: discarded ? undefined : new ByteAssembly({ limit: total, memory: this.memory }), total, offset: 0 };
    }
    const partial = state.fragment;
    check({ condition: total === partial.total && offset === partial.offset && offset + data.length <= total, code: 'PROTOCOL_ERROR' });
    if (partial.bytes) {
      check({ condition: this.partialBytes + data.length <= VALUE_BYTES, code: 'RESOURCE_EXHAUSTED' });
      partial.bytes.append({ bytes: data }); this.partialBytes += data.length;
    }
    partial.offset += data.length;
    if (partial.offset !== partial.total) return;
    state.fragment = undefined;
    if (partial.bytes) {
      this.partialBytes -= total;
      try {
        this.receiveItem({ id, sequence, value: decode({ bytes: partial.bytes.finish(), memory: this.dispatchMemory }), ended: false });
      } finally {
        partial.bytes.dispose();
      }
    } else state.granted = false;
  }

  private invoke({ id, invocation, value }: { id: number; invocation: number; value: WireValue }): void {
    const target = this.exports.get(id);
    check({
      condition: target?.capability.kind === 'callback' && target.phase === 'accepted' &&
      invocation > this.lastInvocation && invocation <= 1024,
      code: 'PROTOCOL_ERROR',
    });
    this.lastInvocation = invocation;
    if (!target || target.capability.kind !== 'callback') throw new Error('Callback missing');
    if (this.callbacksRunning >= CALLBACK_LIMIT) {
      void this.send({ frame: { type: 'raised', invocation } }); return;
    }
    const inputPlan = compile({ schema: target.capability.input, capabilitiesAllowed: false, callbacksAllowed: false });
    const resultPlan = compile({ schema: target.capability.result, capabilitiesAllowed: false, callbacksAllowed: false });
    check({ condition: references({ value }).size === 0, code: 'PROTOCOL_ERROR' });
    const memory = this.memory.fork();
    let input: unknown;
    try {
      input = project({
        plan: inputPlan,
        value,
        memory,
        proxy: () => {
          throw new Error('No nested capabilities');
        },
      }).value;
    } catch (error) {
      memory.clear(); throw error;
    }
    this.callbacksRunning++;
    this.task({
      memory,
      run: async () => {
        try {
          // eslint-disable-next-line local-rules-named-args/require-named-args -- Invoke the locally registered callback with the one argument defined by its schema, not an extra wrapper object.
          const result: unknown = await (target.value as (input: unknown) => unknown)(input);
          if (!this.active()) return;
          const packed = pack({
            memory,
            plan: resultPlan,
            value: result,
            allocate: () => {
              throw new Error('No nested capabilities');
            },
          });
          await this.send({ frame: { type: 'returned', invocation, value: packed.value } });
        } catch {
          if (this.active()) await this.send({ frame: { type: 'raised', invocation } });
        } finally {
          this.callbacksRunning--;
        }
      },
    });
  }

  private clearNotices(): void {
    for (const pending of this.notices.values()) pending.memory.clear();
    this.notices.clear();
  }

  private notify({ name, value }: { name: string; value: unknown }): void {
    if (!this.active()) return;
    const plan = this.method?.notifications.get(name); if (!plan) throw new Error('Undeclared notification');
    const memory = this.memory.fork();
    try {
      const packed = pack({
        plan,
        value,
        memory,
        allocate: () => {
          throw new Error('Finite notification required');
        },
      });
      this.notices.get(name)?.memory.clear(); this.notices.set(name, { value: packed.value, memory });
    } catch (error) {
      memory.clear(); throw error;
    }
    if (this.noticeSending) return; this.noticeSending = true;
    this.task({
      run: async () => {
        try {
          while (this.active() && this.notices.size) {
            const [key, item] = this.notices.entries().next().value!; this.notices.delete(key);
            try {
              await this.send({ frame: { type: 'notice', name: key, value: item.value } });
            } finally {
              item.memory.clear();
            }
          }
        } finally {
          this.noticeSending = false; this.clearNotices();
        }
      },
    });
  }

  private notice({ name, value }: { name: string; value: WireValue }): void {
    check({ condition: isCaller({ role: this.role }), code: 'PROTOCOL_ERROR' });
    check({ condition: references({ value }).size === 0, code: 'PROTOCOL_ERROR' });
    const plan = this.method?.notifications.get(name); if (!plan) return;
    const memory = this.memory.fork();
    let output: unknown;
    try {
      output = project({
        plan,
        value,
        memory,
        proxy: () => {
          throw new Error('No capabilities in notifications');
        },
      }).value;
    } catch (error) {
      memory.clear(); throw error;
    }
    const observer = this.observers[name];
    if (!observer) {
      memory.clear(); return;
    }
    const slot = this.observed.get(name) ?? { running: false, latest: undefined, present: false, memory: undefined };
    slot.memory?.clear(); slot.memory = memory; slot.latest = output as WireValue; slot.present = true; this.observed.set(name, slot);
    if (slot.running) return; slot.running = true;
    this.task({
      run: async () => {
        try {
          while (slot.present && this.active()) {
            const value = slot.latest, owned = slot.memory; slot.memory = undefined; slot.latest = undefined; slot.present = false;
            try {
              await observer({ value });
            } finally {
              owned?.clear();
            }
          }
        } finally {
          slot.memory?.clear(); slot.memory = undefined; slot.running = false; slot.latest = undefined; slot.present = false;
        }
      },
    });
  }

  private streamsTerminal({ scope, direction }: { scope: Scope; direction: 'export' | 'import' }): boolean {
    const values = (() => {
      switch (direction) {
      case 'export': return this.exports.values(); case 'import': return this.imports.values(); default: { const unreachable: never = direction; throw new Error(String(unreachable)); }
      }
    })();
    for (const state of values) if (state.scope === scope && isStream(state.capability) && state.phase !== 'terminal') return false;
    return true;
  }

  private maybeFinish(): void {
    if (!this.active() || isCaller({ role: this.role }) || this.finishing || !this.handlerReturned || !this.resultAccepted ||
      this.invocations.size || this.callbacksRunning || !this.streamsTerminal({ scope: 'result', direction: 'export' })) return;
    this.finishing = true;
    try {
      for (const [id, state] of this.imports) if (isStream(state.capability) && state.phase !== 'terminal') void this.stopImport({ id }).catch(() => {});
      if (!this.streamsTerminal({ scope: 'input', direction: 'import' })) return;
      this.finishSent = 'success'; this.clearNotices();
      void this.send({ frame: { type: 'finish', code: undefined, details: undefined } }).then(() => this.channel.finish()).catch(() => this.abort({ code: 'TRANSPORT_ERROR' }));
    } finally {
      this.finishing = false;
    }
  }

  private cancelCapabilities({ error }: { error: unknown }): void {
    this.controller.abort(error); this.clearNotices();
    for (const state of this.imports.values()) {
      state.fragment?.bytes?.dispose(); state.fragment = undefined;
      state.phase = 'terminal'; state.controller?.error(error); state.pending?.reject(error); state.pending = undefined;
    }
    this.partialBytes = 0;
    for (const [id, state] of this.exports) if (isStream(state.capability) && state.phase !== 'terminal' && state.phase !== 'stopping') this.stopExport({ id, acknowledge: false });
    for (const pending of this.invocations.values()) pending.result.reject(error);
    this.invocations.clear();
  }

  private reject({ error }: { error: NaidanRpcError }): void {
    if (this.wireEnded || this.failure) return;
    this.failure = error; this.result.reject(this.failure); this.cancelCapabilities({ error: this.failure });
    if (!this.finishSent) {
      this.finishSent = 'error';
      void this.send({ frame: { type: 'finish', code: error.code, details: error instanceof NaidanRpcPublicError ? error.details : undefined } }).catch(() => this.abort({ code: error.code }));
    }
  }

  revokeMethods({ contract, removed }: { contract: string; removed: ReadonlySet<string> }): void {
    if (this.role === 'callee' && this.incomingMethod?.contract === contract && removed.has(this.incomingMethod.method) && this.active()) {
      this.reject({ error: new NaidanRpcError({ code: 'METHOD_NOT_ALLOWED' }) });
    }
  }

  abort({ code }: { code: NaidanRpcErrorCode }): void {
    if (this.wireEnded) return;
    this.failure ??= new NaidanRpcError({ code }); this.result.reject(this.failure);
    this.wireEnded = true; clearTimeout(this.timer); this.cancelCapabilities({ error: this.failure });
    try {
      this.duplex.abort({ reason: code });
    } catch (error) {
      // The caller still receives cancellation, but the owner must not mistake
      // a failed lower abort for successful resource retirement.
      this.recordRetirementFailure({ error });
    }
    this.task({
      retirement: true,
      run: async () => {
        await this.channel.stop({ error: this.failure });
      },
    });
    this.closed.reject(this.failure); this.maybeRetire();
  }

  private async discardResult({ plan, value }: { plan: Plan; value: unknown }): Promise<void> {
    let streams: ReadonlySet<ReadableStream<unknown>>;
    try {
      streams = returnedStreams({ plan, value });
    } catch (error) {
      this.recordRetirementFailure({ error }); return;
    }
    await Promise.all([...streams].map(async stream => {
      let reader: ReadableStreamDefaultReader<unknown> | undefined;
      try {
        reader = stream.getReader(); await cancelReader({ reader, reason: this.failure });
      } catch (error) {
        this.recordRetirementFailure({ error: error instanceof RpcRetirementError ? error.cause : error });
      } finally {
        try {
          releaseLocks({ reader, writer: undefined });
        } catch (error) {
          this.recordRetirementFailure({ error });
        }
      }
    }));
  }

  private async handle({ frame }: { frame: Frame }): Promise<void> {
    switch (frame.type) {
    case 'finish': {
      check({ condition: this.finishReceived === undefined, code: 'PROTOCOL_ERROR' });
      if (frame.code !== undefined) {
        this.failure ??= frame.details === undefined ? new NaidanRpcError({ code: frame.code }) : new NaidanRpcPublicError({ code: frame.code, details: frame.details }); this.result.reject(this.failure);
        this.cancelCapabilities({ error: this.failure }); this.finishReceived = 'error';
      } else {
        check({
          condition: isCaller({ role: this.role }) && this.resultReceived && this.callbacksRunning === 0 && this.invocations.size === 0 &&
          this.streamsTerminal({ scope: 'result', direction: 'import' }) && this.streamsTerminal({ scope: 'input', direction: 'export' }),
          code: 'PROTOCOL_ERROR',
        });
        this.finishReceived = 'success';
      }
      void this.send({ frame: { type: 'ack' } }).then(() => this.channel.finish()).catch(() => this.abort({ code: 'TRANSPORT_ERROR' })); return;
    }
    case 'ack': {
      check({ condition: this.finishSent !== undefined && !this.acknowledged, code: 'PROTOCOL_ERROR' });
      this.acknowledged = true; void this.channel.finish().catch(() => this.abort({ code: 'TRANSPORT_ERROR' })); return;
    }
    case 'open': case 'result': case 'accept': case 'pull': case 'item': case 'item-fragment': case 'end': case 'stop': case 'stopped':
    case 'invoke': case 'returned': case 'raised': case 'notice': break;
    default: { const unreachable: never = frame; throw new Error(String(unreachable)); }
    }
    // Authorized data may already have been in flight when a failure terminates this call.
    if (this.failure) return;
    check({ condition: !this.finishReceived && !this.finishSent, code: 'PROTOCOL_ERROR' });
    switch (frame.type) {
    case 'open': {
      check({ condition: !isCaller({ role: this.role }) && !this.opened, code: 'PROTOCOL_ERROR' }); this.opened = true;
      const timeout = Math.min(frame.timeoutMs ?? Infinity, this.maxTimeoutMs ?? Infinity); clearTimeout(this.timer);
      this.deadlineAt = performance.now() + timeout; this.timer = Number.isFinite(timeout) ? setTimeout(() => this.abort({ code: 'DEADLINE_EXCEEDED' }), timeout) : undefined;
      this.incomingMethod = { contract: frame.contract, method: frame.method };
      let method: PreparedMethod;
      try {
        method = this.resolveMethod({ contract: frame.contract, method: frame.method });
      } catch (error) {
        this.reject({ error: error instanceof NaidanRpcError ? error : new NaidanRpcError({ code: 'METHOD_NOT_FOUND' }) }); return;
      }
      this.method = method;
      let input: unknown;
      try {
        input = this.receiveValue({ plan: method.input, value: wireValue({ value: frame.value, memory: this.dispatchMemory }), scope: 'input' });
      } catch (error) {
        this.reject({ error: error instanceof NaidanRpcPublicError && error.code === 'RESOURCE_EXHAUSTED' ? error : new NaidanRpcError({ code: 'INVALID_ARGUMENT' }) }); return;
      }
      const contractName = frame.contract, methodName = frame.method;
      this.task({
        run: async () => {
          if (!this.active()) return;
          this.controller.signal.throwIfAborted();
          this.resolveMethod({ contract: contractName, method: methodName });
          if (!method.handler) throw new Error('Missing handler');
          const notify = Object.fromEntries([...method.notifications.keys()].map(name => [name, ({ value }: { value: unknown }) => this.notify({ name, value })]));
          const result = await method.handler({ input, notify, signal: this.controller.signal });
          let packed: Packed;
          try {
            packed = pack({ plan: method.result, value: result, memory: this.values, allocate: () => this.allocate() });
          } catch (error) {
            await this.discardResult({ plan: method.result, value: result }); throw error;
          }
          this.register({ packed, scope: 'result' });
          if (!this.active()) {
          // A handler may settle after cancellation/revocation. Its returned
          // streams still transfer ownership to this call, even though no result
          // will be offered. Cancel without pulling and join every source task.
            for (const [id, state] of this.exports) if (state.scope === 'result' && isStream(state.capability)) this.stopExport({ id, acknowledge: false });
            return;
          }
          this.resultOffered = true;
          await this.send({ frame: { type: 'result', value: packed.value } }); this.handlerReturned = true;
        },
      }); return;
    }
    case 'result': {
      check({ condition: isCaller({ role: this.role }) && this.inputAccepted && !this.resultReceived && this.method, code: 'PROTOCOL_ERROR' });
      if (!this.method) throw new Error('Method missing');
      const value = this.receiveValue({ plan: this.method.result, value: wireValue({ value: frame.value, memory: this.dispatchMemory }), scope: 'result' });
      this.resultReceived = true; this.result.resolve(value); return;
    }
    case 'accept': this.accept({ scope: frame.scope, ids: frame.ids }); return;
    case 'pull': this.pullExport({ id: frame.id, sequence: frame.sequence }); return;
    case 'item': this.receiveItem({ id: frame.id, sequence: frame.sequence, value: wireValue({ value: frame.value, memory: this.dispatchMemory }), ended: false }); return;
    case 'item-fragment': this.receiveFragment({ id: frame.id, sequence: frame.sequence, total: frame.total, offset: frame.offset, data: frame.data }); return;
    case 'end': this.receiveItem({ id: frame.id, sequence: frame.sequence, value: undefined, ended: true }); return;
    case 'stop': this.stopExport({ id: frame.id, acknowledge: true }); return;
    case 'stopped': {
      const state = this.imports.get(frame.id);
      check({ condition: state?.phase === 'stopping', code: 'PROTOCOL_ERROR' });
      if (!state) throw new Error('Missing stopped stream');
      if (state.fragment?.bytes) {
        this.partialBytes -= state.fragment.bytes.byteLength; state.fragment.bytes.dispose();
      }
      state.fragment = undefined; state.granted = false;
      state.phase = 'terminal'; state.pending?.resolve(); state.pending = undefined;
      this.maybeFinish(); return;
    }
    case 'invoke': this.invoke({ id: frame.id, invocation: frame.invocation, value: wireValue({ value: frame.value, memory: this.dispatchMemory }) }); return;
    case 'returned': case 'raised': {
      const pending = this.invocations.get(frame.invocation);
      check({ condition: pending !== undefined, code: 'PROTOCOL_ERROR' });
      if (!pending) throw new Error('Unknown invocation');
      switch (frame.type) {
      case 'raised':
        this.invocations.delete(frame.invocation);
        pending.result.reject(new NaidanRpcError({ code: 'HANDLER_FAILED' })); break;
      case 'returned': {
        const value = wireValue({ value: frame.value, memory: this.dispatchMemory }); check({ condition: references({ value }).size === 0, code: 'PROTOCOL_ERROR' });
        const projected = project({
          plan: pending.plan,
          memory: pending.memory,
          value,
          proxy: () => {
            throw new Error('Finite callback result');
          },
        }).value;
        // Keep ownership until validation succeeds so abort rejects a callback
        // awaiting a malformed return and can join its handler.
        this.invocations.delete(frame.invocation);
        pending.result.resolve(projected); break;
      }
      default: { const unreachable: never = frame; throw new Error(String(unreachable)); }
      }
      this.maybeFinish(); return;
    }
    case 'notice': this.notice({ name: frame.name, value: wireValue({ value: frame.value, memory: this.dispatchMemory }) }); return;
    default: { const unreachable: never = frame; throw new Error(String(unreachable)); }
    }
  }

  private async read(): Promise<void> {
    try {
      let processed = 0;
      while (!this.wireEnded) {
        check({ condition: performance.now() < this.deadlineAt, code: 'DEADLINE_EXCEEDED' });
        const frame = await this.channel.read();
        if (this.wireEnded) return;
        if (!frame) break;
        // Dispatch never awaits application handlers, source reads, callbacks or response writes.
        this.dispatchMemory = this.memory.fork();
        try {
          await this.handle({ frame });
        } finally {
          this.dispatchMemory.clear(); this.dispatchMemory = undefined;
        }
        if (++processed % 64 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      if (this.wireEnded) return;
      check({ condition: this.finishReceived !== undefined || (this.finishSent !== undefined && this.acknowledged), code: 'PROTOCOL_ERROR' });
      await this.duplex.closed;
      if (this.wireEnded) return;
      this.wireEnded = true; clearTimeout(this.timer);
      this.task({ retirement: true, run: () => this.channel.retire() });
      this.controller.abort();
      if (this.failure) this.closed.reject(this.failure); else this.closed.resolve();
      this.maybeRetire();
    } catch (error) {
      this.failure ??= error instanceof NaidanRpcError ? error : new NaidanRpcError({ code: 'PROTOCOL_ERROR', cause: error });
      this.abort({ code: this.failure.code });
    }
  }
}

function isCaller({ role }: { role: 'caller' | 'callee' }): boolean {
  switch (role) {
  case 'caller': return true;
  case 'callee': return false;
  default: { const unreachable: never = role; throw new Error(String(unreachable)); }
  }
}

function phaseIs({ phase, expected }: { phase: Phase; expected: 'terminal' | 'stopping' }): boolean {
  switch (phase) {
  case 'terminal': return expected === 'terminal';
  case 'stopping': return expected === 'stopping';
  case 'offered': case 'accepted': case 'pulling': return false;
  default: { const unreachable: never = phase; throw new Error(String(unreachable)); }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
