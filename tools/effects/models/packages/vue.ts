import type ts from 'typescript';
import type { ContractOwner, FunctionValue, Value } from '../../analysis/values.ts';
import { SCALAR, UNKNOWN } from '../../analysis/values.ts';
import { isNativeValue, isScalarValue, isRecordValue, isFunctionValue } from '../../analysis/value-guards.ts';
import type { NativeModelContext } from '../invoke.ts';

/** Exact reviewed declaration files; name matching is used only after identity resolution. */
export type VueEffectModel = { file: string, sha256: string };

const operationNames = [
  'ref', 'shallowRef', 'watch', 'watchEffect', 'watchSyncEffect', 'watchPostEffect',
  'onMounted', 'onBeforeMount', 'onUnmounted', 'onBeforeUnmount', 'onUpdated', 'onBeforeUpdate',
  'onActivated', 'onDeactivated', 'onScopeDispose', 'onWatcherCleanup',
] as const;
const operations: ReadonlySet<string> = new Set(operationNames);

export function isVueOperation(name: string): name is typeof operationNames[number] {
  return operations.has(name);
}

export function isScalarRefName(name: string): name is 'vue:scalar-ref' | 'vue:unverified-ref' {
  return name === 'vue:scalar-ref' || name === 'vue:unverified-ref';
}

/**
 * Registration carries the callback's upper bound. State setters never acquire a
 * graph edge to subscribers. This is an explicit review boundary, not a claim that
 * a synchronous watcher cannot execute during assignment.
 */
