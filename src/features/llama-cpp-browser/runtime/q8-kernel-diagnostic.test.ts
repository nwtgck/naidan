// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { attachCore, createCore, type Core } from './core';
import { createDiagnosticNativeFixture, diagnosticPrefix, schemaBytes } from './q8-kernel-diagnostic.test-support';
import { Q8KernelDiagnosticFatalError, type Q8KernelDiagnosticPhase, type Q8KernelDiagnosticVariant } from './q8-kernel-diagnostic';

describe('optional Q8 native diagnostic adapter', () => {
  let base: Core;

  beforeAll(async () => {
    const baseURL = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/llama-cpp-browser-core/profiles') + '/');
    base = await createCore({
      profile: 'cpu-wasm32',
      baseURL,
      moduleOptions: {
        wasmBinary: await readFile(new URL('cpu-wasm32/browser/core.wasm', baseURL)),
        print() {},
        printErr() {},
      },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('matches the generated source contract and does not probe optional exports during attach or ordinary calls', async () => {
    using fixture = createDiagnosticNativeFixture({ base });
    expect(fixture.schema.schemaSha256).toBe('06990d0ca1aab352f2e06087e1231fa1cf02b2334c2e8feef5279ffc1c57fa94');
    expect(fixture.probes).toEqual([]);
    expect(typeof await fixture.core.api.ggml_backend_dev_count()).toBe('bigint');
    expect(fixture.probes).toEqual([]);
    expect(fixture.core.q8KernelDiagnosticAvailability()).toBe('available');
    expect(fixture.probes).toHaveLength(8);
    expect(fixture.calls).toEqual([]);
    expect(Object.keys(fixture.core)).not.toContain('withAccess');
  });

  it('returns unavailable only for a completely absent extension', async () => {
    using fixture = createDiagnosticNativeFixture({ base });
    fixture.state.omitted = new Set(['version', 'run_v1', 'schema_hash', 'sizeof_record', 'alignof_record', 'offsetof_field', 'sizeof_field', 'constant']);
    expect(fixture.core.q8KernelDiagnosticAvailability()).toBe('unavailable');
    await expect(fixture.core.createQ8KernelDiagnostic({ schemaBytes: new Uint8Array([0xff]) })).resolves.toBeUndefined();
    expect(fixture.calls).toEqual([]);
    fixture.state.omitted.delete('run_v1');
    expect(() => fixture.core.q8KernelDiagnosticAvailability()).toThrow('Incomplete');
    fixture.state.omitted.clear();
    fixture.state.overrides.version = 1;
    expect(() => fixture.core.q8KernelDiagnosticAvailability()).toThrow('Incomplete');
  });

  it('rejects schema edits, unknown fields, non-ASCII and a mismatched compiled fingerprint before allocating records', async () => {
    using fixture = createDiagnosticNativeFixture({ base });
    const modified = structuredClone(fixture.schema);
    modified.records[0]!.fields[0]!.name = 'tampered';
    await expect(fixture.core.createQ8KernelDiagnostic({ schemaBytes: schemaBytes({ schema: modified }) })).rejects.toThrow('canonical schema mismatch');
    await expect(fixture.core.createQ8KernelDiagnostic({ schemaBytes: new TextEncoder().encode(JSON.stringify({ ...fixture.schema, extra: true })) })).rejects.toThrow();
    await expect(fixture.core.createQ8KernelDiagnostic({ schemaBytes: new TextEncoder().encode('日本語') })).rejects.toThrow('schema bytes');
    fixture.replaceCompiledHash({ hash: 'f'.repeat(64) });
    await expect(fixture.core.createQ8KernelDiagnostic({ schemaBytes: schemaBytes({ schema: fixture.schema }) })).rejects.toThrow('compiled schema mismatch');
    expect(fixture.state.allocationCount).toBe(0);
    expect(() => fixture.core.assertIdle()).not.toThrow();
  });

  it.each([
    { leaf: 'sizeof_record', value: 0 }, { leaf: 'alignof_record', value: 3 }, { leaf: 'offsetof_field', value: 1 },
    { leaf: 'offsetof_field', value: 0 }, { leaf: 'sizeof_field', value: 8 }, { leaf: 'offsetof_field', value: 0xffffffff },
  ])('rejects invalid runtime $leaf layout ($value)', async ({ leaf, value }) => {
    using fixture = createDiagnosticNativeFixture({ base });
    fixture.state.overrides[leaf] = () => value;
    await expect(fixture.core.createQ8KernelDiagnostic({ schemaBytes: schemaBytes({ schema: fixture.schema }) })).rejects.toThrow();
    expect(fixture.state.allocationCount).toBe(0);
  });

  it('uses supplied record/field IDs, sizes and offsets rather than wire positions', async () => {
    using fixture = createDiagnosticNativeFixture({ base });
    fixture.state.idShift = 17;
    fixture.state.padding = 16;
    for (const record of fixture.schema.records) {
      record.id += 17;
      for (const field of record.fields) {
        field.id += 17;
      }
    }
    const canonical = { ...fixture.schema };
    Reflect.deleteProperty(canonical, 'schemaSha256');
    fixture.schema.schemaSha256 = createHash('sha256').update(JSON.stringify(canonical, undefined, 2) + '\n').digest('hex');
    fixture.replaceCompiledHash({ hash: fixture.schema.schemaSha256 });
    const adapter = await fixture.core.createQ8KernelDiagnostic({ schemaBytes: schemaBytes({ schema: fixture.schema }) });
    const result = await adapter!.run({ backend: 1n, dst: 2n, variant: 'auto', phase: 'prepare', repetitions: 0 });
    expect(result).toMatchObject({ status: 'ok', algorithm: 'independent', workgroupSize: 128, rowsPerTile: 2, dispatches: 0 });
    expect(fixture.freed).toHaveLength(2);
  });

  it('rechecks the shared idle gate after asynchronous hashing', async () => {
    using fixture = createDiagnosticNativeFixture({ base });
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const gate = Promise.withResolvers<ArrayBuffer>();
    const started = Promise.withResolvers<void>();
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      started.resolve();
      const value = await digest(...args);
      await gate.promise;
      return value;
    });
    const nativeGate = Promise.withResolvers<bigint>();
    const module = new Proxy(fixture.module, {
      get(target, property) {
        return property === '_lcb_ggml_backend_dev_count' ? () => nativeGate.promise : Reflect.get(target, property, target);
      },
    });
    const core = attachCore({ module, callMode: 'jspi' });
    const creating = core.createQ8KernelDiagnostic({ schemaBytes: schemaBytes({ schema: fixture.schema }) });
    await started.promise;
    const pending = core.api.ggml_backend_dev_count();
    gate.resolve(new ArrayBuffer(0));
    await expect(creating).rejects.toThrow('Serialize access');
    expect(fixture.calls).toEqual([]);
    nativeGate.resolve(0n);
    await pending;
    expect(() => core.assertIdle()).not.toThrow();
  });

  it('snapshots schema bytes before the dynamic import await and checks idle again afterward', async () => {
    using fixture = createDiagnosticNativeFixture({ base });
    const source = schemaBytes({ schema: fixture.schema });
    const creating = fixture.core.createQ8KernelDiagnostic({ schemaBytes: source });
    source.fill(0);
    expect(await creating).toBeDefined();
    const nativeGate = Promise.withResolvers<bigint>();
    const core = attachCore({
      module: new Proxy(fixture.module, {
        get(target, property) {
          return property === '_lcb_ggml_backend_dev_count' ? () => nativeGate.promise : Reflect.get(target, property, target);
        },
      }),
      callMode: 'jspi',
    });
    const second = core.createQ8KernelDiagnostic({ schemaBytes: schemaBytes({ schema: fixture.schema }) });
    const pending = core.api.ggml_backend_dev_count();
    await expect(second).rejects.toThrow('Serialize access');
    nativeGate.resolve(0n);
    await pending;
  });

  it.each(['prepare', 'execute'] as const)('holds the ordinary gate through %s suspension, validation and cleanup', async phase => {
    using fixture = createDiagnosticNativeFixture({ base });
    const gate = Promise.withResolvers<void>();
    fixture.state.delay = gate.promise;
    const adapter = await fixture.core.createQ8KernelDiagnostic({ schemaBytes: schemaBytes({ schema: fixture.schema }) });
    const queries = fixture.metadataCalls.length;
    let cleanupChecks = 0;
    fixture.state.onFree = () => {
      expect(() => fixture.core.assertIdle()).toThrow('Serialize access');
      cleanupChecks++;
    };
    const pending = adapter!.run({ backend: 1n, dst: 2n, variant: 'auto', phase, repetitions: phase === 'execute' ? 3 : 0 });
    expect(fixture.state.invokeCount).toBe(1);
    expect(fixture.allocations.size).toBe(2);
    expect(() => fixture.core.assertIdle()).toThrow('Serialize access');
    expect(() => fixture.core.q8KernelDiagnosticAvailability()).toThrow('Serialize access');
    expect(() => fixture.core.alloc({ bytes: 4 })).toThrow('Serialize access');
    expect(() => fixture.core.free({ pointer: 1n })).toThrow('Serialize access');
    expect(() => fixture.core.recordSize({ name: 'llama_batch' })).toThrow('Serialize access');
    await expect(fixture.core.api.ggml_backend_dev_count()).rejects.toThrow('Serialize access');
    await expect(adapter!.run({ backend: 1n, dst: 2n, variant: 'auto', phase: 'prepare', repetitions: 0 })).rejects.toThrow('Serialize access');
    gate.resolve();
    // The invoke can finish in a microtask before report/cleanup has finished.
    await expect(Promise.resolve().then(() => fixture.core.api.ggml_backend_dev_count())).rejects.toThrow('Serialize access');
    const result = await pending;
    expect(result).toMatchObject({
      status: 'ok',
      variant: 'auto',
      phase,
      algorithm: 'independent',
      workgroupSize: 128,
      logicalSubgroupSize: 8,
      rowsPerTile: 2,
      outputsPerWorkgroup: 32,
      shaderSha256: 'ab'.repeat(32),
      dispatches: phase === 'execute' ? 3 : 0,
    });
    expect(result.nativeWallMs).toBeGreaterThanOrEqual(0);
    expect(fixture.metadataCalls).toHaveLength(queries);
    expect(fixture.freed).toHaveLength(2);
    expect(cleanupChecks).toBe(2);
    expect(fixture.allocations.size).toBe(0);
    expect(() => fixture.core.assertIdle()).not.toThrow();
  });

  it('refuses diagnostic setup and execution while an ordinary native call owns the gate', async () => {
    using fixture = createDiagnosticNativeFixture({ base });
    const nativeGate = Promise.withResolvers<bigint>();
    const core = attachCore({
      module: new Proxy(fixture.module, {
        get(target, property) {
          return property === '_lcb_ggml_backend_dev_count' ? () => nativeGate.promise : Reflect.get(target, property, target);
        },
      }),
      callMode: 'jspi',
    });
    const adapter = await core.createQ8KernelDiagnostic({ schemaBytes: schemaBytes({ schema: fixture.schema }) });
    const pending = core.api.ggml_backend_dev_count();
    await expect(core.createQ8KernelDiagnostic({ schemaBytes: schemaBytes({ schema: fixture.schema }) })).rejects.toThrow('Serialize access');
    await expect(adapter!.run({ backend: 1n, dst: 2n, variant: 'auto', phase: 'prepare', repetitions: 0 })).rejects.toThrow('Serialize access');
    expect(fixture.state.allocationCount).toBe(0);
    nativeGate.resolve(0n);
    await pending;
  });

  it.each(['cooperative-wg256-r4', 'independent-wg128-r4', 'independent-wg128-r1', 'independent-wg128-r2', 'cooperative-wg128-r2'] as const)('marshals %s and reacquires a grown heap after JSPI', async variant => {
    using fixture = createDiagnosticNativeFixture({ base });
    fixture.state.grow = true;
    const adapter = await fixture.core.createQ8KernelDiagnostic({ schemaBytes: schemaBytes({ schema: fixture.schema }) });
    const observed: Readonly<Record<string, number>>[] = [];
    fixture.state.onRequest = ({ request }) => observed.push(request);
    const result = await adapter!.run({ backend: 1n, dst: 2n, variant, phase: 'execute', repetitions: 5 });
    expect(result.status).toBe('ok');
    expect(result.dispatches).toBe(5);
    expect(result.shaderSha256).toBe('ab'.repeat(32));
    expect(observed).toMatchObject([{ abi_version: 1, struct_size: 24, phase: 2, repetitions: 5, reserved: 0 }]);
    expect(fixture.freed).toHaveLength(2);
  });

  it.each([1, 2, 3, 4, 5])('preserves known native status %s and its report contract', async status => {
    using fixture = createDiagnosticNativeFixture({ base });
    fixture.state.status = status;
    const adapter = await fixture.core.createQ8KernelDiagnostic({ schemaBytes: schemaBytes({ schema: fixture.schema }) });
    const result = await adapter!.run({ backend: 1n, dst: 2n, variant: 'auto', phase: 'execute', repetitions: 1 });
    expect(result.status).toBe(['ok', 'unavailable', 'bad-request', 'unsupported', 'not-prepared', 'busy'][status]);
    expect(result.shaderSha256).toBeUndefined();
    expect(result.dispatches).toBe(0);
    expect(() => fixture.core.assertIdle()).not.toThrow();
  });

  it.each([1, 2])('cleans up safe allocation failure number %s and releases the gate', async oomAt => {
    using fixture = createDiagnosticNativeFixture({ base });
    fixture.state.oomAt = oomAt;
    const adapter = await fixture.core.createQ8KernelDiagnostic({ schemaBytes: schemaBytes({ schema: fixture.schema }) });
    await expect(adapter!.run({ backend: 1n, dst: 2n, variant: 'auto', phase: 'prepare', repetitions: 0 })).rejects.toThrow('allocation failed');
    expect(fixture.freed).toHaveLength(oomAt - 1);
    expect(fixture.state.invokeCount).toBe(0);
    expect(() => fixture.core.assertIdle()).not.toThrow();
  });

  it.each([
    { phase: 'prepare', repetitions: 1 }, { phase: 'execute', repetitions: 0 }, { phase: 'execute', repetitions: 129 }, { phase: 'execute', repetitions: 0.5 },
  ] as const)('rejects invalid $phase repetitions $repetitions before native work', async ({ phase, repetitions }) => {
    using fixture = createDiagnosticNativeFixture({ base });
    const adapter = await fixture.core.createQ8KernelDiagnostic({ schemaBytes: schemaBytes({ schema: fixture.schema }) });
    await expect(adapter!.run({ backend: 1n, dst: 2n, variant: 'auto', phase, repetitions })).rejects.toThrow();
    await expect(adapter!.run({ backend: 0n, dst: 2n, variant: 'auto', phase: 'prepare', repetitions: 0 })).rejects.toThrow();
    await expect(adapter!.run({ backend: 1n, dst: 2n, variant: 'unknown' as Q8KernelDiagnosticVariant, phase: 'prepare', repetitions: 0 })).rejects.toThrow();
    await expect(adapter!.run({ backend: 1n, dst: 2n, variant: 'auto', phase: 'unknown' as Q8KernelDiagnosticPhase, repetitions: 0 })).rejects.toThrow();
    expect(fixture.state.allocationCount).toBe(0);
    expect(() => fixture.core.assertIdle()).not.toThrow();
  });

  it.each([
    { field: 'status', value: 99 }, { field: 'abi_version', value: 2 }, { field: 'struct_size', value: 4 }, { field: 'reserved', value: 1 },
    { field: 'requested_variant', value: 5 }, { field: 'phase', value: 2 }, { field: 'dispatches', value: 1 },
    { field: 'outputs_per_workgroup', value: 7 }, { field: 'actual_algorithm', value: 99 }, { field: 'codegen_revision', value: 2 },
    { field: 'shader_identity_id', value: 1 },
  ])('poisons without freeing records after a corrupt $field report', async ({ field, value }) => {
    using fixture = createDiagnosticNativeFixture({ base });
    fixture.state.report[field] = value;
    const adapter = await fixture.core.createQ8KernelDiagnostic({ schemaBytes: schemaBytes({ schema: fixture.schema }) });
    await expect(adapter!.run({ backend: 1n, dst: 2n, variant: 'auto', phase: 'prepare', repetitions: 0 })).rejects.toBeInstanceOf(Q8KernelDiagnosticFatalError);
    expect(fixture.freed).toEqual([]);
    expect(() => fixture.core.assertIdle()).toThrow('Serialize access');
    await expect(fixture.core.api.ggml_backend_dev_count()).rejects.toThrow('Serialize access');
  });

  it.each(['reject', 'unknown-result', 'cleanup-trap'] as const)('keeps a %s runtime poisoned until Worker disposal', async failure => {
    using fixture = createDiagnosticNativeFixture({ base });
    const adapter = await fixture.core.createQ8KernelDiagnostic({ schemaBytes: schemaBytes({ schema: fixture.schema }) });
    if (failure === 'reject') {
      fixture.state.delay = Promise.reject(new Error('device lost'));
    }
    if (failure === 'unknown-result') {
      fixture.state.result = 99;
    }
    if (failure === 'cleanup-trap') {
      fixture.state.freeTrap = true;
    }
    await expect(adapter!.run({ backend: 1n, dst: 2n, variant: 'auto', phase: 'execute', repetitions: 1 })).rejects.toBeInstanceOf(Q8KernelDiagnosticFatalError);
    expect(fixture.freed).toEqual([]);
    expect(fixture.allocations.size).toBe(2);
    expect(() => fixture.core.assertIdle()).toThrow('Serialize access');
    await expect(fixture.core.api.ggml_backend_dev_count()).rejects.toThrow('Serialize access');
  });

  it.each(['zero-digest', 'prepare-not-prepared', 'failure-metadata', 'forced-mismatch'] as const)('rejects an inconsistent %s report without releasing ownership', async failure => {
    using fixture = createDiagnosticNativeFixture({ base });
    const adapter = await fixture.core.createQ8KernelDiagnostic({ schemaBytes: schemaBytes({ schema: fixture.schema }) });
    if (failure === 'zero-digest') {
      fixture.state.zeroDigest = true;
    }
    if (failure === 'prepare-not-prepared') {
      fixture.state.status = 4;
    }
    if (failure === 'failure-metadata') {
      fixture.state.status = 3;
      fixture.state.report.workgroup_size = 128;
    }
    if (failure === 'forced-mismatch') {
      fixture.state.report.rows_per_tile = 1;
      fixture.state.report.outputs_per_workgroup = 16;
    }
    await expect(adapter!.run({ backend: 1n, dst: 2n, variant: 'independent-wg128-r2', phase: 'prepare', repetitions: 0 })).rejects.toBeInstanceOf(Q8KernelDiagnosticFatalError);
    expect(fixture.freed).toEqual([]);
    expect(() => fixture.core.assertIdle()).toThrow('Serialize access');
  });

  it('detects a partial export independently of schema loading', () => {
    const module = new Proxy(base.module, {
      get(target, property) {
        if (typeof property === 'string' && property.startsWith(diagnosticPrefix)) {
          return property.endsWith('run_v1') ? () => 0 : undefined;
        }
        return Reflect.get(target, property, target);
      },
    });
    expect(() => attachCore({ module, callMode: 'jspi' }).q8KernelDiagnosticAvailability()).toThrow('Incomplete');
  });
});
