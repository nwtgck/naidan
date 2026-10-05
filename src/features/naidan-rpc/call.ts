import { decode, encode } from '@/features/naidan-rpc/codec';
import type { Reference, WireValue } from '@/features/naidan-rpc/codec';
import { FramedDuplex, wireValue } from '@/features/naidan-rpc/framing';
import type { Frame } from '@/features/naidan-rpc/framing';
import { compile, pack, project, references, isStream } from '@/features/naidan-rpc/schema';
import type { Capability, Packed, Plan, Source } from '@/features/naidan-rpc/schema';
import { CALLBACK_LIMIT, check, deferred, duration, ITEM_BYTES, NaidanRpcError, NaidanRpcPublicError, RPC_VERSION } from '@/features/naidan-rpc/primitives';
import type { NaidanRpcErrorCode } from '@/features/naidan-rpc/primitives';
import type { PreparedMethod } from '@/features/naidan-rpc/contract';
import type { NaidanRpcDuplex } from '@/features/naidan-rpc/transport';

type Scope = 'input' | 'result';
const BYTE_SEGMENT = ITEM_BYTES - 4;
type Phase = 'offered' | 'accepted' | 'pulling' | 'stopping' | 'terminal';
type Exported = Source & { scope: Scope; phase: Phase; sequence: number; reader: ReadableStreamDefaultReader<unknown> | undefined;
  pendingBytes: Uint8Array | undefined; offset: number; sending: Promise<void> | undefined; stopRequested: boolean };
type Imported = { scope: Scope; capability: Capability; phase: Phase; sequence: number;
  controller: ReadableStreamDefaultController<unknown> | undefined; granted: boolean; pending: ReturnType<typeof deferred<void>> | undefined };
type PendingCallback = { result: ReturnType<typeof deferred<unknown>>; plan: Plan };
export type Observer = ({ value }: { value: unknown }) => void | Promise<void>;

/** One lower duplex owns one root call, its stream references and its reverse invocations. */
export class RpcConversation {
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
  private readonly invocations = new Map<number, PendingCallback>();
  private readonly notices = new Map<string, WireValue>();
  private readonly observed = new Map<string, { running: boolean; latest: WireValue | undefined; present: boolean }>();
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

