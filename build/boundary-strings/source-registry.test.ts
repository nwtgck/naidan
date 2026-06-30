import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createBoundaryStringSourceRegistry } from './source-registry';

function analysis({ keys }: {
  keys: readonly string[];
}) {
  return {
    importedBindingNames: ['lazyStrings'],
    keys,
  };
}

describe('Boundary Strings source registry', () => {
  it('replaces the current boundary with a deterministic new version', () => {
    const registry = createBoundaryStringSourceRegistry();
    const moduleId = path.resolve('/project/src/example.ts');
    const first = registry.replaceSource({
      analysis: analysis({ keys: ['Example__first'] }),
      boundaryRelativeModulePath: 'src/example.ts',
      moduleId,
    });
    const second = registry.replaceSource({
      analysis: analysis({ keys: ['Example__second'] }),
      boundaryRelativeModulePath: 'src/example.ts',
      moduleId,
    });

    expect(first.boundary?.id).toBe(second.boundary?.id);
    expect(first.boundary?.version).not.toBe(second.boundary?.version);
    expect(registry.getCurrentBoundary({ moduleId })).toEqual(second.boundary);
    expect(registry.getBoundary({
      boundaryId: first.boundary?.id ?? '',
      version: first.boundary?.version ?? '',
    })).toEqual(first.boundary);
  });

  it('keeps the previous record when a replacement collides', () => {
    const registry = createBoundaryStringSourceRegistry();
    const firstModuleId = path.resolve('/project/src/first.ts');
    const secondModuleId = path.resolve('/project/src/second.ts');
    const first = registry.replaceSource({
      analysis: analysis({ keys: ['Example__first'] }),
      boundaryRelativeModulePath: 'src/shared.ts',
      moduleId: firstModuleId,
    });
    const second = registry.replaceSource({
      analysis: analysis({ keys: ['Example__second'] }),
      boundaryRelativeModulePath: 'src/second.ts',
      moduleId: secondModuleId,
    });

    expect(() => registry.replaceSource({
      analysis: analysis({ keys: ['Example__replacement'] }),
      boundaryRelativeModulePath: 'src/shared.ts',
      moduleId: secondModuleId,
    })).toThrow('Boundary ID collision');
    expect(registry.getCurrentBoundary({ moduleId: firstModuleId })).toEqual(first.boundary);
    expect(registry.getCurrentBoundary({ moduleId: secondModuleId })).toEqual(second.boundary);
    expect(registry.getAnalysis({ moduleId: secondModuleId })).toEqual(second.analysis);
  });

  it('removes every retained boundary version when a source disappears', () => {
    const registry = createBoundaryStringSourceRegistry();
    const moduleId = path.resolve('/project/src/example.ts');
    const first = registry.replaceSource({
      analysis: analysis({ keys: ['Example__first'] }),
      boundaryRelativeModulePath: 'src/example.ts',
      moduleId,
    });
    const second = registry.replaceSource({
      analysis: analysis({ keys: ['Example__second'] }),
      boundaryRelativeModulePath: 'src/example.ts',
      moduleId,
    });

    expect(registry.removeSource({ moduleId })?.moduleId).toBe(moduleId);
    for (const boundary of [first.boundary, second.boundary]) {
      expect(registry.getBoundary({
        boundaryId: boundary?.id ?? '',
        version: boundary?.version ?? '',
      })).toBeUndefined();
    }
  });

  it('removes sources under a deleted directory without touching siblings', () => {
    const registry = createBoundaryStringSourceRegistry();
    const nested = path.resolve('/project/src/feature/nested.ts');
    const sibling = path.resolve('/project/src/feature-sibling.ts');
    for (const moduleId of [nested, sibling]) {
      registry.replaceSource({
        analysis: analysis({ keys: ['Example__message'] }),
        boundaryRelativeModulePath: path.relative('/project', moduleId),
        moduleId,
      });
    }

    expect(registry.removeSourcesUnder({
      directoryPath: path.resolve('/project/src/feature'),
    }).map((record) => record.moduleId)).toEqual([nested]);
    expect(registry.getCurrentBoundary({ moduleId: sibling })).toBeDefined();
  });

  it('removes a boundary when the source no longer uses any key', () => {
    const registry = createBoundaryStringSourceRegistry();
    const moduleId = path.resolve('/project/src/example.ts');
    registry.replaceSource({
      analysis: analysis({ keys: ['Example__message'] }),
      boundaryRelativeModulePath: 'src/example.ts',
      moduleId,
    });

    const record = registry.replaceSource({
      analysis: analysis({ keys: [] }),
      boundaryRelativeModulePath: 'src/example.ts',
      moduleId,
    });

    expect(record.boundary).toBeUndefined();
    expect(registry.getCurrentBoundary({ moduleId })).toBeUndefined();
  });
});
