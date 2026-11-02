// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseQuery, stringifyQuery } from 'vue-router';
import { diagnosticsQueryParameters, parseDiagnosticsQuery, serializeDiagnosticsQuery, isDiagnosticsEditValid } from './query-parameters';

describe('disposable diagnostics URL configuration', () => {
  it('ignores unknown, obsolete, version and inherited parameters independently', () => {
    const query = { obsolete: 'x', v: '999', repeats: '3', mode: 'both' };
    Object.setPrototypeOf(query, { 'all-models': null, notes: 'inherited' });
    expect(parseDiagnosticsQuery({ query })).toEqual({ repeats: 3, mode: 'both' });
  });

  it('keeps all-models as a bare presence flag, overriding the explicit list', () => {
    expect(parseDiagnosticsQuery({ query: parseQuery('all-models&model=a&model=b') })).toEqual({ allModels: true });
    expect(stringifyQuery(serializeDiagnosticsQuery({ config: { allModels: true, modelIds: ['a'], mode: 'both', placement: true } }))).toBe('all-models&mode=both&placement=1');
  });

  it.each(['all-models=', 'all-models=0', 'all-models=1', 'all-models&all-models'])('ignores invalid presence flags: %s', value => {
    expect(parseDiagnosticsQuery({ query: parseQuery(`${value}&model=a`) })).toEqual({ modelIds: ['a'] });
  });

  it('accepts many exact IDs, preserves order and deduplicates without trimming or splitting', () => {
    const ids = [' user/x ', '日本語/a&b+c,#?', 'a,b', ...Array.from({ length: 50 }, (_, i) => `user/${i}`)];
    const config = parseDiagnosticsQuery({ query: parseQuery(stringifyQuery(serializeDiagnosticsQuery({ config: { modelIds: [...ids, ids[0]!] } }))) });
    expect(config.modelIds).toEqual(ids);
  });

  it('distinguishes unspecified, empty selection, empty string and bare model keys', () => {
    expect(parseDiagnosticsQuery({ query: {} })).toEqual({});
    expect(parseDiagnosticsQuery({ query: parseQuery('model') })).toEqual({});
    expect(parseDiagnosticsQuery({ query: parseQuery('model=') })).toEqual({ modelIds: [] });
    expect(parseDiagnosticsQuery({ query: parseQuery('model=&model=a&model') })).toEqual({ modelIds: ['a'] });
    expect(stringifyQuery(serializeDiagnosticsQuery({ config: { modelIds: [] } }))).toBe('model=');
  });

  it.each(['', 'NaN', 'Infinity', '-1', '0', '6', '1e0', '1.0', '01', ' 1', '9007199254740992'])('ignores invalid repeats without rejecting other fields: %s', raw => {
    expect(parseDiagnosticsQuery({ query: { repeats: raw, mode: 'both' } })).toEqual({ mode: 'both' });
  });

  it('rejects duplicated scalars, empty choices and invalid flags independently', () => {
    expect(parseDiagnosticsQuery({ query: { mode: ['both', 'standard'], workload: '', repeats: ['3'], placement: 'true', profile: 'webgpu-wasm64-jspi-gpu-profile' } })).toEqual({});
  });

  it('round trips every registered field and respects the optional runtime defaults', () => {
    const config = {
      modelIds: ['a'],
      modelFilter: 'qwen',
      workload: 'vision' as const,
      mode: 'standard' as const,
      repeats: 5,
      maxTokens: 512,
      timeoutMinutes: 60,
      placement: false,
      profile: 'cpu-wasm32' as const,
      contextTokens: 1048576,
      visionBf16Storage: 'retain-checked' as const,
      notes: `\
line 1
日本語`,
    };
    expect(Object.keys(diagnosticsQueryParameters)).toHaveLength(Object.keys(config).length + 1);
    expect(parseDiagnosticsQuery({ query: parseQuery(stringifyQuery(serializeDiagnosticsQuery({ config }))) })).toEqual(config);
    expect(parseDiagnosticsQuery({ query: { contextTokens: '511', visionBf16Storage: 'old' } })).toEqual({});
  });

  it('keeps text within its limits and never writes invalid local numeric edits', () => {
    expect(parseDiagnosticsQuery({ query: { notes: 'x'.repeat(10001), modelFilter: 'x'.repeat(201) } })).toEqual({});
    expect(isDiagnosticsEditValid({ patch: { repeats: NaN } })).toBe(false);
    expect(isDiagnosticsEditValid({ patch: { repeats: undefined } })).toBe(true);
    expect(isDiagnosticsEditValid({ patch: { contextTokens: 4096, modelIds: [] } })).toBe(true);
  });
});
