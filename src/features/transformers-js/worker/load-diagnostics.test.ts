// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { applyTransformersJsFixes } from '../../../../build/transformers-js-fixes/transform';
import { createLoadDiagnosticLedger, createLoadDiagnosticOperation, loadDiagnosticsSchema, type LoadDiagnosticPacket } from './load-diagnostics';

// The application-side test owns the transformed producer → Worker ledger
// connection. Build-only tests must not import application runtime contracts.
const original = readFileSync('node_modules/@huggingface/transformers/dist/transformers.web.js', 'utf8');
const transformed = applyTransformersJsFixes({ code: original, version: '4.2.0' }).code;
function session({ observer, failure }: { observer: unknown; failure: unknown }): () => Promise<unknown> {
  const observerStart = transformed.indexOf('function naidanCreateModelLoadObserver(');
  const observerEnd = transformed.indexOf('\nasync function readResponse(', observerStart);
  const sessionStart = transformed.indexOf('async function createInferenceSession(');
  const sessionEnd = transformed.indexOf('\nvar webInferenceChain', sessionStart);
  if (observerStart < 0 || observerEnd <= observerStart || sessionStart < 0 || sessionEnd <= sessionStart) throw new Error('Missing pinned diagnostic/session boundaries');
  // Actual transformed observer and session functions; only native ORT is tiny.
  return new Function('env', 'failure', `
    const apis = { IS_WEB_ENV: true }; let webInitChain = Promise.resolve();
    const LogLevel = { WARNING: 1 }; const getOnnxLogSeverityLevel = () => 1;
    const ensureWasmLoaded = async () => {}; const InferenceSession = { create: async () => { throw failure; } };
    ${transformed.slice(observerStart, observerEnd)}
    ${transformed.slice(sessionStart, sessionEnd)}
    return () => createInferenceSession(new Uint8Array([1]), {}, {});
  `)({ naidanModelLoadObserver: observer }, failure) as () => Promise<unknown>;
}

it.each([
  ['missing-webgpu-entrypoint', new TypeError('Sl().webgpuInit is not a function')],
  ['invalid-wasm-magic', new WebAssembly.CompileError("module doesn't start with '\\0asm'")],
  ['prior-initialization-failure', new Error("previous call to 'initWasm()' failed")],
  ['unclassified', new Error('Synthetic unrecognized failure /private/example?token=synthetic')],
  ['unclassified', new Error('webgpuInit is not a function' + 'x'.repeat(4096))],
] as const)('retains only the %s category through the actual observer and host ledger', async (category, failure) => {
  const owner = { runId: 'synthetic-classification', workerEpoch: 1 };
  const ledger = createLoadDiagnosticLedger({ owner });
  const operation = createLoadDiagnosticOperation({ owner, loadOrdinal: 1, resourceNames: 'omit', sink: ({ packet }) => ledger.observe({ packet }) });
  const observe = operation.beginCandidate({ device: 'webgpu', dtype: 'q4', revision: undefined });
  await expect(session({ observer: observe, failure })()).rejects.toBe(failure);
  const snapshot = ledger.snapshot({ expectedLoadCount: 1 });
  expect(snapshot.events.map(event => event.kind)).toEqual(['candidate-start', 'session-preparing', 'session-entering', 'session-rejected']);
  expect(snapshot.events.at(-1)).toMatchObject({ candidateOrdinal: 1, errorCategory: category });
  expect(JSON.stringify(snapshot)).not.toContain(failure.message);
  expect(JSON.stringify(snapshot)).not.toContain('stack');
});

it('does not invoke message accessors or allow classification and observer failures to replace the native exception', async () => {
  const getter = vi.fn(() => {
    throw new Error('Diagnostic getter');
  });
  const failure = Object.defineProperty(new Error(), 'message', { get: getter });
  const events: unknown[] = [];
  await expect(session({ observer: (event: unknown) => events.push(event), failure })()).rejects.toBe(failure);
  expect(getter).not.toHaveBeenCalled();
  expect(events.at(-1)).toMatchObject({ phase: 'session-rejected', errorCategory: 'unclassified' });
  const inaccessible = new Proxy({}, { getOwnPropertyDescriptor() {
    throw new Error('Diagnostic proxy');
  } });
  await expect(session({ observer: (event: unknown) => events.push(event), failure: inaccessible })()).rejects.toBe(inaccessible);
  expect(events.at(-1)).toMatchObject({ errorCategory: 'unclassified' });
  await expect(session({ observer: (event: unknown) => events.push(event), failure: "previous call to 'initWasm()' failed" })()).rejects.toBe("previous call to 'initWasm()' failed");
  expect(events.at(-1)).toMatchObject({ errorCategory: 'prior-initialization-failure' });
  for (const observer of [undefined, () => {
    throw new Error('Observer');
  }, () => Promise.reject(new Error('Observer')), () => new Promise(() => {})]) {
    await expect(session({ observer, failure })()).rejects.toBe(failure);
  }
  await new Promise<void>(resolve => setImmediate(resolve));
});

