import { pack } from '@/features/naidan-rpc/schema';
import { RpcConversation } from '@/features/naidan-rpc/call';
import type { Observer } from '@/features/naidan-rpc/call';
import { check, deferred, duration, NaidanRpcError } from '@/features/naidan-rpc/primitives';
import { prepareMethod, checkAllowedMethods } from '@/features/naidan-rpc/contract';
import type { Contract, NaidanRpcClient, NaidanRpcExposure, NaidanRpcMethodName, PreparedMethod } from '@/features/naidan-rpc/contract';
import type { NaidanRpcDuplex, NaidanRpcTransport } from '@/features/naidan-rpc/transport';

export type NaidanRpcLimits = { maxCalls: number; maxCallTimeoutMs: number | undefined };
const owned = new WeakSet<NaidanRpcTransport>();
/** Both peers may expose and call methods. A single RPC peer exclusively consumes a transport iterator. */
export class NaidanRpcPeer {
  readonly closed: Promise<void>;
  private readonly transport: NaidanRpcTransport;
  private readonly stop = new AbortController();
  private readonly methods = new Map<string, { contract: Contract; methods: ReadonlyMap<string, PreparedMethod>; allowed: ReadonlySet<string> }>();
  private readonly calls = new Set<RpcConversation>();
  private readonly limits: NaidanRpcLimits;
  private opening = 0;
  private readonly pendingInvocations = new Set<Promise<void>>();
  private inputRetirement: Promise<unknown> = Promise.resolve();
  private incomingAdmission: 'open' | 'suspended' = 'open';
  private readonly allowedWhileSuspended = new Map<string, ReadonlySet<string>>();
  private failure: unknown;
  private retirementFailure: { error: unknown } | undefined;
  constructor({ transport, exports, limits, signal }: {
    transport: NaidanRpcTransport; exports: readonly NaidanRpcExposure[]; limits: NaidanRpcLimits; signal: AbortSignal;
  }) {
    const { maxCalls, maxCallTimeoutMs, ...rest } = limits; rest satisfies Record<PropertyKey, never>;
    check({ condition: Number.isInteger(maxCalls) && maxCalls >= 1 && maxCalls <= 32 && exports.length <= 32, code: 'INVALID_ARGUMENT' });
    if (maxCallTimeoutMs !== undefined) duration({ milliseconds: maxCallTimeoutMs });
    check({ condition: !owned.has(transport), code: 'INVALID_ARGUMENT' });
    for (const exposure of exports) {
      check({ condition: !this.methods.has(exposure.name), code: 'INVALID_ARGUMENT' });
      this.methods.set(exposure.name, { contract: exposure.contract, methods: new Map(exposure.methods),
        allowed: checkAllowedMethods({ contract: exposure.contract, allowedMethods: [...exposure.allowedMethods] }) });
    }
    signal.throwIfAborted(); owned.add(transport); this.transport = transport; this.limits = { maxCalls, maxCallTimeoutMs };
    const forward = () => this.dispose(); signal.addEventListener('abort', forward, { once: true });
    if (signal.aborted) forward();
    const input = transport.incomingStreams[Symbol.asyncIterator]();
    const closeInput = () => {
      try {
        this.inputRetirement = Promise.resolve(input.return?.());
      } catch (error) {
        this.inputRetirement = Promise.reject(error);
      }
      // The receive loop ending does not imply that return() finished cleanup.
      // Observe now and propagate failures through the explicit retirement join.
      void this.inputRetirement.catch(() => {});
    };
    this.stop.signal.addEventListener('abort', closeInput, { once: true });
    if (this.stop.signal.aborted) closeInput();
    void transport.closed.then(() => this.dispose(), error => {
      this.failure = error; this.dispose();
    });
    this.closed = (async () => {
      try {
        while (!this.stop.signal.aborted) {
          const next = await input.next(); if (next.done) break;
          if (this.stop.signal.aborted || this.calls.size + this.opening >= maxCalls) {
            this.discardDuplex({ duplex: next.value, reason: 'RPC capacity or shutdown' }); continue;
          }
          try {
            this.adopt({ duplex: next.value, role: 'callee', timeoutMs: maxCallTimeoutMs });
          } catch {
            this.discardDuplex({ duplex: next.value, reason: 'RPC transport ownership failed' });
          }
        }
      } catch (error) {
        if (!this.stop.signal.aborted) this.failure = error;
      } finally {
        this.dispose(); signal.removeEventListener('abort', forward); this.stop.signal.removeEventListener('abort', closeInput);
      }
      if (this.failure) throw this.failure;
    })();
    void this.closed.catch(() => {});
  }
  /** Until adoption succeeds, the peer still owns disposal of this duplex.
   * Cleanup failures poison retirement; they are not ordinary call failures.
   * Do not release the manager's transport lease on an unconfirmed abort. */
  private discardDuplex({ duplex, reason }: { duplex: NaidanRpcDuplex; reason: string }): void {
    try {
      duplex.abort({ reason });
    } catch (error) {
      this.retirementFailure ??= { error }; this.dispose();
    }
  }
  private lookup({ contract, method }: { contract: string; method: string }): PreparedMethod {
    const exposure = this.methods.get(contract);
    const result = exposure?.methods.get(method);
    if (!result) throw new NaidanRpcError({ code: 'METHOD_NOT_FOUND' });
    if (!exposure?.allowed.has(method) || (this.incomingAdmission === 'suspended' && !this.allowedWhileSuspended.get(contract)?.has(method))) throw new NaidanRpcError({ code: 'METHOD_NOT_ALLOWED' });
    return result;
  }
  /** Pause new inbound calls while local policy is being revalidated. Already
   * admitted calls retain their lifetime; actual revocations use setAllowedMethods. */
  setIncomingAdmission({ status }: { status: 'open' | 'suspended' }): void {
    this.stop.signal.throwIfAborted(); this.incomingAdmission = status;
  }
  /** A narrowly registered status method may remain callable during policy
   * checks. This never grants authority or bypasses revocation and teardown. */
  allowIncomingWhileSuspended<C extends Contract>({ contract, allowedMethods }: {
    contract: C; allowedMethods: readonly NaidanRpcMethodName<NoInfer<C>>[];
  }): void {
    this.stop.signal.throwIfAborted();
    const exposure = this.methods.get(contract.name);
    check({ condition: exposure?.contract === contract, code: 'INVALID_ARGUMENT' });
    this.allowedWhileSuspended.set(contract.name, checkAllowedMethods({ contract, allowedMethods }));
  }
  /** Local authority only. Updating grants never calls, reconnects or replays. */
  setAllowedMethods<C extends Contract>({ contract, allowedMethods }: {
    contract: C; allowedMethods: readonly NaidanRpcMethodName<NoInfer<C>>[];
  }): void {
    this.stop.signal.throwIfAborted();
    const exposure = this.methods.get(contract.name);
    check({ condition: exposure?.contract === contract, code: 'INVALID_ARGUMENT' });
    if (!exposure) throw new NaidanRpcError({ code: 'INVALID_ARGUMENT' });
    const next = checkAllowedMethods({ contract, allowedMethods });
    const removed = new Set([...exposure.allowed].filter(name => !next.has(name)));
    exposure.allowed = next;
    for (const call of this.calls) call.revokeMethods({ contract: contract.name, removed });
  }
  private adopt({ duplex, role, timeoutMs }: { duplex: NaidanRpcDuplex; role: 'caller' | 'callee'; timeoutMs: number | undefined }): RpcConversation {
    const call = new RpcConversation({ duplex, role, timeoutMs, resolveMethod: ({ contract, method }) => this.lookup({ contract, method }) });
    this.calls.add(call);
    // Native/user work that ignores cancellation keeps its reservation until its promise settles.
    void call.retired.promise.then(() => this.calls.delete(call), error => {
      // Keep a failed adopted stream's cleanup in the peer's final outcome even
      // after its call leaves the active set. Do not reopen capacity on failure.
      this.retirementFailure ??= { error }; this.dispose(); this.calls.delete(call);
    }); return call;
  }
  client<C extends Contract>({ contract }: { contract: C }): NaidanRpcClient<C> {
    const methods: Record<string, unknown> = {};
    for (const [method, definition] of Object.entries(contract.methods)) {
      const prepared = prepareMethod({ method: definition, handler: undefined });
      methods[method] = ({ input, on, signal, timeoutMs }: {
        input: unknown; on: Readonly<Record<string, Observer | undefined>>; signal: AbortSignal | undefined; timeoutMs: number | undefined;
      }) => this.invoke({ contract: contract.name, method, prepared, input, on, signal, timeoutMs });
    }
    // The closed contract was checked before generating these local stubs.
    return Object.freeze(methods) as NaidanRpcClient<C>;
  }
  private invoke({ contract, method, prepared, input, on, signal, timeoutMs }: {
    contract: string; method: string; prepared: PreparedMethod; input: unknown; on: Readonly<Record<string, Observer | undefined>>;
    signal: AbortSignal | undefined; timeoutMs: number | undefined;
  }) {
    if (timeoutMs !== undefined) duration({ milliseconds: timeoutMs });
    const result = deferred<unknown>(), closed = deferred<void>(), stop = new AbortController();
    let conversation: RpcConversation | undefined;
    const terminate = ({ code }: { code: 'CANCELLED' | 'DEADLINE_EXCEEDED' }) => {
      const error = stop.signal.aborted ? stop.signal.reason : new NaidanRpcError({ code });
      // User-visible cancellation is independent of the lower open's physical
      // lifetime. Retain its reservation and retirement task until the late
      // duplex is aborted, but never make the caller wait for an ignoring opener.
      result.reject(error); closed.reject(error);
      if (!stop.signal.aborted) stop.abort(error);
      conversation?.abort({ code });
    };
    const parent = () => terminate({ code: 'CANCELLED' });
    this.stop.signal.addEventListener('abort', parent, { once: true }); signal?.addEventListener('abort', parent, { once: true });
    if (this.stop.signal.aborted || signal?.aborted) parent();
    const allotted = Math.min(timeoutMs ?? Infinity, this.limits.maxCallTimeoutMs ?? Infinity), until = performance.now() + allotted;
    const timer = Number.isFinite(allotted) ? setTimeout(() => terminate({ code: 'DEADLINE_EXCEEDED' }), allotted) : undefined;
    let reserved = false;
    let unadopted: NaidanRpcDuplex | undefined;
    // Install ownership before pack/openStream can invoke trusted callbacks.
    // A lower transport may finish opening after cancellation; retirement must
    // wait until that late duplex has been aborted, not merely count live calls.
    const invocationRetired = deferred<void>();
    this.pendingInvocations.add(invocationRetired.promise);
    const task = async () => {
      try {
        stop.signal.throwIfAborted();
        check({ condition: this.calls.size + this.opening < this.limits.maxCalls, code: 'RESOURCE_EXHAUSTED' });
        let next = 1;
        const packed = pack({ plan: prepared.input, value: input, allocate: () => {
          const id = next; next += 2; return id;
        } });
        this.opening++; reserved = true;
        const duplex = await this.transport.openStream({ signal: stop.signal });
        unadopted = duplex;
        if (stop.signal.aborted || performance.now() >= until) {
          stop.signal.throwIfAborted(); throw new NaidanRpcError({ code: 'DEADLINE_EXCEEDED' });
        }
        this.opening--; reserved = false;
        conversation = this.adopt({ duplex, role: 'caller', timeoutMs: Number.isFinite(until) ? Math.max(1, Math.ceil(until - performance.now())) : undefined });
        unadopted = undefined;
        conversation.start({ contract, method, prepared, packed, on, timeoutMs: Number.isFinite(allotted) ? allotted : undefined });
        void conversation.result.promise.then(result.resolve, result.reject);
        await conversation.closed.promise; closed.resolve();
      } catch (error) {
        result.reject(error); closed.reject(error);
      } finally {
        // A constructor/lock acquisition can fail after openStream succeeded.
        // Such a duplex is not in calls and must not escape this owner.
        if (unadopted) this.discardDuplex({ duplex: unadopted, reason: 'RPC opening ended before adoption' });
        if (reserved) this.opening--;
        clearTimeout(timer); this.stop.signal.removeEventListener('abort', parent); signal?.removeEventListener('abort', parent);
        this.pendingInvocations.delete(invocationRetired.promise); invocationRetired.resolve();
      }
    };
    void task();
    return { result: result.promise, closed: closed.promise, cancel: ({ reason }: { reason: string }) => {
      void reason; terminate({ code: 'CANCELLED' });
    } };
  }
  /** Abort is a protocol state, not proof that native work has stopped. The
   * connection owner awaits this barrier before releasing shared ownership. */
  async retire(): Promise<void> {
    this.dispose();
    // No new invocation can be adopted after dispose. Join both the iterator
    // and pending opens as well as native/callback work in already adopted calls.
    const results = await Promise.allSettled([this.closed.catch(() => {}), this.inputRetirement, ...this.pendingInvocations, ...[...this.calls].map(call => call.retired.promise)]);
    for (const result of results) {
      switch (result.status) {
      case 'fulfilled': break;
      case 'rejected': throw result.reason;
      default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
      }
    }
    if (this.retirementFailure) throw this.retirementFailure.error;
  }
  /** Stops owned calls and the exclusive iterator, not the borrowed transport's entire session. */
  dispose(): void {
    if (this.stop.signal.aborted) return;
    this.allowedWhileSuspended.clear();
    this.stop.abort(); for (const call of this.calls) call.abort({ code: 'CANCELLED' }); this.methods.clear();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
