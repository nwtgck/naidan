// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { visionBf16Metadata } from './vision-bf16-storage.test-support';
import type { VisionBf16Diagnostics } from './vision-bf16-diagnostics';
import type { VisionBf16LoadReport } from './vision-bf16-storage-schema';

const onProjector = () => {};

const host = vi.hoisted(() => ({ schema: undefined as unknown }));
vi.mock('llama-cpp-browser-core/llama-cpp/api/schema.mjs', () => ({
  get default() {
    return host.schema;
  },
}));

beforeEach(() => {
  vi.resetModules();
  host.schema = structuredClone(visionBf16Metadata);
});

function fixture({ requested }: { requested: number }) {
  const version = vi.fn(async () => 1), initialize = vi.fn(async () => 700n), query = vi.fn(async () => requested), legacy = vi.fn(async () => 900n);
  const constants: Record<string, number> = { MTMD_VISION_BF16_STORAGE_INVALID: -1, MTMD_VISION_BF16_STORAGE_LEGACY_EXPAND: 0, MTMD_VISION_BF16_STORAGE_RETAIN_CHECKED: 1 };
  const constant = vi.fn(({ name }: { name: string }) => {
    const value = constants[name];
    if (value === undefined) {
      throw new Error('Unknown fixture constant');
    }
    return value;
  });
  const module: Record<string, unknown> = { _mtmd_vision_bf16_storage_version() {}, _bicore_mtmd_init_from_file_with_vision_bf16_storage() {}, _mtmd_context_vision_bf16_storage() {} };
  const hasFunction = ({ name }: { name: string }) => {
    const declared = visionBf16Metadata.functions.find(fn => fn.name === name);
    return declared !== undefined && typeof module[declared.export] === 'function';
  };
  const core = {
    api: { mtmd_vision_bf16_storage_version: version, mtmd_init_from_file_with_vision_bf16_storage: initialize, mtmd_context_vision_bf16_storage: query, mtmd_init_from_file: legacy },
    module,
    hasFunction,
    constant,
  };
  return { core, version, initialize, query, legacy, constant, constants };
}