export function evaluateVue({ context, callable, args, owner, node }: {
  context: NativeModelContext, callable: Extract<Value, { kind: 'native' }>, args: readonly Value[],
  owner: ContractOwner | undefined, node: ts.Node,
}): Value {
  const fail = ({ message }: { message: string }): Value => {
    context.issue({ node, code: 'unsupported', message }); return UNKNOWN;
  };
  const checkCallback = ({ value, arguments_: inputs, maximumParameters, region }: {
    value: Value | undefined, arguments_: readonly Value[], maximumParameters: number, region: 'inherited' | 'isolated',
  }): FunctionValue | undefined => {
    if (value?.kind !== 'function' || value.transport !== 'local' || value.owner.role === 'symbolic'
      || value.parameters.length > maximumParameters) {
      fail({ message: 'Vue registration requires a fixed local callback contract with supported parameters; generic callback forwarding and positional cleanup are not modeled.' });
      return undefined;
    }
    context.observeVueCallback({ callable: value, node });
    const result = (() => {
      switch (region) {
      case 'isolated': return context.invokeDetached({ callable: value, args: inputs, owner, node });
      case 'inherited': return context.invoke({ callable: value, args: inputs, owner, node });
      default: { const exhaustive: never = region; throw new Error(String(exhaustive)); }
      }
    })();
    // Vue handles rejected native Promises but arbitrary thenables/getters are not
    // assumed to be passive. Check even when nobody awaits the registration.
    context.settle({ value: result, node });
    return value;
  };
  const options = ({ value }: { value: Value | undefined }): void => {
    if (value === undefined) return;
    if (!isRecordValue(value)) {
      fail({ message: 'Vue watcher options require a checked own-property record.' }); return;
    }
    const actual = isRecordValue(value.reflected) ? value.reflected : value;
    switch (actual.shape) {
    case 'open': fail({ message: 'Vue watcher options may contain hidden debug callbacks or accessors.' }); break;
    case 'closed': break;
    default: { const exhaustive: never = actual.shape; throw new Error(String(exhaustive)); }
    }
    for (const [key, field] of actual.fields) {
      if (!['immediate', 'deep', 'flush', 'once'].includes(key) || !isScalarValue(field.value)) {
        fail({ message: `Unmodeled Vue watcher option: ${key}. Debug callbacks must not be silently ignored.` });
      }
    }
  };
  const name = callable.name.slice('vue:'.length);
  switch (name) {
  case 'ref': case 'shallowRef': {
    if (args.length > 1 || args.some(argument => !isScalarValue(argument))) return fail({ message: 'The initial Vue creation model supports scalar refs only; object conversion, nested refs and custom refs require separate models.' });
    // Literal-key evidence must not survive later .value assignments.
    return context.native({ name: 'vue:scalar-ref', receiver: SCALAR });
  }
  case 'watch': {
    if (args.length < 2 || args.length > 3) return fail({ message: 'Unsupported Vue watch signature.' });
    const callbacks = new Map<string, { value: Value, access: 'readonly' }>();
    const source = args[0];
    if (!(source !== undefined && isNativeValue(source) && source.name === 'vue:scalar-ref')) {
      const getter = checkCallback({ value: source, arguments_: [], maximumParameters: 0, region: 'inherited' });
      if (getter !== undefined) {
        if (!isScalarValue(getter.returns)) fail({ message: 'Vue watch getter sources must return scalars in this model.' });
        callbacks.set('source', { value: getter, access: 'readonly' });
      }
    }
    const callback = checkCallback({ value: args[1], arguments_: [SCALAR, SCALAR], maximumParameters: 2, region: 'isolated' });
    if (callback !== undefined) callbacks.set('callback', { value: callback, access: 'readonly' });
    options({ value: args[2] });
    return context.native({ name: 'vue:watch-handle', receiver: { kind: 'record', fields: callbacks, shape: 'closed', reflected: undefined, indexValue: undefined } });
  }
  case 'watchEffect': case 'watchSyncEffect': case 'watchPostEffect': {
    if (args.length < 1 || args.length > 2) return fail({ message: 'Unsupported Vue watchEffect signature.' });
    const callback = checkCallback({ value: args[0], arguments_: [], maximumParameters: 0, region: 'isolated' });
    options({ value: args[1] });
    return context.native({ name: 'vue:watch-handle', receiver: callback });
  }
  case 'onMounted': case 'onBeforeMount': case 'onUnmounted': case 'onBeforeUnmount':
  case 'onUpdated': case 'onBeforeUpdate': case 'onActivated': case 'onDeactivated':
  case 'onScopeDispose': case 'onWatcherCleanup': {
    if (args.length !== 1) return fail({ message: 'Only default-scope Vue callback registration is modeled.' });
    const callback = checkCallback({ value: args[0], arguments_: [], maximumParameters: 0, region: 'isolated' });
    if (name === 'onWatcherCleanup' && callback !== undefined) {
      context.registerWatcherCleanup({ callback, owner, node });
    }
    return SCALAR;
  }
  case 'watch-handle': case 'handle-stop': case 'handle-resume': case 'handle-pause': {
    if (args.length !== 0) return fail({ message: 'Vue watch handles do not accept arguments.' });
    // stop runs registered cleanup, not the source getter or ordinary callback.
    // resume can run a pending job; pause itself does not run that job.
    const callbacks = isRecordValue(callable.receiver) ? [...callable.receiver.fields].map(([key, field]) => ({ key, value: field.value })) : [{ key: 'callback', value: callable.receiver }];
    switch (name) {
    case 'handle-pause': break;
    case 'watch-handle': case 'handle-stop': {
      const callback = isRecordValue(callable.receiver) ? callable.receiver.fields.get('callback')?.value : callable.receiver;
      if (!isFunctionValue(callback)) return fail({ message: 'The Vue watch handle lost its callback contract.' });
      context.consumeWatcherCleanup({ callback, owner, node });
      break;
    }
    case 'handle-resume':
      for (const entry of callbacks) {
        const callback = entry.value;
        if (!isFunctionValue(callback)) return fail({ message: 'The Vue watch handle lost its callback contract.' });
        checkCallback({ value: callback, arguments_: callback.parameters.map(() => SCALAR), maximumParameters: 2, region: entry.key === 'source' ? 'inherited' : 'isolated' });
      }
      break;
    default: { const exhaustive: never = name; throw new Error(String(exhaustive)); }
    }
    return SCALAR;
  }
  default: return fail({ message: `No callable Vue boundary model for ${name}.` });
  }
}