const owner = { runId: 'synthetic-load-diagnostics', workerEpoch: 1 };
const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
it('keeps legacy category absence unobserved and drops an invalid optional classification without losing the event', () => {
  const { ledger, operation } = setup();
  const observe = operation.beginCandidate({ device: 'wasm', dtype: 'q4', revision });
  observe({ token: {}, kind: 'session', phase: 'session-rejected', bytes: 0, errorName: 'Error' });
  observe({ token: {}, kind: 'session', phase: 'session-rejected', bytes: 0, errorName: 'Error', errorCategory: 'arbitrary private message' });
  const snapshot = ledger.snapshot({ expectedLoadCount: 1 });
  expect(snapshot.events.filter(event => event.kind === 'session-rejected')).toHaveLength(2);
  for (const event of snapshot.events) expect(event).not.toHaveProperty('errorCategory');
  expect(loadDiagnosticsSchema.safeParse(snapshot).success).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain('private message');
});
function setup() {
  const ledger = createLoadDiagnosticLedger({ owner });
  const packets: LoadDiagnosticPacket[] = [];
  const operation = createLoadDiagnosticOperation({ owner, loadOrdinal: 1, resourceNames: 'public-repository', sink: ({ packet }) => {
    packets.push(packet); ledger.observe({ packet });
  } });
  return { ledger, operation, packets };
}

it('records precise requests without reading bodies and never interprets completion as GC', () => {
  const { ledger, operation } = setup();
  const observe = operation.beginCandidate({ device: 'webgpu', dtype: 'q4f16', revision });
  const token = {};
  for (const phase of ['allocation-attempt', 'allocation-succeeded', 'read-start', 'read-returned'] as const) {
    observe({ token, kind: 'read', resource: 'onnx/model.onnx', phase, bytes: 257 });
  }
  operation.closeCandidate();
  operation.emit({ kind: 'load-finished', details: {} });
  const snapshot = ledger.snapshot({ expectedLoadCount: 1 });
  expect(loadDiagnosticsSchema.safeParse(snapshot).success).toBe(true);
  expect(snapshot.events[0]).toMatchObject({ kind: 'candidate-start', revision });
  expect(snapshot.events.at(-1)).toMatchObject({ candidateScopeAllocatedBytes: 257, returnedReadBufferBytes: 257, activeReadCount: 0, scope: 'closed' });
  expect(snapshot.incompleteReasons).toEqual([]);
  expect(JSON.stringify(snapshot)).not.toContain('token');
});

it('marks dropped previous-candidate events without assigning them to a subsequent candidate', () => {
  const { ledger, operation } = setup();
  const previous = operation.beginCandidate({ device: 'webgpu', dtype: 'q4f16', revision });
  operation.closeCandidate();
  operation.beginCandidate({ device: 'wasm', dtype: 'q4', revision });
  previous({ token: {}, kind: 'read', resource: 'onnx/model.onnx', phase: 'allocation-attempt', bytes: 257 });
  operation.emit({ kind: 'load-failed', details: {} });
  const snapshot = ledger.snapshot({ expectedLoadCount: 1 });
  expect(snapshot.events.filter(event => event.kind === 'allocation-attempt')).toEqual([]);
  expect(snapshot.incompleteReasons).toContain('invalid-event');
});

it('reports an event limit within its bounded output instead of silently truncating', () => {
  const { ledger, operation } = setup();
  for (let index = 0; index < 1000; index++) operation.emit({ kind: 'load-start', details: {} });
  const snapshot = ledger.snapshot({ expectedLoadCount: 1 });
  expect(snapshot.events).toHaveLength(512);
  expect(snapshot.events.at(-1)?.kind).toBe('diagnostic-incomplete');
  expect(snapshot.incompleteReasons).toContain('event-limit');
});

it('reports resource limits without retaining a body or buffer', () => {
  const { ledger, operation } = setup();
  const observe = operation.beginCandidate({ device: 'webgpu', dtype: 'q4f16', revision });
  for (let index = 0; index < 140; index++) observe({ token: {}, kind: 'read', resource: 'onnx/model.onnx', phase: 'allocation-attempt', bytes: 1 });
  operation.emit({ kind: 'load-failed', details: {} });
  const snapshot = ledger.snapshot({ expectedLoadCount: 1 });
  expect(snapshot.events.filter(event => event.kind === 'allocation-attempt')).toHaveLength(128);
  expect(snapshot.incompleteReasons).toContain('resource-limit');
});

