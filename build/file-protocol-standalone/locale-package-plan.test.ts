import { RUNTIME_MODULE_ID } from 'rolldown';
import { describe, expect, it } from 'vitest';
import {
  assertLocalePackageModuleEdgeSafety,
  assertLocalePackageWorkerEntryProvenance,
  collectPackageModuleGraph,
  createLocalePackagePlan,
  type PackageChunk,
  type PackageModuleGraph,
} from './plugin/locale-package-plan.js';
import {
  RESOLVED_BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX,
  RESOLVED_BOUNDARY_STRINGS_PACK_MODULE_PREFIX,
} from '../boundary-strings/virtual-modules.js';

const locales = ['en', 'ja'] as const;

function modules(entries: Readonly<Record<string, number>>): PackageChunk['modules'] {
  return Object.fromEntries(Object.entries(entries).map(([id, renderedLength]) => [id, { renderedLength }]));
}

function chunk(overrides: Partial<PackageChunk> & Pick<PackageChunk, 'fileName'>): PackageChunk {
  return {
    fileName: overrides.fileName,
    isEntry: overrides.isEntry ?? false,
    imports: overrides.imports ?? [],
    dynamicImports: overrides.dynamicImports ?? [],
    modules: overrides.modules ?? modules({ [`/src/${overrides.fileName}.ts`]: 10 }),
  };
}

function pack(locale: string, id = '1111111111111111', version = 'aaaaaaaaaaaaaaaa'): string {
  return `${RESOLVED_BOUNDARY_STRINGS_PACK_MODULE_PREFIX}${locale}/${id}/${version}`;
}

function boundary(id = '1111111111111111', version = 'aaaaaaaaaaaaaaaa'): string {
  return `${RESOLVED_BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX}${id}/${version}`;
}


function renderedIds(outputChunk: PackageChunk): string[] {
  return Object.entries(outputChunk.modules)
    .filter(([, info]) => info.renderedLength > 0)
    .map(([moduleId]) => moduleId.replaceAll('\\', '/'));
}

function inferredModuleGraph(graph: readonly PackageChunk[]): Map<string, { importedIds: string[]; dynamicallyImportedIds: string[]; isEntry?: boolean }> {
  const result = new Map<string, { importedIds: string[]; dynamicallyImportedIds: string[]; isEntry?: boolean }>();
  const chunksByFileName = new Map(graph.map((outputChunk) => [outputChunk.fileName, outputChunk]));

  for (const outputChunk of graph) {
    for (const moduleId of renderedIds(outputChunk)) {
      result.set(moduleId, { importedIds: [], dynamicallyImportedIds: [] });
    }
  }

  for (const outputChunk of graph) {
    if (!outputChunk.isEntry) continue;
    // Synthetic graph convenience only. Production semantic roots come from
    // Rollup/Rolldown ModuleInfo.isEntry via collectPackageModuleGraph().
    const entryModuleId = renderedIds(outputChunk)[0];
    if (entryModuleId !== undefined) result.get(entryModuleId)!.isEntry = true;
  }

  const targetModuleId = (fileName: string): string => {
    const targetChunk = chunksByFileName.get(fileName);
    if (targetChunk === undefined) return `/__missing__/${fileName}`;
    const targetIds = renderedIds(targetChunk);
    const packRoot = targetIds.find((moduleId) => moduleId.startsWith(RESOLVED_BOUNDARY_STRINGS_PACK_MODULE_PREFIX));
    const target = packRoot ?? targetIds[0];
    if (target === undefined) throw new Error(`Test chunk has no rendered module: ${fileName}`);
    return target;
  };

  for (const sourceChunk of graph) {
    const sourceIds = renderedIds(sourceChunk);
    const boundaryId = sourceIds.find((moduleId) => moduleId.startsWith(RESOLVED_BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX));
    const packId = sourceIds.find((moduleId) => moduleId.startsWith(RESOLVED_BOUNDARY_STRINGS_PACK_MODULE_PREFIX));
    const defaultSourceId = packId
      ?? sourceIds.find((moduleId) => !moduleId.startsWith(RESOLVED_BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX))
      ?? boundaryId;
    if (defaultSourceId === undefined) continue;

    // Synthetic chunks intentionally coalesce the entry facade and Boundary
    // registration. Model the semantic edge explicitly instead of treating
    // physical co-location as reachability.
    const syntheticEntryModuleId = sourceChunk.isEntry ? sourceIds[0] : undefined;
    if (syntheticEntryModuleId !== undefined
      && boundaryId !== undefined
      && syntheticEntryModuleId !== boundaryId) {
      result.get(syntheticEntryModuleId)?.importedIds.push(boundaryId);
    }

    for (const imported of sourceChunk.imports) {
      result.get(defaultSourceId)?.importedIds.push(targetModuleId(imported));
    }
    for (const imported of sourceChunk.dynamicImports) {
      const targetId = targetModuleId(imported);
      const sourceId = targetId.startsWith(RESOLVED_BOUNDARY_STRINGS_PACK_MODULE_PREFIX) && boundaryId !== undefined
        ? boundaryId
        : defaultSourceId;
      result.get(sourceId)?.dynamicallyImportedIds.push(targetId);
    }
  }

  return result;
}

