import { describe, expect, it } from 'vitest';
import type { ModelSupportInvestigationConfiguration } from '@/features/transformers-js/model-support-investigation/logic/investigation-config';
import {
  canonicalInvestigationTargetList,
  configurationForPreset,
  createDefaultInvestigationConfiguration,
  deriveInvestigationPreset,
  normalizeInvestigationTarget,
  parseInvestigationTargets,
  resolveEffectiveScope,
  resolveInvestigationExecutionPlan,
} from '@/features/transformers-js/model-support-investigation/logic/investigation-config';

describe('Model Support Investigation configuration', () => {
  it('defaults to full scope with external network allowed', () => {
    const configuration = createDefaultInvestigationConfiguration();
    expect(deriveInvestigationPreset({ configuration })).toBe('full');
    expect(configuration.externalNetworkPolicy).toBe('allow');
  });

  it('treats external network as an orthogonal policy while preserving preset semantics', () => {
    const offline = configurationForPreset({ preset: 'offline' });
    expect(deriveInvestigationPreset({ configuration: offline })).toBe('offline');

    const downloadFocused = configurationForPreset({ preset: 'download-focused' });
    downloadFocused.externalNetworkPolicy = 'deny';
    expect(deriveInvestigationPreset({ configuration: downloadFocused })).toBe('download-focused');
  });

  it('makes model load and generation explicit dependencies of later runtime scopes', () => {
    const configuration = configurationForPreset({ preset: 'download-focused' });
    configuration.scope['repository-download'] = 'not-selected';
    configuration.scope.continuity = 'selected';

    expect(resolveEffectiveScope({ scope: configuration.scope })).toEqual({
      'repository-download': 'not-selected',
      'model-load': 'required',
      generation: 'required',
      continuity: 'selected',
      'capability-probes': 'not-selected',
    });
  });

  it('derives an executable scope plan without turning repository/download into an implicit dependency', () => {
    const configuration = configurationForPreset({ preset: 'download-focused' });
    configuration.scope['repository-download'] = 'not-selected';
    configuration.scope.continuity = 'selected';

    expect(resolveInvestigationExecutionPlan({ scope: configuration.scope })).toEqual({
      repositoryDownload: false,
      modelLoad: true,
      generation: true,
      continuity: true,
      capabilityProbes: false,
    });
  });

  it('keeps download-focused execution out of model load and generation', () => {
    expect(resolveInvestigationExecutionPlan({
      scope: configurationForPreset({ preset: 'download-focused' }).scope,
    })).toEqual({
      repositoryDownload: true,
      modelLoad: false,
      generation: false,
      continuity: false,
      capabilityProbes: false,
    });
  });

  it('makes model load and generation dependencies of capability probes', () => {
    const configuration = configurationForPreset({ preset: 'download-focused' });
    configuration.scope['repository-download'] = 'not-selected';
    configuration.scope['capability-probes'] = 'selected';

    expect(resolveEffectiveScope({ scope: configuration.scope })).toMatchObject({
      'model-load': 'required',
      generation: 'required',
      'capability-probes': 'selected',
    });
  });

  it('resolves every direct scope combination without inventing repository/download dependencies', () => {
    const scopeIds = [
      'repository-download',
      'model-load',
      'generation',
      'continuity',
      'capability-probes',
    ] as const;

    for (let mask = 0; mask < 2 ** scopeIds.length; mask += 1) {
      const scope = Object.fromEntries(scopeIds.map((scopeId, index) => [
        scopeId,
        (mask & (1 << index)) === 0 ? 'not-selected' : 'selected',
      ])) as ModelSupportInvestigationConfiguration['scope'];
      const effective = resolveEffectiveScope({ scope });
      const plan = resolveInvestigationExecutionPlan({ scope });
      const repositoryDownloadSelected = scope['repository-download'] === 'selected';
      const modelLoadSelected = scope['model-load'] === 'selected';
      const generationSelected = scope.generation === 'selected';
      const continuitySelected = scope.continuity === 'selected';
      const capabilityProbesSelected = scope['capability-probes'] === 'selected';
      const generationRequired = continuitySelected || capabilityProbesSelected;
      const modelLoadRequired = generationSelected || generationRequired;

      expect(plan, `scope mask ${mask}`).toEqual({
        repositoryDownload: repositoryDownloadSelected,
        modelLoad: modelLoadSelected || modelLoadRequired,
        generation: generationSelected || generationRequired,
        continuity: continuitySelected,
        capabilityProbes: capabilityProbesSelected,
      });
      expect(effective['repository-download'], `scope mask ${mask}`).toBe(
        repositoryDownloadSelected ? 'selected' : 'not-selected',
      );
      expect(effective['model-load'], `scope mask ${mask}`).toBe(
        modelLoadSelected ? 'selected' : (modelLoadRequired ? 'required' : 'not-selected'),
      );
      expect(effective.generation, `scope mask ${mask}`).toBe(
        generationSelected ? 'selected' : (generationRequired ? 'required' : 'not-selected'),
      );
    }
  });
});

describe('Model Support Investigation target parsing', () => {
  it.each([
    ['owner/repo', 'owner/repo'],
    ['hf.co/owner/repo', 'owner/repo'],
    ['huggingface.co/owner/repo', 'owner/repo'],
    ['https://hf.co/owner/repo', 'owner/repo'],
    ['https://huggingface.co/owner/repo/', 'owner/repo'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeInvestigationTarget({ input })).toBe(expected);
  });

  it.each([
    '',
    'owner',
    'owner/repo/extra',
    'https://example.com/owner/repo',
    'http://hf.co/owner/repo',
    'https://hf.co/owner/repo/tree/main',
    'https://hf.co/owner/%ZZ',
    'owner/repo?revision=main',
  ])('rejects an unsupported target form: %s', input => {
    expect(normalizeInvestigationTarget({ input })).toBeUndefined();
  });

  it('parses one model per line, ignores comments and blanks, and deduplicates in first-occurrence order', () => {
    const result = parseInvestigationTargets({
      text: `\
# reusable model set
owner/one
https://hf.co/owner/two

owner/one
hf.co/owner/three
`,
    });

    expect(result).toEqual({
      targets: ['owner/one', 'owner/two', 'owner/three'],
      errors: [],
    });
  });

  it('reports invalid lines without guessing a corrected model ID', () => {
    const result = parseInvestigationTargets({
      text: `\
owner/one
not-a-model-id
https://hf.co/owner/two/tree/main
`,
    });

    expect(result.targets).toEqual(['owner/one']);
    expect(result.errors).toEqual([
      { lineNumber: 2, input: 'not-a-model-id', reason: 'invalid-model-id' },
      { lineNumber: 3, input: 'https://hf.co/owner/two/tree/main', reason: 'invalid-model-id' },
    ]);
  });

  it('copies the canonical normalized list and round-trips through bulk parsing', () => {
    const copied = canonicalInvestigationTargetList({
      targets: ['hf.co/owner/one', 'https://huggingface.co/owner/two', 'owner/one'],
    });
    expect(copied).toBe(`\
owner/one
owner/two`);
    expect(parseInvestigationTargets({ text: copied }).targets).toEqual(['owner/one', 'owner/two']);
  });
});