it('rejects foreign ownership and never mutates an already returned host snapshot', () => {
  const { ledger, operation, packets } = setup();
  operation.emit({ kind: 'load-start', details: {} });
  const first = ledger.snapshot({ expectedLoadCount: 1 });
  ledger.observe({ packet: { ...packets[0], owner: { ...owner, runId: 'foreign' } } });
  operation.emit({ kind: 'load-failed', details: {} });
  expect(first.events).toHaveLength(1);
  expect(ledger.snapshot({ expectedLoadCount: 1 }).events).toHaveLength(2);
  expect(ledger.snapshot({ expectedLoadCount: 1 }).incompleteReasons).toContain('invalid-event');
});

it('reports an unobserved requested Load rather than claiming an empty successful trace', () => {
  const ledger = createLoadDiagnosticLedger({ owner });
  expect(ledger.snapshot({ expectedLoadCount: 1 }).incompleteReasons).toContain('unobserved-load');
});

it('rejects duplicate sequence and marks gaps while retaining subsequent partial evidence', () => {
  const { ledger, operation, packets } = setup();
  operation.emit({ kind: 'load-start', details: {} });
  ledger.observe({ packet: packets[0] });
  ledger.observe({ packet: { ...packets[0], event: { ...packets[0]!.event, sequence: 3, kind: 'load-failed' } } });
  const snapshot = ledger.snapshot({ expectedLoadCount: 1 });
  expect(snapshot.events.map(event => event.sequence)).toEqual([1, 3]);
  expect(snapshot.incompleteReasons).toEqual(['invalid-event']);
});

it('derives transient snapshot reasons without poisoning a later completed Load', () => {
  const { ledger, operation } = setup();
  const initial = ledger.snapshot({ expectedLoadCount: 1 });
  operation.emit({ kind: 'load-start', details: {} });
  const running = ledger.snapshot({ expectedLoadCount: 1 });
  operation.emit({ kind: 'load-finished', details: {} });
  expect(initial.incompleteReasons).toEqual(['unobserved-load']);
  expect(running.incompleteReasons).toEqual(['load-not-settled']);
  expect(ledger.snapshot({ expectedLoadCount: 1 }).incompleteReasons).toEqual([]);
});

it('omits local artifact names even when they use otherwise safe characters', () => {
  const ledger = createLoadDiagnosticLedger({ owner });
  const operation = createLoadDiagnosticOperation({ owner, loadOrdinal: 1, resourceNames: 'omit', sink: ({ packet }) => ledger.observe({ packet }) });
  const observe = operation.beginCandidate({ device: 'webgpu', dtype: 'q4f16', revision });
  observe({ token: {}, kind: 'read', resource: 'private-model.onnx', phase: 'allocation-attempt', bytes: 257 });
  const snapshot = ledger.snapshot({ expectedLoadCount: 1 });
  expect(snapshot.events.at(-1)).toMatchObject({ kind: 'allocation-attempt', requestedBytes: 257 });
  expect(JSON.stringify(snapshot)).not.toContain('private-model');
});

it.each(['throw', 'reject'] as const)('reports a recovered %s transport failure in the next delivered packet', async mode => {
  const ledger = createLoadDiagnosticLedger({ owner });
  let deliveries = 0;
  const operation = createLoadDiagnosticOperation({ owner, loadOrdinal: 1, resourceNames: 'public-repository', sink: ({ packet }) => {
    if (++deliveries > 1) return ledger.observe({ packet });
    if (mode === 'throw') throw new Error('Sink failure');
    return Promise.reject(new Error('Sink failure'));
  } });
  operation.emit({ kind: 'load-start', details: {} });
  await Promise.resolve();
  operation.emit({ kind: 'load-failed', details: {} });
  expect(ledger.snapshot({ expectedLoadCount: 1 }).incompleteReasons).toContain('transport-failed');
});

it('does not throw or reject Load for synchronous or asynchronous diagnostic sink failures', async () => {
  for (const mode of ['throw', 'reject'] as const) {
    const operation = createLoadDiagnosticOperation({ owner, loadOrdinal: 1, resourceNames: 'public-repository', sink: () => {
      if (mode === 'throw') throw new Error('Sink failed');
      return Promise.reject(new Error('Sink rejected'));
    } });
    expect(() => operation.emit({ kind: 'load-start', details: {} })).not.toThrow();
    await Promise.resolve();
  }
});