function createPlan({
  chunks,
  targetLocale,
  supportedLocales,
}: Readonly<{
  chunks: readonly PackageChunk[];
  targetLocale: string;
  supportedLocales: readonly string[];
}>) {
  return createLocalePackagePlan({
    chunks,
    moduleGraph: inferredModuleGraph(chunks),
    targetLocale,
    supportedLocales,
  });
}

function happyGraph(): PackageChunk[] {
  return [
    chunk({
      fileName: 'ui.js',
      isEntry: true,
      dynamicImports: ['en-root.js', 'ja-root.js', 'common-lazy.js'],
      modules: modules({ '/src/main.ts': 40, [boundary()]: 30 }),
    }),
    chunk({ fileName: 'worker.js', isEntry: true, dynamicImports: ['worker-lazy.js'] }),
    chunk({
      fileName: 'en-root.js',
      imports: ['shared.js', 'en-helper.js'],
      modules: modules({ [pack('en')]: 20, '/src/strings/messages/demo/en.ts': 30 }),
    }),
    chunk({
      fileName: 'ja-root.js',
      imports: ['shared.js', 'ja-helper.js'],
      modules: modules({ [pack('ja')]: 20, '/src/strings/messages/demo/ja.ts': 30 }),
    }),
    chunk({ fileName: 'shared.js' }),
    chunk({ fileName: 'en-helper.js' }),
    chunk({ fileName: 'ja-helper.js' }),
    chunk({ fileName: 'common-lazy.js' }),
    chunk({ fileName: 'worker-lazy.js' }),
  ];
}

