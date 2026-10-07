import { z } from 'zod';
import { check, validName } from '@/features/naidan-rpc/primitives';
import { compile } from '@/features/naidan-rpc/schema';
import type { Finite, Plan, ReceiveValue, SendValue } from '@/features/naidan-rpc/schema';

export type Notifications = Readonly<Record<string, z.ZodType<Finite>>>;
export type Procedure = { readonly input: z.ZodType; readonly result: z.ZodType; readonly notifications: Notifications };
export function procedure<I extends z.ZodType, R extends z.ZodType, const N extends Notifications>({ input, result, notifications }: {
  input: I; result: R; notifications: N;
}) {
  compile({ schema: input, capabilitiesAllowed: true, callbacksAllowed: true });
  compile({ schema: result, capabilitiesAllowed: true, callbacksAllowed: false });
  check({ condition: Object.keys(notifications).length <= 8, code: 'INVALID_ARGUMENT' });
  for (const [name, schema] of Object.entries(notifications)) {
    check({ condition: validName({ name }), code: 'INVALID_ARGUMENT' });
    compile({ schema, capabilitiesAllowed: false, callbacksAllowed: false });
  }
  return Object.freeze({ input, result, notifications: Object.freeze({ ...notifications }) });
}
export type Contract = { readonly name: string; readonly methods: Readonly<Record<string, Procedure>> };
export function contract<const M extends Readonly<Record<string, Procedure>>>({ name, methods }: { name: string; methods: M }) {
  check({ condition: validName({ name }) && Object.keys(methods).length <= 64, code: 'INVALID_ARGUMENT' });
  for (const method of Object.keys(methods)) check({ condition: validName({ name: method }), code: 'INVALID_ARGUMENT' });
  return Object.freeze({ name, methods: Object.freeze({ ...methods }) });
}
export type Notify<N extends Notifications> = keyof N extends never ? Record<PropertyKey, never> : {
  readonly [K in keyof N]: ({ value }: { value: SendValue<N[K]> }) => void;
};
export type Observe<N extends Notifications> = keyof N extends never ? Record<PropertyKey, never> : {
  readonly [K in keyof N]: (({ value }: { value: ReceiveValue<N[K]> }) => void | Promise<void>) | undefined;
};
export type NaidanRpcImplementation<C extends Contract> = {
  readonly [K in keyof C['methods']]: ({ input, notify, signal }: {
    input: ReceiveValue<C['methods'][K]['input']>; notify: Notify<C['methods'][K]['notifications']>; signal: AbortSignal;
  }) => SendValue<C['methods'][K]['result']> | Promise<SendValue<C['methods'][K]['result']>>;
};
export type NaidanRpcCall<T> = { readonly result: Promise<T>; readonly closed: Promise<void>; cancel({ reason }: { reason: string }): void };
export type NaidanRpcClient<C extends Contract> = {
  readonly [K in keyof C['methods']]: ({ input, on, signal, timeoutMs }: {
    input: SendValue<C['methods'][K]['input']>; on: Observe<C['methods'][K]['notifications']>;
    signal: AbortSignal | undefined; timeoutMs: number | undefined;
  }) => NaidanRpcCall<ReceiveValue<C['methods'][K]['result']>>;
};
export type Handler = ({ input, notify, signal }: {
  input: unknown; notify: Readonly<Record<string, ({ value }: { value: unknown }) => void>>; signal: AbortSignal;
}) => unknown | Promise<unknown>;
export type PreparedMethod = { input: Plan; result: Plan; notifications: ReadonlyMap<string, Plan>; handler: Handler | undefined };
export type NaidanRpcMethodName<C extends Contract> = Extract<keyof C['methods'], string>;
export type NaidanRpcExposure = {
  readonly name: string;
  readonly contract: Contract;
  readonly methods: ReadonlyMap<string, PreparedMethod>;
  readonly allowedMethods: ReadonlySet<string>;
};
/** Names are derived from the same closed contract used by both endpoints. */
export function methodNames<C extends Contract>({ contract }: { contract: C }): readonly NaidanRpcMethodName<C>[] {
  return Object.freeze(Object.keys(contract.methods)) as readonly NaidanRpcMethodName<C>[];
}
export function checkAllowedMethods<C extends Contract>({ contract, allowedMethods }: {
  contract: C; allowedMethods: readonly NaidanRpcMethodName<NoInfer<C>>[];
}): ReadonlySet<string> {
  check({ condition: Array.isArray(allowedMethods) && allowedMethods.length <= 64, code: 'INVALID_ARGUMENT' });
  const names = new Set<string>();
  for (const name of allowedMethods) {
    check({ condition: typeof name === 'string' && Object.hasOwn(contract.methods, name) && !names.has(name), code: 'INVALID_ARGUMENT' });
    names.add(name);
  }
  return names;
}
export function prepareMethod({ method, handler }: { method: Procedure; handler: Handler | undefined }): PreparedMethod {
  const { input, result, notifications, ...rest } = method; rest satisfies Record<PropertyKey, never>;
  return {
    input: compile({ schema: input, capabilitiesAllowed: true, callbacksAllowed: true }),
    result: compile({ schema: result, capabilitiesAllowed: true, callbacksAllowed: false }),
    notifications: new Map(Object.entries(notifications).map(([name, schema]) =>
      [name, compile({ schema, capabilitiesAllowed: false, callbacksAllowed: false })])),
    handler,
  };
}
export function expose<C extends Contract>({ contract, implementation, allowedMethods }: {
  contract: C; implementation: NaidanRpcImplementation<NoInfer<C>>;
  allowedMethods: readonly NaidanRpcMethodName<NoInfer<C>>[];
}): NaidanRpcExposure {
  const allowed = checkAllowedMethods({ contract, allowedMethods });
  const names = Object.keys(contract.methods);
  check({ condition: names.length === Object.keys(implementation).length, code: 'INVALID_ARGUMENT' });
  const methods = new Map<string, PreparedMethod>();
  for (const name of names) {
    check({ condition: Object.hasOwn(implementation, name), code: 'INVALID_ARGUMENT' });
    const handler = implementation[name];
    check({ condition: typeof handler === 'function', code: 'INVALID_ARGUMENT' });
    // Type erasure stays at the local registration boundary. Wire values are checked by the saved plan.
    methods.set(name, prepareMethod({ method: contract.methods[name]!, handler: handler as Handler }));
  }
  return Object.freeze({ name: contract.name, contract, methods, allowedMethods: allowed });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
