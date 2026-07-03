import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCssOwnershipPlan } from './css-ownership-planner.mjs';

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

async function plan({ analysis, maxLazyCssGroups = 40 }: {
  analysis: ReturnType<typeof createAnalysis>,
  maxLazyCssGroups?: number,
}) {
  return createCssOwnershipPlan({
    projectRoot: path.resolve(import.meta.dirname, '../..'),
    cssEntryPath: path.resolve(import.meta.dirname, '../../src/style.css'),
    expectedTailwindVersion: '4.3.1',
    analysis,
    maxLazyCssGroups,
  });
}

describe('static Tailwind CSS ownership planner', () => {
  it('keeps canonical initial-to-lazy order split', async () => {
    const result = await plan({ analysis: createAnalysis({
      candidates: ['p-2', 'p-4'],
      candidateOwners: { 'p-2': ['initial'], 'p-4': ['lazy:feature.vue'] },
    }) });
    expect([...result.candidateOwners.get('p-4') ?? []]).toEqual(['lazy:feature.vue']);
  });

  it('promotes lazy CSS when load order would reverse Tailwind order', async () => {
    const result = await plan({ analysis: createAnalysis({
      candidates: ['p-4', 'p-2'],
      candidateOwners: { 'p-4': ['initial'], 'p-2': ['lazy:feature.vue'] },
    }) });
    expect([...result.candidateOwners.get('p-2') ?? []]).toEqual(['initial']);
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
    const result = await plan({ analysis, maxLazyCssGroups: 2 });
    expect(result.compression.candidates.originalLazyGroupCount).toBe(3);
    expect(result.compression.candidates.retainedLazyGroupCount).toBe(2);
    expect(result.cssGroups.size).toBeLessThanOrEqual(3);
  });
});