  constructor({ duplex, role, timeoutMs, resolveMethod }: {
    duplex: NaidanRpcDuplex; role: 'caller' | 'callee'; timeoutMs: number | undefined;
    resolveMethod: ({ contract, method }: { contract: string; method: string }) => PreparedMethod;
  }) {
    if (timeoutMs !== undefined) duration({ milliseconds: timeoutMs });
    this.duplex = duplex; this.role = role; this.resolveMethod = resolveMethod; this.maxTimeoutMs = timeoutMs;
    this.nextReference = isCaller({ role }) ? 1 : 2;
    this.channel = new FramedDuplex({ duplex });
    this.deadlineAt = performance.now() + (timeoutMs ?? Infinity);
    this.timer = timeoutMs === undefined ? undefined : setTimeout(() => this.abort({ code: 'DEADLINE_EXCEEDED' }), timeoutMs);
    void duplex.closed.catch(() => this.abort({ code: 'TRANSPORT_ERROR' }));
    void this.read();
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
  private task({ run }: { run: () => Promise<void> }): void {
    this.jobs++;
    void Promise.resolve().then(run).catch(error => {
      if (this.active()) this.reject({ error: error instanceof NaidanRpcError ? error : new NaidanRpcError({ code: 'HANDLER_FAILED' }) });
    }).finally(() => {
      this.jobs--; this.maybeFinish(); this.maybeRetire();
    });
  }
  private maybeRetire(): void {
    if (!this.wireEnded || this.jobs !== 0) return;
    this.exports.clear(); this.imports.clear(); this.notices.clear(); this.observed.clear(); this.method = undefined; this.observers = {};
    if (this.retirementFailure) this.retired.reject(this.retirementFailure.error); else this.retired.resolve();
  }
  private register({ packed, scope }: { packed: Packed; scope: Scope }): void {
    for (const [id, source] of packed.sources) {
      check({ condition: !this.exports.has(id) && this.exports.size < 16, code: 'RESOURCE_EXHAUSTED' });
      this.exports.set(id, { ...source, scope, phase: 'offered', sequence: 0, reader: undefined, pendingBytes: undefined, offset: 0, sending: undefined, stopRequested: false });
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
      void this.send({ frame: { type: 'open', version: RPC_VERSION, contract, method, timeoutMs, value: packed.value } });
    } catch {
      this.abort({ code: 'INVALID_ARGUMENT' });
    }
  }
  private proxy({ reference, capability, scope }: { reference: Reference; capability: Capability; scope: Scope }): unknown {
    const state: Imported = { scope, capability, phase: 'offered', sequence: 0, controller: undefined, granted: false, pending: undefined };
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
        const packed = pack({ plan: inputPlan, value: input, allocate: () => {
          throw new Error('Finite callback input required');
        } });
        const invocation = this.nextInvocation++, result = deferred<unknown>();
        this.invocations.set(invocation, { result, plan: resultPlan });
        try {
          await this.send({ frame: { type: 'invoke', id: reference.id, invocation, value: packed.value } }); return await result.promise;
        } finally {
          this.invocations.delete(invocation); this.maybeFinish();
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
    const projected = project({ plan, value, proxy: ({ reference, capability }) => this.proxy({ reference, capability, scope }) });
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
    this.task({ run: async () => {
      try {
        if (isStream(state.capability)) {
          if (state.reader) await state.reader.cancel();
          else await (state.value as ReadableStream<unknown>).cancel();
        }
      } finally {
        state.phase = 'terminal';
        try {
          state.reader?.releaseLock();
        } catch { /* A cancelled pull may still be settling. */ }
        if (acknowledge && this.active()) await this.send({ frame: { type: 'stopped', id } });
      }
    } });
  }
  private stopImport({ id }: { id: number }): Promise<void> {
    const state = this.imports.get(id); if (!state || phaseIs({ phase: state.phase, expected: 'terminal' })) return Promise.resolve();
    if (phaseIs({ phase: state.phase, expected: 'stopping' })) return state.pending?.promise ?? Promise.resolve();
    check({ condition: isStream(state.capability), code: 'PROTOCOL_ERROR' });
    state.phase = 'stopping'; state.pending?.resolve();
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
    this.task({ run: async () => {
      if (previousSend) await previousSend;
      if (!this.active() || state.phase !== 'pulling') return;
      state.reader ??= (state.value as ReadableStream<unknown>).getReader();
      let item: unknown, ended = false;
      if (capability.mode === 'bytes' && state.pendingBytes && state.offset < state.pendingBytes.length) {
        item = state.pendingBytes.subarray(state.offset, state.offset + BYTE_SEGMENT); state.offset += (item as Uint8Array).length;
      } else {
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
          check({ condition: item instanceof Uint8Array && item.buffer instanceof ArrayBuffer && item.length > 0 && item.length <= 64 * 1024 * 1024, code: 'INVALID_ARGUMENT' });
          const bytes = item as Uint8Array;
          // Retain one source-owned chunk, never concatenate an unbounded stream.
          state.pendingBytes = bytes; item = bytes.subarray(0, BYTE_SEGMENT); state.offset = (item as Uint8Array).length;
        }
      }
      if (!this.active() || state.phase !== 'pulling') return;
      if (ended) {
        state.phase = 'terminal'; state.reader.releaseLock();
        await this.send({ frame: { type: 'end', id, sequence } }); return;
      }
      const parsed = capability.item.parse(item);
      const value = decode({ bytes: encode({ value: parsed, limit: ITEM_BYTES }) });
      check({ condition: references({ value }).size === 0, code: 'INVALID_ARGUMENT' });
      state.phase = 'accepted';
      const sent = this.send({ frame: { type: 'item', id, sequence, value } }); state.sending = sent;
      await sent; if (state.sending === sent) state.sending = undefined;
    } });
  }
  private receiveItem({ id, sequence, value, ended }: { id: number; sequence: number; value: WireValue; ended: boolean }): void {
    const state = this.imports.get(id);
    check({ condition: state !== undefined && isStream(state.capability) && sequence === state.sequence, code: 'PROTOCOL_ERROR' });
    if (!state || state.capability.kind !== 'stream') throw new Error('Unknown stream');
    check({ condition: state.granted && (state.phase === 'pulling' || phaseIs({ phase: state.phase, expected: 'stopping' })), code: 'PROTOCOL_ERROR' });
    encode({ value, limit: ITEM_BYTES }); check({ condition: references({ value }).size === 0, code: 'PROTOCOL_ERROR' });
    state.granted = false;
    if (phaseIs({ phase: state.phase, expected: 'stopping' })) return; // At most the single previously granted item may still arrive.
    const pending = state.pending; state.pending = undefined;
    if (ended) {
      state.phase = 'terminal'; state.controller?.close();
    } else {
      const parsed = state.capability.item.parse(value);
      state.phase = 'accepted'; state.controller?.enqueue(parsed);
    }
    pending?.resolve(); this.maybeFinish();
  }
  private invoke({ id, invocation, value }: { id: number; invocation: number; value: WireValue }): void {
    const target = this.exports.get(id);
    check({ condition: target?.capability.kind === 'callback' && target.phase === 'accepted' &&
      invocation > this.lastInvocation && invocation <= 1024, code: 'PROTOCOL_ERROR' });
    this.lastInvocation = invocation;
    if (!target || target.capability.kind !== 'callback') throw new Error('Callback missing');
    if (this.callbacksRunning >= CALLBACK_LIMIT) {
      void this.send({ frame: { type: 'raised', invocation } }); return;
    }
    const inputPlan = compile({ schema: target.capability.input, capabilitiesAllowed: false, callbacksAllowed: false });
    const resultPlan = compile({ schema: target.capability.result, capabilitiesAllowed: false, callbacksAllowed: false });
    check({ condition: references({ value }).size === 0, code: 'PROTOCOL_ERROR' });
    this.callbacksRunning++;
    this.task({ run: async () => {
      try {
        const input = project({ plan: inputPlan, value, proxy: () => {
          throw new Error('No nested capabilities');
        } }).value;
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Invoke the locally registered callback with the one argument defined by its schema, not an extra wrapper object.
        const result: unknown = await (target.value as (input: unknown) => unknown)(input);
        if (!this.active()) return;
        const packed = pack({ plan: resultPlan, value: result, allocate: () => {
          throw new Error('No nested capabilities');
        } });
        await this.send({ frame: { type: 'returned', invocation, value: packed.value } });
      } catch {
        if (this.active()) await this.send({ frame: { type: 'raised', invocation } });
      } finally {
        this.callbacksRunning--;
      }
    } });
  }
  private notify({ name, value }: { name: string; value: unknown }): void {
    if (!this.active()) return;
    const plan = this.method?.notifications.get(name); if (!plan) throw new Error('Undeclared notification');
    const packed = pack({ plan, value, allocate: () => {
      throw new Error('Finite notification required');
    } });
    encode({ value: packed.value, limit: ITEM_BYTES }); this.notices.set(name, packed.value);
    if (this.noticeSending) return; this.noticeSending = true;
    this.task({ run: async () => {
      try {
        while (this.active() && this.notices.size) {
          const [key, item] = this.notices.entries().next().value!; this.notices.delete(key);
          await this.send({ frame: { type: 'notice', name: key, value: item } });
        }
      } finally {
        this.noticeSending = false; this.notices.clear();
      }
    } });
  }
  private notice({ name, value }: { name: string; value: WireValue }): void {
    check({ condition: isCaller({ role: this.role }), code: 'PROTOCOL_ERROR' });
    encode({ value, limit: ITEM_BYTES }); check({ condition: references({ value }).size === 0, code: 'PROTOCOL_ERROR' });
    const plan = this.method?.notifications.get(name); if (!plan) return;
    const output = project({ plan, value, proxy: () => {
      throw new Error('No capabilities in notifications');
    } }).value;
    const observer = this.observers[name]; if (!observer) return;
    const slot = this.observed.get(name) ?? { running: false, latest: undefined, present: false };
    slot.latest = output as WireValue; slot.present = true; this.observed.set(name, slot);
    if (slot.running) return; slot.running = true;
    this.task({ run: async () => {
      try {
        while (slot.present && this.active()) {
          const value = slot.latest; slot.latest = undefined; slot.present = false; await observer({ value });
        }
      } finally {
        slot.running = false; slot.latest = undefined; slot.present = false;
      }
    } });
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
      this.finishSent = 'success'; this.notices.clear();
      void this.send({ frame: { type: 'finish', code: undefined, details: undefined } }).then(() => this.channel.finish()).catch(() => this.abort({ code: 'TRANSPORT_ERROR' }));
    } finally {
      this.finishing = false;
    }
  }
  private cancelCapabilities({ error }: { error: unknown }): void {
    this.controller.abort(error); this.notices.clear();
    for (const state of this.imports.values()) {
      state.phase = 'terminal'; state.controller?.error(error); state.pending?.reject(error); state.pending = undefined;
    }
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
      this.retirementFailure ??= { error };
    }
    this.task({ run: async () => {
      await this.channel.stop({ error: this.failure }); this.channel.release();
    } });
    this.closed.reject(this.failure); this.maybeRetire();
  }
  private async handle({ frame }: { frame: Frame }): Promise<void> {
    switch (frame.type) {
    case 'finish': {
      check({ condition: this.finishReceived === undefined, code: 'PROTOCOL_ERROR' });
      if (frame.code !== undefined) {
        this.failure ??= frame.details === undefined ? new NaidanRpcError({ code: frame.code }) : new NaidanRpcPublicError({ code: frame.code, details: frame.details }); this.result.reject(this.failure);
        this.cancelCapabilities({ error: this.failure }); this.finishReceived = 'error';
      } else {
        check({ condition: isCaller({ role: this.role }) && this.resultReceived && this.callbacksRunning === 0 && this.invocations.size === 0 &&
          this.streamsTerminal({ scope: 'result', direction: 'import' }) && this.streamsTerminal({ scope: 'input', direction: 'export' }), code: 'PROTOCOL_ERROR' });
        this.finishReceived = 'success';
      }
      void this.send({ frame: { type: 'ack' } }).then(() => this.channel.finish()).catch(() => this.abort({ code: 'TRANSPORT_ERROR' })); return;
    }
    case 'ack': {
      check({ condition: this.finishSent !== undefined && !this.acknowledged, code: 'PROTOCOL_ERROR' });
      this.acknowledged = true; void this.channel.finish().catch(() => this.abort({ code: 'TRANSPORT_ERROR' })); return;
    }
    case 'open': case 'result': case 'accept': case 'pull': case 'item': case 'end': case 'stop': case 'stopped':
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
        input = this.receiveValue({ plan: method.input, value: wireValue({ value: frame.value }), scope: 'input' });
      } catch {
        this.reject({ error: new NaidanRpcError({ code: 'INVALID_ARGUMENT' }) }); return;
      }
      this.task({ run: async () => {
        if (!this.active()) return;
        this.controller.signal.throwIfAborted();
        this.resolveMethod({ contract: frame.contract, method: frame.method });
        if (!method.handler) throw new Error('Missing handler');
        const notify = Object.fromEntries([...method.notifications.keys()].map(name => [name, ({ value }: { value: unknown }) => this.notify({ name, value })]));
        const result = await method.handler({ input, notify, signal: this.controller.signal });
        const packed = pack({ plan: method.result, value: result, allocate: () => this.allocate() });
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
      } }); return;
    }
    case 'result': {
      check({ condition: isCaller({ role: this.role }) && this.inputAccepted && !this.resultReceived && this.method, code: 'PROTOCOL_ERROR' });
      if (!this.method) throw new Error('Method missing');
      const value = this.receiveValue({ plan: this.method.result, value: wireValue({ value: frame.value }), scope: 'result' });
      this.resultReceived = true; this.result.resolve(value); return;
    }
    case 'accept': this.accept({ scope: frame.scope, ids: frame.ids }); return;
    case 'pull': this.pullExport({ id: frame.id, sequence: frame.sequence }); return;
    case 'item': this.receiveItem({ id: frame.id, sequence: frame.sequence, value: wireValue({ value: frame.value }), ended: false }); return;
    case 'end': this.receiveItem({ id: frame.id, sequence: frame.sequence, value: undefined, ended: true }); return;
    case 'stop': this.stopExport({ id: frame.id, acknowledge: true }); return;
    case 'stopped': {
      const state = this.imports.get(frame.id);
      check({ condition: state?.phase === 'stopping', code: 'PROTOCOL_ERROR' });
      if (!state) throw new Error('Missing stopped stream');
      state.phase = 'terminal'; state.pending?.resolve(); state.pending = undefined;
      this.maybeFinish(); return;
    }
    case 'invoke': this.invoke({ id: frame.id, invocation: frame.invocation, value: wireValue({ value: frame.value }) }); return;
    case 'returned': case 'raised': {
      const pending = this.invocations.get(frame.invocation);
      check({ condition: pending !== undefined, code: 'PROTOCOL_ERROR' });
      if (!pending) throw new Error('Unknown invocation');
      this.invocations.delete(frame.invocation);
      switch (frame.type) {
      case 'raised': pending.result.reject(new NaidanRpcError({ code: 'HANDLER_FAILED' })); break;
      case 'returned': {
        const value = wireValue({ value: frame.value }); check({ condition: references({ value }).size === 0, code: 'PROTOCOL_ERROR' });
        pending.result.resolve(project({ plan: pending.plan, value, proxy: () => {
          throw new Error('Finite callback result');
        } }).value); break;
      }
      default: { const unreachable: never = frame; throw new Error(String(unreachable)); }
      }
      this.maybeFinish(); return;
    }
    case 'notice': this.notice({ name: frame.name, value: wireValue({ value: frame.value }) }); return;
    default: { const unreachable: never = frame; throw new Error(String(unreachable)); }
    }
  }
  private async read(): Promise<void> {
    try {
      let processed = 0;
      while (!this.wireEnded) {
        check({ condition: performance.now() < this.deadlineAt, code: 'DEADLINE_EXCEEDED' });
        const frame = await this.channel.read();
        if (!frame) break;
        // Dispatch never awaits application handlers, source reads, callbacks or response writes.
        await this.handle({ frame });
        if (++processed % 64 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      if (this.wireEnded) return;
      check({ condition: this.finishReceived !== undefined || (this.finishSent !== undefined && this.acknowledged), code: 'PROTOCOL_ERROR' });
      await this.duplex.closed;
      this.wireEnded = true; clearTimeout(this.timer); this.channel.release();
      this.controller.abort();
      if (this.failure) this.closed.reject(this.failure); else this.closed.resolve();
      this.maybeRetire();
    } catch (error) {
      if (error instanceof NaidanRpcPublicError) this.failure ??= error;
      this.abort({ code: error instanceof NaidanRpcError ? error.code : 'PROTOCOL_ERROR' });
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
