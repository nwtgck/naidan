// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { diagnosticsModelSelection, resolveDiagnosticsModels } from './model-selection';

describe('model selection intent', () => {
  it('resolves all inventory IDs independently of display filters without mutating inventory', () => {
    const ids = ['z', 'a', 'b', 'a'];
    expect(resolveDiagnosticsModels({ selection: { kind: 'all' }, ids, defaultModel: 'z' })).toEqual(['a', 'b', 'z']);
    expect(ids).toEqual(['z', 'a', 'b', 'a']);
  });

  it('does not drop unresolved IDs, replace an empty selection or infer all from equality', () => {
    for (const selected of [[], ['missing'], ['a', 'b']]) {
      const selection = diagnosticsModelSelection({ config: { modelIds: selected } });
      expect(selection.kind).toBe('explicit');
      expect(resolveDiagnosticsModels({ selection, ids: ['a', 'b'], defaultModel: 'a' })).toEqual(selected);
    }
  });

  it('resolves only a stored default and re-resolves all after inventory changes', () => {
    expect(resolveDiagnosticsModels({ selection: { kind: 'default' }, ids: ['a'], defaultModel: 'missing' })).toEqual([]);
    expect(resolveDiagnosticsModels({ selection: { kind: 'default' }, ids: ['a'], defaultModel: 'a' })).toEqual(['a']);
    const selection = diagnosticsModelSelection({ config: { allModels: true, modelIds: ['missing'] } });
    expect(resolveDiagnosticsModels({ selection, ids: [], defaultModel: 'a' })).toEqual([]);
    expect(resolveDiagnosticsModels({ selection, ids: ['new'], defaultModel: 'a' })).toEqual(['new']);
  });
});