describe('optional public BF16 vision storage ABI', () => {
  it('accepts the direct exports and explicit record bridge with ordinary pointer return metadata', async () => {
    const module = await import('./vision-bf16-storage');
    expect(module.inspectVisionBf16Capability({ schema: visionBf16Metadata })).toEqual({ status: 'available' });
    const f = fixture({ requested: 1 });
    expect(await module.loadVisionBf16Capability()).toEqual({ status: 'available' });
    expect(f.version).not.toHaveBeenCalled();
    const loader = await module.prepareVisionBf16Loader({ core: f.core, preference: 'retain-checked', readMetadata: undefined, signal: undefined });
    expect(loader.observed).toMatchObject({ preference: 'retain-checked', selectedMode: 'retain-checked', apiVersion: 1, status: 'selected', evidence: 'requested-policy-only' });
    expect(Object.isFrozen(loader.observed)).toBe(true);
    expect(await loader.initialize({ path: 1n, model: 2n, params: 3n, onProjector })).toBe(700n);
    expect(f.initialize).toHaveBeenCalledWith(1n, 2n, 3n, 1);
    await loader.confirm({ pointer: 700n });
    expect(f.query).toHaveBeenCalledWith(700n);
    expect(loader.observed).toMatchObject({ status: 'initialized', contextRequestedMode: 'retain-checked' });
    expect(f.legacy).not.toHaveBeenCalled();
  });

  it('keeps an entirely absent old ABI on legacy without any new native query', async () => {
    host.schema = { constants: [], functions: [], records: [] };
    const module = await import('./vision-bf16-storage'), f = fixture({ requested: 0 });
    for (const name of ['mtmd_vision_bf16_storage_version', 'mtmd_init_from_file_with_vision_bf16_storage', 'mtmd_context_vision_bf16_storage']) {
      Reflect.deleteProperty(f.core.api, name);
      const exported = visionBf16Metadata.functions.find(fn => fn.name === name)?.export;
      if (exported) {
        Reflect.deleteProperty(f.core.module, exported);
      }
    }
    for (const preference of [undefined, 'legacy-expand'] as const) {
      const loader = await module.prepareVisionBf16Loader({ core: f.core, preference, readMetadata: undefined, signal: undefined });
      expect(loader.observed).toMatchObject({ selectedMode: 'legacy-expand', capability: 'absent' });
      await loader.initialize({ path: 1n, model: 2n, params: 3n, onProjector });
      await loader.confirm({ pointer: 900n });
    }
    expect(f.legacy).toHaveBeenCalledTimes(2);
    expect(f.version).not.toHaveBeenCalled();
    expect(f.initialize).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
    expect(f.constant).not.toHaveBeenCalled();
    const unavailable = await module.prepareVisionBf16Loader({ core: f.core, preference: 'retain-checked', readMetadata: undefined, signal: undefined });
    expect(unavailable.observed).toMatchObject({ status: 'unavailable', reason: 'api-absent-explicit-retain' });
    await expect(unavailable.initialize({ path: 1n, model: 2n, params: 3n, onProjector })).rejects.toThrow();
    expect(f.legacy).toHaveBeenCalledTimes(2);
  });

  it.each(['missing-function', 'duplicate-function', 'missing-constant', 'wrong-kind', 'wrong-record', 'wrong-mode-type', 'wrong-return-type', 'extra-parameter'] as const)('rejects partial or incompatible metadata before any native calls: %s', mutation => {
    // Schema inspection is synchronous; no Wasm factory or model is involved.
    const schema = structuredClone(visionBf16Metadata) as unknown as { constants: string[], records: { name: string }[], functions: { name: string, export: string, returnKind: string, returnType: string, parameters: { name: string, cType: string, kind: string }[] }[] };
    const init = schema.functions.find(fn => fn.name === 'mtmd_init_from_file_with_vision_bf16_storage')!;
    switch (mutation) {
    case 'missing-function': schema.functions.pop();
      break;
    case 'duplicate-function': schema.functions.push(schema.functions[0]!);
      break;
    case 'missing-constant': schema.constants.pop();
      break;
    case 'wrong-kind': init.parameters[2]!.kind = 'pointer';
      break;
    case 'wrong-record': init.parameters[2]!.cType = 'const struct ggml_tensor';
      break;
    case 'wrong-mode-type': init.parameters[3]!.cType = 'uint32_t';
      break;
    case 'wrong-return-type': schema.functions.find(fn => fn.name === 'mtmd_vision_bf16_storage_version')!.returnType = 'uint64_t';
      break;
    case 'extra-parameter': init.parameters.push(init.parameters[3]!);
      break;
    default: {
      const exhaustive: never = mutation;
      throw new Error(String(exhaustive));
    }
    }
    return import('./vision-bf16-storage').then(module => {
      expect(module.inspectVisionBf16Capability({ schema })).toEqual({ status: 'incompatible', reason: 'api-incompatible' });
    });
  });

  it('rejects a mixed artifact whose old metadata omits a new native export', async () => {
    host.schema = { constants: [], functions: [], records: [] };
    const module = await import('./vision-bf16-storage'), f = fixture({ requested: 1 });
    const loader = await module.prepareVisionBf16Loader({ core: f.core, preference: undefined, readMetadata: undefined, signal: undefined });
    expect(loader.observed).toMatchObject({ capability: 'incompatible', status: 'unavailable', reason: 'api-incompatible' });
    await expect(loader.initialize({ path: 1n, model: 2n, params: 3n, onProjector })).rejects.toThrow();
    expect(f.legacy).not.toHaveBeenCalled();
    expect(f.version).not.toHaveBeenCalled();
  });

  it('rejects missing native exports and preserves a rejected new initializer without a legacy retry', async () => {
    const module = await import('./vision-bf16-storage'), f = fixture({ requested: 1 });
    Reflect.deleteProperty(f.core.module, '_mtmd_context_vision_bf16_storage');
    const missing = await module.prepareVisionBf16Loader({ core: f.core, preference: undefined, readMetadata: undefined, signal: undefined });
    expect(missing.observed).toMatchObject({ status: 'unavailable', reason: 'native-export-missing' });
    expect(f.version).not.toHaveBeenCalled();
    const valid = fixture({ requested: 1 });
    const loader = await module.prepareVisionBf16Loader({ core: valid.core, preference: undefined, readMetadata: undefined, signal: undefined });
    const failure = new Error('retained load failed');
    valid.initialize.mockRejectedValueOnce(failure);
    await expect(loader.initialize({ path: 1n, model: 2n, params: 3n, onProjector })).rejects.toBe(failure);
    expect(valid.legacy).not.toHaveBeenCalled();
    expect(valid.query).not.toHaveBeenCalled();
  });

  it.each([NaN, -1, 1.5, 4294967296])('rejects an invalid native version value %s', async value => {
    const module = await import('./vision-bf16-storage'), f = fixture({ requested: 1 });
    f.version.mockResolvedValueOnce(value);
    const loader = await module.prepareVisionBf16Loader({ core: f.core, preference: undefined, readMetadata: undefined, signal: undefined });
    expect(loader.observed).toMatchObject({ status: 'unavailable', reason: 'api-version' });
    expect(loader.observed.apiVersion).toBeUndefined();
    await expect(loader.initialize({ path: 1n, model: 2n, params: 3n, onProjector })).rejects.toThrow();
    expect(f.legacy).not.toHaveBeenCalled();
  });

  it('never falls back on a version or enum mismatch', async () => {
    const module = await import('./vision-bf16-storage'), f = fixture({ requested: 1 });
    f.version.mockResolvedValueOnce(2);
    const version = await module.prepareVisionBf16Loader({ core: f.core, preference: undefined, readMetadata: undefined, signal: undefined });
    expect(version.observed).toMatchObject({ status: 'unavailable', reason: 'api-version', apiVersion: 2 });
    await expect(version.initialize({ path: 1n, model: 2n, params: 3n, onProjector })).rejects.toThrow();
    f.constants.MTMD_VISION_BF16_STORAGE_RETAIN_CHECKED = 9;
    const values = await module.prepareVisionBf16Loader({ core: f.core, preference: 'retain-checked', readMetadata: undefined, signal: undefined });
    expect(values.observed).toMatchObject({ status: 'unavailable', reason: 'api-constant' });
    expect(f.initialize).not.toHaveBeenCalled();
    expect(f.legacy).not.toHaveBeenCalled();
  });

  it('rejects a requested-mode mismatch after init without pretending it retained successfully', async () => {
    const module = await import('./vision-bf16-storage'), f = fixture({ requested: 0 });
    const loader = await module.prepareVisionBf16Loader({ core: f.core, preference: 'retain-checked', readMetadata: undefined, signal: undefined });
    await loader.initialize({ path: 1n, model: 2n, params: 3n, onProjector });
    await expect(loader.confirm({ pointer: 700n })).rejects.toThrow('mismatch');
    expect(loader.observed).toMatchObject({ status: 'unavailable', reason: 'context-request-mismatch', contextRequestedMode: 'legacy-expand' });
    expect(f.legacy).not.toHaveBeenCalled();
  });

  it('captures each load mode independently across interleaved native awaits', async () => {
    const module = await import('./vision-bf16-storage'), a = fixture({ requested: 0 }), b = fixture({ requested: 1 });
    const pending = Promise.withResolvers<bigint>();
    a.initialize.mockReturnValueOnce(pending.promise);
    const legacy = await module.prepareVisionBf16Loader({ core: a.core, preference: 'legacy-expand', readMetadata: undefined, signal: undefined });
    const retained = await module.prepareVisionBf16Loader({ core: b.core, preference: 'retain-checked', readMetadata: undefined, signal: undefined });
    const first = legacy.initialize({ path: 1n, model: 2n, params: 3n, onProjector });
    await retained.initialize({ path: 4n, model: 5n, params: 6n, onProjector });
    pending.resolve(700n);
    await first;
    expect(a.initialize).toHaveBeenCalledWith(1n, 2n, 3n, 0);
    expect(b.initialize).toHaveBeenCalledWith(4n, 5n, 6n, 1);
    await legacy.confirm({ pointer: 700n });
    await retained.confirm({ pointer: 700n });
    expect(legacy.observed.contextRequestedMode).toBe('legacy-expand');
    expect(retained.observed.contextRequestedMode).toBe('retain-checked');
  });
});

