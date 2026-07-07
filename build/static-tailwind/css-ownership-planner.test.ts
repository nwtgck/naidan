import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCssOwnerKey,
  createCssOwnershipPlan,
  parseCssOwnerKey,
  writeCssOwnershipDebugFiles,
} from './css-ownership-planner';

function createAnalysis({ candidateOwners, candidates }: {
  candidateOwners: Record<string, string[]>,
  candidates: string[],
}) {
  return {
    candidateGroups: [{
      id: 'fixture',
      filename: '/fixture/Fixture.vue',
      line: 1,
      column: 1,
      sourceKind: 'vue-template-element',
      candidates,
    }],
    candidateOwners: new Map(Object.entries(candidateOwners).map(([candidate, owners]) => [candidate, new Set(owners)])),
  };
}

async function plan({ analysis, outputMode, maxSplitCssGroups }: {
  analysis: ReturnType<typeof createAnalysis>,
  outputMode: 'single' | 'split',
  maxSplitCssGroups: number | undefined,
}) {
  return createCssOwnershipPlan({
    projectRoot: path.resolve(import.meta.dirname, '../..'),
    cssEntryPath: path.resolve(import.meta.dirname, '../../src/style.css'),
    expectedTailwindVersion: '4.3.1',
    analysis,
    outputMode,
    maxSplitCssGroups,
  });
}

function fragmentOrderContaining({ result, owner, needle }: {
  result: Awaited<ReturnType<typeof plan>>,
  owner: string,
  needle: string,
}): number | undefined {
  return result.runtimeFragmentsByOwner.get(owner)?.find(({ css }) => css.includes(needle))?.order;
}

