import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCssOwnershipPlan, writeCssOwnershipDebugFiles } from './css-ownership-planner.mjs';

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

async function plan({ analysis, maxLazyCssGroups }: {
  analysis: ReturnType<typeof createAnalysis>,
  maxLazyCssGroups: number | undefined,
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
    }), maxLazyCssGroups: undefined });
    expect([...result.candidateOwners.get('p-4') ?? []]).toEqual(['lazy:feature.vue']);
  });

  it('promotes lazy CSS when load order would reverse Tailwind order', async () => {
    const result = await plan({ analysis: createAnalysis({
      candidates: ['p-4', 'p-2'],
      candidateOwners: { 'p-4': ['initial'], 'p-2': ['lazy:feature.vue'] },
    }), maxLazyCssGroups: undefined });
    expect([...result.candidateOwners.get('p-2') ?? []]).toEqual(['initial']);
  });

  it('uses bounded debug filenames for large shared owner sets', () => {
    const ownerKey = Array.from({ length: 80 }, (_, index) => (
      `lazy:features/large-owner-set/Component-${String(index).padStart(3, '0')}.vue`
    )).join('|');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-tailwind-debug-'));
    try {
      writeCssOwnershipDebugFiles({
        directory,
        plan: {
          candidates: ['p-2'],
          candidateOwners: new Map([['p-2', new Set(ownerKey.split('|'))]]),
          ownerCandidateGroups: new Map([[ownerKey, ['p-2']]]),
          baselineCss: '',
          globalCss: '.p-2 {}\n',
          globalDelta: '.p-2 {}\n',
          cssGroups: new Map([[ownerKey, '.p-2 {}\n']]),
          conflicts: [],
          compression: {
            maxLazyCssGroups: undefined,
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
          metrics: {},
          tailwindVersion: '4.3.1',
        },
      });
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'groups.json'), 'utf8')) as {
        groups: Record<string, { filename: string, ownerKey: string }>,
      };
      const [group] = Object.values(manifest.groups);
      expect(group).toBeDefined();
      expect(group?.filename).toMatch(/^group-[a-f0-9]{64}\.css$/u);
      expect(group?.filename.length).toBeLessThan(96);
      expect(group?.ownerKey).toBe(ownerKey);
      expect(fs.existsSync(path.join(directory, group?.filename ?? 'missing'))).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
