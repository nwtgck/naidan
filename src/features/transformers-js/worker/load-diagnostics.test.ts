import { expect, it } from 'vitest';
import { createLoadDiagnosticLedger, createLoadDiagnosticOperation, loadDiagnosticsSchema, type LoadDiagnosticPacket } from './load-diagnostics';

const owner = { runId: 'synthetic-load-diagnostics', workerEpoch: 1 };
const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
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