describe('static Tailwind CSS ownership planner', () => {
  it('round-trips shared owner names without delimiter collisions', () => {
    const owners = ['module:src/Feature|Legacy.vue', 'module:src/Other.vue'];
    const key = createCssOwnerKey({ owners });

    expect(key).toBe(JSON.stringify([...owners].sort()));
    expect(parseCssOwnerKey({ key })).toEqual([...owners].sort());
    expect(() => parseCssOwnerKey({ key: '[not-json' })).toThrow(/Invalid serialized CSS owner key/u);
  });
  it('collapses all candidates into one initial group in single CSS mode', async () => {
    const result = await plan({
      analysis: createAnalysis({
        candidates: ['p-2', 'text-blue-500'],
        candidateOwners: {
          'p-2': ['initial'],
          'text-blue-500': ['lazy:feature.vue'],
        },
      }),
      outputMode: 'single',
      maxSplitCssGroups: undefined,
    });
    expect(result.outputMode).toBe('single');
    expect(result.cssGroups.size).toBe(1);
    expect(result.runtimeFragmentsByOwner.size).toBe(0);
    expect(result.entryCss).toBe(result.globalCss);
    expect([...result.candidateOwners.get('p-2') ?? []]).toEqual(['initial']);
    expect([...result.candidateOwners.get('text-blue-500') ?? []]).toEqual(['initial']);
    expect(result.globalCss).toContain('.text-blue-500');
  });

  it('retains generated license comments in the initial runtime fragment', async () => {
    const result = await plan({
      analysis: createAnalysis({
        candidates: ['p-2'],
        candidateOwners: { 'p-2': ['module:src/Feature.vue'] },
      }),
      outputMode: 'split',
      maxSplitCssGroups: undefined,
    });
    expect(result.cssGroups.get('initial')).toContain('/*! tailwindcss');
  });

  it('keeps canonical source order as runtime fragment order without nested cascade layers', async () => {
    const result = await plan({
      analysis: createAnalysis({
        candidates: ['p-2', 'p-4'],
        candidateOwners: { 'p-2': ['initial'], 'p-4': ['lazy:feature.vue'] },
      }),
      outputMode: 'split',
      maxSplitCssGroups: undefined,
    });
    const p2Order = fragmentOrderContaining({ result, owner: 'initial', needle: '.p-2' });
    const p4Order = fragmentOrderContaining({ result, owner: 'lazy:feature.vue', needle: '.p-4' });
    expect(p2Order).toBeDefined();
    expect(p4Order).toBeDefined();
    expect(Math.sign((p2Order ?? 0) - (p4Order ?? 0))).toBe(
      Math.sign(result.globalCss.indexOf('.p-2') - result.globalCss.indexOf('.p-4')),
    );
    expect([...result.cssGroups.values()].join('\n')).not.toContain('@layer utilities.naidan-');
    expect(result.entryCss).toBe('');
  });

  it('uses one runtime fragment for adjacent atoms in the same final CSS group', async () => {
    const owner = 'module:src/Feature.vue';
    const result = await plan({
      analysis: createAnalysis({
        candidates: ['p-2', 'p-4'],
        candidateOwners: { 'p-2': [owner], 'p-4': [owner] },
      }),
      outputMode: 'split',
      maxSplitCssGroups: undefined,
    });
    expect(result.runtimeFragmentsByOwner.get(owner)).toHaveLength(1);
    expect(result.metrics.ordering.runtimeFragmentCount).toBeGreaterThan(0);
  });

  it('keeps important utility rules lazy because runtime ordering preserves the original layer semantics', async () => {
    const result = await plan({
      analysis: createAnalysis({
        candidates: ['!p-2'],
        candidateOwners: { '!p-2': ['lazy:feature.vue'] },
      }),
      outputMode: 'split',
      maxSplitCssGroups: undefined,
    });
    expect(result.cssGroups.get('lazy:feature.vue')).toContain('.\\!p-2');
    expect(result.cssGroups.get('initial')).not.toContain('.\\!p-2');
  });

  it('keeps Autoprefixer-generated declarations with their lazy candidate owner', async () => {
    const owner = 'module:src/Feature.vue';
    const result = await plan({
      analysis: createAnalysis({
        candidates: ['appearance-none'],
        candidateOwners: { 'appearance-none': [owner] },
      }),
      outputMode: 'split',
      maxSplitCssGroups: undefined,
    });

    expect(result.cssGroups.get(owner)).toContain('.appearance-none');
    expect(result.cssGroups.get(owner)).toContain('-webkit-appearance: none');
    expect(result.cssGroups.get('initial')).not.toContain('.appearance-none');
  });

  it('maps compiled fallback rules to their source owners and keeps support CSS initial', async () => {
    const owner = 'module:src/Feature.vue';
    const result = await plan({
      analysis: createAnalysis({
        candidates: ['bg-blue-500/10'],
        candidateOwners: { 'bg-blue-500/10': [owner] },
      }),
      outputMode: 'split',
      maxSplitCssGroups: undefined,
    });

    expect(result.cssGroups.get(owner)).toContain('.bg-blue-500\\/10');
    expect(result.cssGroups.get('initial')).not.toContain('.bg-blue-500\\/10');
    expect(result.metrics.placement.sourceOwnedAtomCount).toBeGreaterThan(0);
    expect(result.metrics.placement.initialSupportAtomCount).toBeGreaterThan(0);
    expect(
      result.metrics.placement.sourceOwnedAtomCount
      + result.metrics.placement.initialSupportAtomCount,
    ).toBe(result.metrics.placement.globalAtomCount);
  });

  it('uses bounded debug filenames for large shared owner sets', () => {
    const owners = Array.from({ length: 80 }, (_, index) => (
      `lazy:features/large-owner-set/Component-${String(index).padStart(3, '0')}.vue`
    ));
    const ownerKey = createCssOwnerKey({ owners });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-debug-'));
    try {
      writeCssOwnershipDebugFiles({
        directory,
        plan: {
          outputMode: 'split',
          candidates: ['p-2'],
          candidateOwners: new Map([['p-2', new Set(owners)]]),
          ownerCandidateGroups: new Map([[ownerKey, ['p-2']]]),
          baselineCss: '',
          entryCss: '',
          globalCss: '.p-2 {}\n',
          globalDelta: '.p-2 {}\n',
          cssGroups: new Map([[ownerKey, '.p-2 {}\n']]),
          runtimeFragmentsByOwner: new Map([[ownerKey, [{ order: 7, css: '.p-2 {}\n' }]]]),
          conflicts: [],
          compression: {
            maxSplitCssGroups: undefined,
            candidates: {
              originalLazyGroupCount: 1,
              retainedLazyGroupCount: 1,
              retainedOwnerKeys: [ownerKey],
            },
            atoms: {
              originalLazyGroupCount: 1,
              retainedLazyGroupCount: 1,
              retainedOwnerKeys: [ownerKey],
            },
          },
          metrics: {
            baseline: { raw: 0, gzip: 0 },
            uniqueDelta: { raw: 8, gzip: 8 },
            ordering: {
              runtimeFragmentCount: 1,
              runtimeMetadataRaw: 1,
              runtimeMetadataGzip: 1,
            },
            placement: {
              globalAtomCount: 1,
              sourceOwnedAtomCount: 1,
              initialSupportAtomCount: 0,
            },
            emitted: {
              groupCount: 1,
              raw: 8,
              gzip: 8,
              duplicateAtomCount: 0,
              duplicateRaw: 0,
              duplicateRatio: 0,
              structuralOverheadRaw: 0,
            },
          },
          tailwindVersion: '4.3.1',
          stylesheetDependencies: [],
        },
      });
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'groups.json'), 'utf8')) as {
        groups: Record<string, {
          filename: string,
          ownerKey: string,
          fragmentCount: number,
          fragmentOrders: number[],
        }>,
      };
      const [group] = Object.values(manifest.groups);
      expect(group).toBeDefined();
      expect(group?.filename).toMatch(/^group-[a-f0-9]{64}\.css$/u);
      expect(group?.filename.length).toBeLessThan(96);
      expect(group?.ownerKey).toBe(ownerKey);
      expect(group?.fragmentCount).toBe(1);
      expect(group?.fragmentOrders).toEqual([7]);
      expect(fs.existsSync(path.join(directory, group?.filename ?? 'missing'))).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects inconsistent or ownerless source analysis before CSS compilation', async () => {
    const base = createAnalysis({
      candidates: ['p-2'],
      candidateOwners: { 'p-2': ['initial'] },
    });
    await expect(plan({
      analysis: {
        ...base,
        candidateOwners: new Map(),
      },
      outputMode: 'split',
      maxSplitCssGroups: undefined,
    })).rejects.toThrow(/candidates missing owner entries: p-2/u);

    await expect(plan({
      analysis: {
        ...base,
        candidateGroups: [],
      },
      outputMode: 'split',
      maxSplitCssGroups: undefined,
    })).rejects.toThrow(/owner entries missing source occurrences: p-2/u);

    await expect(plan({
      analysis: {
        ...base,
        candidateOwners: new Map([['p-2', new Set()]]),
      },
      outputMode: 'split',
      maxSplitCssGroups: undefined,
    })).rejects.toThrow(/candidates with invalid or empty owner sets: p-2/u);
  });

  it('rejects invalid lazy group limits before compiling CSS', async () => {
    await expect(plan({
      analysis: createAnalysis({
        candidates: ['p-2'],
        candidateOwners: { 'p-2': ['initial'] },
      }),
      outputMode: 'split',
      maxSplitCssGroups: -1,
    })).rejects.toThrow('maxSplitCssGroups must be a non-negative integer');
  });

  it('promotes the smallest excess CSS group instead of a larger shared group', async () => {
    const sharedOwners = ['module:src/FeatureA.vue', 'module:src/FeatureB.vue'];
    const sharedOwnerKey = createCssOwnerKey({ owners: sharedOwners });
    const privateOwnerKey = 'module:src/FeatureC.vue';
    const result = await plan({
      analysis: createAnalysis({
        candidates: ['shadow-2xl', 'p-px'],
        candidateOwners: {
          'shadow-2xl': sharedOwners,
          'p-px': [privateOwnerKey],
        },
      }),
      outputMode: 'split',
      maxSplitCssGroups: 1,
    });

    expect(result.compression.atoms.retainedOwnerKeys).toEqual([sharedOwnerKey]);
    expect(result.cssGroups.get(sharedOwnerKey)).toContain('.shadow-2xl');
    expect(result.cssGroups.get('initial')).toContain('.p-px');
    expect(result.cssGroups.has(privateOwnerKey)).toBe(false);
  });

  it('caps lazy ownership groups without duplicate CSS atoms', async () => {
    const analysis = {
      candidateGroups: [
        { id: 'red', filename: '/fixture/red.vue', line: 1, column: 1, sourceKind: 'vue-template-element', candidates: ['bg-red-500'] },
        { id: 'blue', filename: '/fixture/blue.vue', line: 1, column: 1, sourceKind: 'vue-template-element', candidates: ['text-blue-500'] },
        { id: 'green', filename: '/fixture/green.vue', line: 1, column: 1, sourceKind: 'vue-template-element', candidates: ['border-green-500'] },
      ],
      candidateOwners: new Map([
        ['bg-red-500', new Set(['lazy:red.vue'])],
        ['text-blue-500', new Set(['lazy:blue.vue'])],
        ['border-green-500', new Set(['lazy:green.vue'])],
      ]),
    };
    const result = await plan({ analysis, outputMode: 'split', maxSplitCssGroups: 2 });
    expect(result.compression.candidates.originalLazyGroupCount).toBe(3);
    expect(result.compression.candidates.retainedLazyGroupCount).toBe(3);
    expect(result.compression.atoms.retainedLazyGroupCount).toBe(2);
    expect(result.cssGroups.size).toBeLessThanOrEqual(3);
  });
});