describe('locale package projection', () => {
  it('removes only the foreign-exclusive closure and retains shared/common/worker chunks', () => {
    const plan = createPlan({ chunks: happyGraph(), targetLocale: 'ja', supportedLocales: locales });
    expect([...plan.removeChunkFileNames].sort()).toEqual(['en-helper.js', 'en-root.js']);
    expect(plan.retainedChunkFileNames.has('shared.js')).toBe(true);
    expect(plan.retainedChunkFileNames.has('common-lazy.js')).toBe(true);
    expect(plan.retainedChunkFileNames.has('worker.js')).toBe(true);
    expect(plan.retainedChunkFileNames.has('worker-lazy.js')).toBe(true);
    expect(plan.retainedChunkFileNames.has('ja-helper.js')).toBe(true);
  });

  it('is symmetric for the opposite locale', () => {
    const plan = createPlan({ chunks: happyGraph(), targetLocale: 'en', supportedLocales: locales });
    expect([...plan.removeChunkFileNames].sort()).toEqual(['ja-helper.js', 'ja-root.js']);
    expect(plan.retainedChunkFileNames.has('shared.js')).toBe(true);
  });


  it('uses module semantics when registration and a locale helper share one physical chunk', () => {
    const serviceId = '/src/shared-storage-service.ts';
    const helperId = '/src/strings/shared.ts';
    const enMessageId = '/src/strings/messages/demo/en.ts';
    const jaMessageId = '/src/strings/messages/demo/ja.ts';
    const graph: PackageChunk[] = [
      chunk({
        fileName: 'ui.js',
        isEntry: true,
        imports: ['shared-with-registration.js'],
        modules: modules({ '/src/main.ts': 30 }),
      }),
      chunk({
        fileName: 'worker.js',
        isEntry: true,
        imports: ['shared-with-registration.js'],
        modules: modules({ '/src/worker.ts': 30 }),
      }),
      chunk({
        fileName: 'shared-with-registration.js',
        dynamicImports: ['en-root.js', 'ja-root.js'],
        modules: modules({ [boundary()]: 30, [serviceId]: 20, [helperId]: 20 }),
      }),
      chunk({
        fileName: 'en-root.js',
        imports: ['shared-with-registration.js'],
        modules: modules({ [pack('en')]: 20, [enMessageId]: 30 }),
      }),
      chunk({
        fileName: 'ja-root.js',
        imports: ['shared-with-registration.js'],
        modules: modules({ [pack('ja')]: 20, [jaMessageId]: 30 }),
      }),
    ];
    const moduleGraph: PackageModuleGraph = new Map([
      ['/src/main.ts', { importedIds: [serviceId], dynamicallyImportedIds: [], isEntry: true }],
      ['/src/worker.ts', { importedIds: [serviceId], dynamicallyImportedIds: [], isEntry: true }],
      [serviceId, { importedIds: [boundary()], dynamicallyImportedIds: [] }],
      [boundary(), { importedIds: [], dynamicallyImportedIds: [pack('en'), pack('ja')] }],
      [pack('en'), { importedIds: [enMessageId], dynamicallyImportedIds: [] }],
      [enMessageId, { importedIds: [helperId], dynamicallyImportedIds: [] }],
      [pack('ja'), { importedIds: [jaMessageId], dynamicallyImportedIds: [] }],
      [jaMessageId, { importedIds: [helperId], dynamicallyImportedIds: [] }],
      [helperId, { importedIds: [], dynamicallyImportedIds: [] }],
    ]);

    const plan = createLocalePackagePlan({
      chunks: graph,
      moduleGraph,
      targetLocale: 'en',
      supportedLocales: locales,
    });

    expect([...plan.removeChunkFileNames]).toEqual(['ja-root.js']);
    expect(plan.retainedChunkFileNames.has('shared-with-registration.js')).toBe(true);
    expect(plan.retainedChunkFileNames.has('en-root.js')).toBe(true);
    expect(() => assertLocalePackageModuleEdgeSafety({
      chunks: graph,
      plan,
      moduleGraph,
      supportedLocales: locales,
    })).not.toThrow();
  });

  it('rejects a locale pack loader from a different Boundary identity', () => {
    const graph = happyGraph();
    graph[0] = chunk({
      fileName: 'ui.js',
      isEntry: true,
      dynamicImports: ['en-root.js', 'ja-root.js', 'common-lazy.js'],
      modules: modules({
        '/src/main.ts': 40,
        [boundary('2222222222222222', 'bbbbbbbbbbbbbbbb')]: 30,
      }),
    });

    expect(() => createPlan({
      chunks: graph,
      targetLocale: 'ja',
      supportedLocales: locales,
    })).toThrow(/outside its Boundary Strings registration/u);
  });

  it('does not treat every module coalesced into an entry chunk as a semantic entry root', () => {
    const graph = happyGraph();
    graph[0] = chunk({
      fileName: 'ui.js',
      isEntry: true,
      dynamicImports: ['en-root.js', 'ja-root.js', 'common-lazy.js'],
      modules: modules({
        '/src/main.ts': 40,
        '/src/strings/locale-helpers/en-entry-coalesced.ts': 20,
        [boundary()]: 30,
      }),
    });
    const moduleGraph = inferredModuleGraph(graph);
    moduleGraph.get(pack('en'))?.importedIds.push('/src/strings/locale-helpers/en-entry-coalesced.ts');

    const plan = createLocalePackagePlan({
      chunks: graph,
      moduleGraph,
      targetLocale: 'ja',
      supportedLocales: locales,
    });
    expect(() => assertLocalePackageModuleEdgeSafety({
      chunks: graph,
      plan,
      moduleGraph,
      supportedLocales: locales,
    })).toThrow(/Foreign-only module would remain/u);
  });

  it('ignores zero-rendered facade provenance', () => {
    const graph = happyGraph();
    const commonIndex = graph.findIndex((value) => value.fileName === 'common-lazy.js');
    graph[commonIndex] = chunk({
      fileName: 'common-lazy.js',
      modules: modules({ '/src/features/common-lazy.ts': 10, [pack('en', '9999999999999999', 'cccccccccccccccc')]: 0 }),
    });
    expect(() => createPlan({ chunks: graph, targetLocale: 'ja', supportedLocales: locales })).not.toThrow();
  });


  it('projects more than two canonical locale codes without changing the algorithm', () => {
    const supported = ['en', 'ja', 'pt-BR'] as const;
    const graph: PackageChunk[] = [
      chunk({
        fileName: 'ui.js',
        isEntry: true,
        dynamicImports: ['en-root.js', 'ja-root.js', 'pt-root.js', 'common.js'],
        modules: modules({ '/src/main.ts': 30, [boundary()]: 30 }),
      }),
      chunk({
        fileName: 'en-root.js',
        imports: ['shared.js', 'en-only.js'],
        modules: modules({ [pack('en')]: 10, '/src/strings/messages/demo/en.ts': 20 }),
      }),
      chunk({
        fileName: 'ja-root.js',
        imports: ['shared.js', 'ja-only.js'],
        modules: modules({ [pack('ja')]: 10, '/src/strings/messages/demo/ja.ts': 20 }),
      }),
      chunk({
        fileName: 'pt-root.js',
        imports: ['shared.js', 'pt-only.js'],
        modules: modules({ [pack('pt-BR')]: 10, '/src/strings/messages/demo/pt-BR.ts': 20 }),
      }),
      chunk({ fileName: 'shared.js' }),
      chunk({ fileName: 'en-only.js' }),
      chunk({ fileName: 'ja-only.js' }),
      chunk({ fileName: 'pt-only.js' }),
      chunk({ fileName: 'common.js' }),
    ];
    const plan = createPlan({ chunks: graph, targetLocale: 'ja', supportedLocales: supported });
    expect([...plan.removeChunkFileNames].sort()).toEqual(['en-only.js', 'en-root.js', 'pt-only.js', 'pt-root.js']);
    expect(plan.retainedChunkFileNames.has('shared.js')).toBe(true);
    expect(plan.retainedChunkFileNames.has('ja-root.js')).toBe(true);
  });

  it('fails if one emitted chunk mixes locale payloads', () => {
    const graph = happyGraph().filter((value) => !['en-root.js', 'ja-root.js'].includes(value.fileName));
    graph[0] = chunk({
      fileName: 'ui.js',
      isEntry: true,
      dynamicImports: ['mixed-root.js', 'common-lazy.js'],
      modules: modules({ '/src/main.ts': 40, [boundary()]: 30 }),
    });
    graph.push(chunk({
      fileName: 'mixed-root.js',
      imports: ['shared.js'],
      modules: modules({
        [pack('en')]: 10,
        [pack('ja')]: 10,
        '/src/strings/messages/demo/en.ts': 10,
        '/src/strings/messages/demo/ja.ts': 10,
      }),
    }));
    expect(() => createPlan({ chunks: graph, targetLocale: 'ja', supportedLocales: locales })).toThrow(/mixes Boundary Strings payload locales/u);
  });

  it('fails rather than retaining foreign string payload inside a shared chunk', () => {
    const graph = happyGraph();
    const sharedIndex = graph.findIndex((value) => value.fileName === 'shared.js');
    graph[sharedIndex] = chunk({
      fileName: 'shared.js',
      modules: modules({ '/src/shared.ts': 10, '/src/strings/messages/accidental/en.ts': 10 }),
    });
    expect(() => createPlan({ chunks: graph, targetLocale: 'ja', supportedLocales: locales })).toThrow(/Foreign Boundary Strings payload would remain/u);
  });

  it('fails on an unknown pack locale instead of treating it as common', () => {
    const graph = happyGraph();
    graph.push(chunk({ fileName: 'unknown.js', modules: modules({ [`${RESOLVED_BOUNDARY_STRINGS_PACK_MODULE_PREFIX}fr/3333333333333333/dddddddddddddddd`]: 10 }) }));
    expect(() => createPlan({ chunks: graph, targetLocale: 'ja', supportedLocales: locales })).toThrow(/Unknown Boundary Strings pack locale/u);
  });

  it('fails if a locale pack root is statically imported', () => {
    const graph = happyGraph();
    graph[0] = chunk({
      fileName: 'ui.js',
      isEntry: true,
      imports: ['en-root.js'],
      dynamicImports: ['ja-root.js', 'common-lazy.js'],
      modules: modules({ '/src/main.ts': 40, [boundary()]: 30 }),
    });
    expect(() => createPlan({ chunks: graph, targetLocale: 'ja', supportedLocales: locales })).toThrow(/static incoming edge/u);
  });

  it('fails if unrelated code dynamically imports a locale pack root', () => {
    const graph = happyGraph();
    const commonIndex = graph.findIndex((value) => value.fileName === 'common-lazy.js');
    graph[commonIndex] = chunk({ fileName: 'common-lazy.js', dynamicImports: ['en-root.js'] });
    expect(() => createPlan({ chunks: graph, targetLocale: 'ja', supportedLocales: locales })).toThrow(/outside its Boundary Strings registration/u);
  });

  it('fails if a foreign payload is orphaned outside the foreign root closure', () => {
    const graph = happyGraph();
    graph.push(chunk({
      fileName: 'orphan-en.js',
      modules: modules({ '/src/strings/messages/orphan/en.ts': 10 }),
    }));
    expect(() => createPlan({ chunks: graph, targetLocale: 'ja', supportedLocales: locales })).toThrow(/Foreign Boundary Strings payload would remain/u);
  });

  it('fails if an output edge points to a missing chunk', () => {
    const graph = happyGraph();
    graph[0] = chunk({
      fileName: 'ui.js',
      isEntry: true,
      dynamicImports: ['en-root.js', 'ja-root.js', 'missing.js'],
      modules: modules({ '/src/main.ts': 40, [boundary()]: 30 }),
    });
    expect(() => createPlan({ chunks: graph, targetLocale: 'ja', supportedLocales: locales })).toThrow(/missing output chunk/u);
  });
});