describe('automatic BF16 storage', () => {
  const refused = { status: 'retention-refused', reason: 'weight-unreviewed', phase: 'preupload', cleanup: 'complete' } satisfies VisionBf16LoadReport;
  const success = { status: 'succeeded', reason: 'none', phase: 'complete', cleanup: 'not-required' } satisfies VisionBf16LoadReport;
  const path = 10n, model = 20n, params = 30n;
  const readMetadata = () => Promise.resolve({ hasVision: true, commonProjector: 'muse-glimmer', visionProjector: undefined });

  function diagnosticFixture() {
    const base = fixture({ requested: 0 });
    const diagnostics = {
      version: vi.fn<VisionBf16Diagnostics['version']>().mockResolvedValue(1),
      classify: vi.fn<VisionBf16Diagnostics['classify']>().mockResolvedValue('reviewed'),
      initialize: vi.fn<VisionBf16Diagnostics['initialize']>().mockResolvedValue({ pointer: 700n, report: success }),
    };
    return { ...base, diagnostics, core: { ...base.core, visionBf16Diagnostics: diagnostics } };
  }

  it('uses legacy from the start on artifacts without the diagnostics API', async () => {
    const { prepareVisionBf16Loader } = await import('./vision-bf16-storage');
    const f = fixture({ requested: 0 });
    const metadata = vi.fn(readMetadata);
    const loader = await prepareVisionBf16Loader({ core: f.core, preference: undefined, readMetadata: metadata, signal: undefined });
    await expect(loader.initialize({ path, model, params, onProjector })).resolves.toBe(700n);
    await loader.confirm({ pointer: 700n });
    expect(metadata).not.toHaveBeenCalled();
    expect(f.initialize).toHaveBeenCalledExactlyOnceWith(path, model, params, 0);
    expect(loader.observed).toMatchObject({ reason: 'auto-diagnostics-unavailable', selectedMode: 'legacy-expand', contextRequestedMode: 'legacy-expand' });
  });

  it.each(['unreviewed', 'unknown', 'legacy-first', 'not-applicable'] as const)('starts in legacy for a %s candidate', async candidate => {
    const { prepareVisionBf16Loader } = await import('./vision-bf16-storage');
    const f = diagnosticFixture();
    f.diagnostics.classify.mockResolvedValue(candidate);
    const loader = await prepareVisionBf16Loader({ core: f.core, preference: undefined, readMetadata, signal: undefined });
    expect(f.diagnostics.initialize).not.toHaveBeenCalled();
    await expect(loader.initialize({ path, model, params, onProjector })).resolves.toBe(700n);
    expect(f.diagnostics.initialize).toHaveBeenCalledExactlyOnceWith({ path, model, params, mode: 0, onProjector });
    expect(loader.observed).toMatchObject({ candidate, reason: 'auto-legacy', selectedMode: 'legacy-expand' });
  });

  it('retries a reviewed projector on the same model and file only after the dedicated preupload refusal', async () => {
    const { prepareVisionBf16Loader } = await import('./vision-bf16-storage');
    const f = diagnosticFixture();
    f.diagnostics.initialize.mockResolvedValueOnce({ pointer: 0n, report: refused });
    const loader = await prepareVisionBf16Loader({ core: f.core, preference: undefined, readMetadata, signal: undefined });
    expect(loader.observed).toMatchObject({ candidate: 'reviewed', selectedMode: 'retain-checked' });
    await expect(loader.initialize({ path, model, params, onProjector })).resolves.toBe(700n);
    await loader.confirm({ pointer: 700n });
    expect(f.diagnostics.initialize.mock.calls).toEqual([[{ path, model, params, mode: 1, onProjector }], [{ path, model, params, mode: 0, onProjector }]]);
    expect(loader.observed).toMatchObject({ selectedMode: 'legacy-expand', initialMode: 'retain-checked', retentionRefusal: refused, loadReport: success, status: 'initialized' });
  });

  it('ends after one retry even if legacy initialization also fails', async () => {
    const { prepareVisionBf16Loader } = await import('./vision-bf16-storage');
    const f = diagnosticFixture();
    f.diagnostics.initialize.mockResolvedValue({ pointer: 0n, report: refused });
    const loader = await prepareVisionBf16Loader({ core: f.core, preference: undefined, readMetadata, signal: undefined });
    await expect(loader.initialize({ path, model, params, onProjector })).resolves.toBe(0n);
    expect(f.diagnostics.initialize.mock.calls).toEqual([[{ path, model, params, mode: 1, onProjector }], [{ path, model, params, mode: 0, onProjector }]]);
    expect(loader.observed).toMatchObject({ selectedMode: 'legacy-expand', retentionRefusal: refused, loadReport: refused });
  });

  it.each([
    { ...refused, reason: 'other' },
    { ...refused, phase: 'context' },
    { ...refused, cleanup: 'unknown' },
    { ...refused, status: 'failed' },
  ] satisfies VisionBf16LoadReport[])('does not retry nonrecoverable native reports %#', async report => {
    const { prepareVisionBf16Loader } = await import('./vision-bf16-storage');
    const f = diagnosticFixture();
    f.diagnostics.initialize.mockResolvedValueOnce({ pointer: 0n, report });
    const loader = await prepareVisionBf16Loader({ core: f.core, preference: undefined, readMetadata, signal: undefined });
    await expect(loader.initialize({ path, model, params, onProjector })).resolves.toBe(0n);
    expect(f.diagnostics.initialize).toHaveBeenCalledExactlyOnceWith({ path, model, params, mode: 1, onProjector });
    expect(loader.observed.loadReport).toEqual(report);
  });

  it.each(['explicit', 'cancelled', 'cancel-task'] as const)('does not retry an early refusal after a %s retain request', async condition => {
    const { prepareVisionBf16Loader } = await import('./vision-bf16-storage');
    const f = diagnosticFixture();
    const control = new AbortController();
    f.diagnostics.initialize.mockImplementationOnce(async () => {
      if (condition === 'cancelled') {
        control.abort();
      }
      if (condition === 'cancel-task') {
        setTimeout(() => control.abort(), 0);
      }
      return { pointer: 0n, report: refused };
    });
    const loader = await prepareVisionBf16Loader({ core: f.core, preference: condition === 'explicit' ? 'retain-checked' : undefined, readMetadata, signal: control.signal });
    const pending = loader.initialize({ path, model, params, onProjector });
    if (condition === 'explicit') {
      await expect(pending).resolves.toBe(0n);
      expect(f.diagnostics.classify).not.toHaveBeenCalled();
    } else {
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    }
    expect(f.diagnostics.initialize).toHaveBeenCalledExactlyOnceWith({ path, model, params, mode: 1, onProjector });
    expect(loader.observed.loadReport).toEqual(refused);
  });
});