describe('module graph collection', () => {
  it('preserves non-rendered semantic modules between an entry and rendered output', () => {
    const infos = new Map([
      ['/index.html', { importedIds: ['virtual:entry-bridge'], dynamicallyImportedIds: [], isEntry: true }],
      ['virtual:entry-bridge', { importedIds: ['/src/main.ts'], dynamicallyImportedIds: [], isEntry: false }],
      ['/src/main.ts', { importedIds: [], dynamicallyImportedIds: [], isEntry: false }],
    ]);
    const graph = collectPackageModuleGraph({
      chunks: [chunk({ fileName: 'ui.js', modules: modules({ '/src/main.ts': 40 }) })],
      getModuleIds: () => infos.keys(),
      getModuleInfo: moduleId => infos.get(moduleId) ?? null,
    });

    expect(graph.get('/index.html')).toEqual({
      importedIds: ['virtual:entry-bridge'],
      dynamicallyImportedIds: [],
      isEntry: true,
    });
    expect(graph.get('virtual:entry-bridge')).toEqual({
      importedIds: ['/src/main.ts'],
      dynamicallyImportedIds: [],
      isEntry: false,
    });
    expect(graph.get('/src/main.ts')).toEqual({
      importedIds: [],
      dynamicallyImportedIds: [],
      isEntry: false,
    });
  });

  it('treats the Rolldown synthetic runtime as a bundler-owned leaf', () => {
    const graph = collectPackageModuleGraph({
      chunks: [chunk({
        fileName: 'ui.js',
        isEntry: true,
        modules: modules({
          [RUNTIME_MODULE_ID]: 1124,
          '/src/main.ts': 40,
        }),
      })],
      getModuleIds: () => ['/src/main.ts', RUNTIME_MODULE_ID][Symbol.iterator](),
      getModuleInfo: moduleId => moduleId === RUNTIME_MODULE_ID
        ? null
        : { importedIds: ['/src/helper.ts'], dynamicallyImportedIds: [], isEntry: moduleId === '/src/main.ts' },
    });

    expect(graph.get(RUNTIME_MODULE_ID)).toEqual({
      importedIds: [],
      dynamicallyImportedIds: [],
    });
    expect(graph.get('/src/main.ts')).toEqual({
      importedIds: ['/src/helper.ts'],
      dynamicallyImportedIds: [],
      isEntry: true,
    });
  });

  it('still fails closed for any other rendered module without Rollup provenance', () => {
    expect(() => collectPackageModuleGraph({
      chunks: [chunk({
        fileName: 'ui.js',
        isEntry: true,
        modules: modules({ '/src/main.ts': 40 }),
      })],
      getModuleIds: () => [][Symbol.iterator](),
      getModuleInfo: () => null,
    })).toThrow(/Rollup getModuleInfo returned null for rendered module/u);
  });
});

describe('module-level edge provenance', () => {
  function emptyModuleGraph(graph: readonly PackageChunk[]): Map<string, { importedIds: string[]; dynamicallyImportedIds: string[]; isEntry?: boolean }> {
    const result = new Map<string, { importedIds: string[]; dynamicallyImportedIds: string[]; isEntry?: boolean }>();
    for (const outputChunk of graph) {
      for (const [moduleId, info] of Object.entries(outputChunk.modules)) {
        if (info.renderedLength > 0) result.set(moduleId.replaceAll('\\', '/'), { importedIds: [], dynamicallyImportedIds: [] });
      }
    }
    return result;
  }

  it('rejects an unrelated dynamic import hidden in a chunk that also contains a boundary registration', () => {
    const graph = happyGraph();
    graph[0] = chunk({
      fileName: 'ui.js',
      isEntry: true,
      dynamicImports: ['en-root.js', 'ja-root.js', 'common-lazy.js'],
      modules: modules({ '/src/main.ts': 40, '/src/unrelated.ts': 20, [boundary()]: 30 }),
    });

    // Chunk-only planning cannot distinguish which module owns ui.js -> en-root.js,
    // so the projection itself still looks valid.
    const plan = createPlan({ chunks: graph, targetLocale: 'ja', supportedLocales: locales });
    expect(plan.removeChunkFileNames.has('en-root.js')).toBe(true);

    const moduleGraph = emptyModuleGraph(graph);
    moduleGraph.get(boundary())?.dynamicallyImportedIds.push(pack('en'), pack('ja'));
    moduleGraph.get('/src/unrelated.ts')?.dynamicallyImportedIds.push(pack('en'));

    expect(() => assertLocalePackageModuleEdgeSafety({
      chunks: graph,
      plan,
      moduleGraph: moduleGraph as PackageModuleGraph,
      supportedLocales: locales,
    })).toThrow(/outside an authorized Boundary Strings loader/u);
  });

  it('allows only the generated boundary-registration edge into a removed foreign root', () => {
    const graph = happyGraph();
    const plan = createPlan({ chunks: graph, targetLocale: 'ja', supportedLocales: locales });
    const moduleGraph = emptyModuleGraph(graph);
    moduleGraph.get(boundary())?.dynamicallyImportedIds.push(pack('en'), pack('ja'));

    expect(() => assertLocalePackageModuleEdgeSafety({
      chunks: graph,
      plan,
      moduleGraph: moduleGraph as PackageModuleGraph,
      supportedLocales: locales,
    })).not.toThrow();
  });

  it('rejects foreign-only helper code that survives only because its chunk also contains retained code', () => {
    const graph = happyGraph();
    graph[0] = chunk({
      fileName: 'ui.js',
      isEntry: true,
      imports: ['mixed-helper.js'],
      dynamicImports: ['en-root.js', 'ja-root.js', 'common-lazy.js'],
      modules: modules({ '/src/main.ts': 40, [boundary()]: 30 }),
    });
    const enRootIndex = graph.findIndex((value) => value.fileName === 'en-root.js');
    graph[enRootIndex] = chunk({
      fileName: 'en-root.js',
      imports: ['shared.js', 'mixed-helper.js'],
      modules: modules({ [pack('en')]: 20, '/src/strings/messages/demo/en.ts': 30 }),
    });
    const oldHelperIndex = graph.findIndex((value) => value.fileName === 'en-helper.js');
    graph.splice(oldHelperIndex, 1);
    graph.push(chunk({
      fileName: 'mixed-helper.js',
      modules: modules({
        '/src/common-owned.ts': 20,
        '/src/strings/locale-helpers/en-only.ts': 20,
      }),
    }));

    const plan = createPlan({ chunks: graph, targetLocale: 'ja', supportedLocales: locales });
    expect(plan.retainedChunkFileNames.has('mixed-helper.js')).toBe(true);

    const moduleGraph = emptyModuleGraph(graph);
    moduleGraph.get(boundary())?.dynamicallyImportedIds.push(pack('en'), pack('ja'));
    moduleGraph.get('/src/main.ts')?.importedIds.push('/src/common-owned.ts');
    moduleGraph.get(pack('en'))?.importedIds.push('/src/strings/messages/demo/en.ts');
    moduleGraph.get('/src/strings/messages/demo/en.ts')?.importedIds.push('/src/strings/locale-helpers/en-only.ts');

    expect(() => assertLocalePackageModuleEdgeSafety({
      chunks: graph,
      plan,
      moduleGraph: moduleGraph as PackageModuleGraph,
      supportedLocales: locales,
    })).toThrow(/Foreign-only module would remain/u);
  });

  it('keeps a retained entry that is also reachable through a foreign semantic cycle', () => {
    const graph = happyGraph();
    const enRootIndex = graph.findIndex((value) => value.fileName === 'en-root.js');
    graph[enRootIndex] = chunk({
      fileName: 'en-root.js',
      imports: ['shared.js', 'en-helper.js', 'ui.js'],
      modules: modules({ [pack('en')]: 20, '/src/strings/messages/demo/en.ts': 30 }),
    });
    const moduleGraph = inferredModuleGraph(graph);
    const plan = createLocalePackagePlan({
      chunks: graph,
      moduleGraph,
      targetLocale: 'ja',
      supportedLocales: locales,
    });

    expect(plan.retainedChunkFileNames.has('ui.js')).toBe(true);
    expect(plan.removeChunkFileNames.has('en-root.js')).toBe(true);
    expect(() => assertLocalePackageModuleEdgeSafety({
      chunks: graph,
      plan,
      moduleGraph,
      supportedLocales: locales,
    })).not.toThrow();
  });

  it('ignores duplicate zero-rendered facade ownership', () => {
    const graph = happyGraph();
    const commonIndex = graph.findIndex(value => value.fileName === 'common-lazy.js');
    const workerIndex = graph.findIndex(value => value.fileName === 'worker-lazy.js');
    graph[commonIndex] = chunk({
      fileName: 'common-lazy.js',
      modules: modules({ '/src/features/common-lazy.ts': 10, '/src/zero-facade.ts': 0 }),
    });
    graph[workerIndex] = chunk({
      fileName: 'worker-lazy.js',
      modules: modules({ '/src/features/worker-lazy.ts': 10, '/src/zero-facade.ts': 0 }),
    });
    const plan = createPlan({ chunks: graph, targetLocale: 'ja', supportedLocales: locales });
    const moduleGraph = emptyModuleGraph(graph);
    moduleGraph.get(boundary())?.dynamicallyImportedIds.push(pack('en'), pack('ja'));

    expect(() => assertLocalePackageModuleEdgeSafety({
      chunks: graph,
      plan,
      moduleGraph,
      supportedLocales: locales,
    })).not.toThrow();
  });

  it('fails closed when rendered-module edge provenance is missing', () => {
    const graph = happyGraph();
    const plan = createPlan({ chunks: graph, targetLocale: 'ja', supportedLocales: locales });
    const moduleGraph = emptyModuleGraph(graph);
    moduleGraph.delete('/src/main.ts');
    expect(() => assertLocalePackageModuleEdgeSafety({
      chunks: graph,
      plan,
      moduleGraph,
      supportedLocales: locales,
    })).toThrow(/Missing module-edge provenance/u);
  });
});

describe('Worker entry provenance', () => {
  it('allows Worker graphs that reach Strings when the entry provenance is present', () => {
    const moduleGraph: PackageModuleGraph = new Map([
      ['/src/worker.ts', { importedIds: ['/src/strings/runtime.ts'], dynamicallyImportedIds: [] }],
      ['/src/strings/runtime.ts', { importedIds: [], dynamicallyImportedIds: [] }],
    ]);

    expect(() => assertLocalePackageWorkerEntryProvenance({
      moduleGraph,
      workerEntryModuleIds: ['/src/worker.ts'],
    })).not.toThrow();
  });

  it('fails closed when a configured Worker entry has no rendered provenance', () => {
    expect(() => assertLocalePackageWorkerEntryProvenance({
      moduleGraph: new Map(),
      workerEntryModuleIds: ['/src/worker.ts'],
    })).toThrow(/Missing module-edge provenance for standalone Worker entry/u);
  });
});
