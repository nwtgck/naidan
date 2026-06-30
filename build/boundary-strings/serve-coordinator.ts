import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ViteDevServer } from 'vite';

import {
  RESOLVED_BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX,
  RESOLVED_BOUNDARY_STRINGS_PACK_MODULE_PREFIX,
} from './virtual-modules';

import type { BoundaryStringCatalogState } from './catalog-state';
import {
  classifyBoundaryStringFile,
  type BoundaryStringFileKind,
  type BoundaryStringProjectPaths,
} from './message-catalog';
import type {
  BoundaryStringSourceRecord,
  BoundaryStringSourceRegistry,
} from './source-registry';

const STRUCTURE_REVISION_SETTLE_MILLISECONDS = 50;
const STRUCTURE_REVISION_MAX_WAIT_MILLISECONDS = 300;

type BoundaryStringWatchEvent = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';

type PendingSignal = 'none' | 'revision' | 'restart';

export type BoundaryStringServeCoordinator = {
  dispose(): void;
  revisionFilePath: string;
  watchSourceDirectory({ moduleId }: { moduleId: string }): void;
};

function fileEventKind({ event }: {
  event: BoundaryStringWatchEvent;
}): 'content' | 'topology' {
  switch (event) {
  case 'change':
    return 'content';
  case 'add':
  case 'addDir':
  case 'unlink':
  case 'unlinkDir':
    return 'topology';
  default: {
    const _exhaustive: never = event;
    throw new Error(`Unsupported Boundary Strings watch event: ${_exhaustive}`);
  }
  }
}

function sourceRecordsWithBoundaries({ records }: {
  records: readonly BoundaryStringSourceRecord[];
}): readonly BoundaryStringSourceRecord[] {
  return records.filter((record) => record.boundary !== undefined);
}

export function createBoundaryStringServeCoordinator({
  catalogState,
  missingSourcePaths,
  paths,
  registry,
  server,
}: {
  catalogState: BoundaryStringCatalogState;
  missingSourcePaths: Set<string>;
  paths: BoundaryStringProjectPaths;
  registry: BoundaryStringSourceRegistry;
  server: ViteDevServer;
}): BoundaryStringServeCoordinator {
  const revisionDirectoryPath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'naidan-boundary-strings-'),
  );
  const revisionFilePath = path.join(revisionDirectoryPath, 'structure-revision.txt');
  fs.writeFileSync(revisionFilePath, '0\n');

  const watchedSourceDirectories = new Set<string>();
  const pendingMissingSourcePaths = new Set<string>();
  let revision = 0;
  let pendingSignal: PendingSignal = 'none';
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  let flushPromise: Promise<void> | undefined;
  let disposed = false;

  server.watcher.add([
    ...Object.values(paths.catalogFilePathsByLocale),
    paths.messagesDirectoryPath,
  ]);

  function clearTimers(): void {
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer);
      settleTimer = undefined;
    }
    if (maxWaitTimer !== undefined) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = undefined;
    }
  }

  function persistMissingSources(): boolean {
    let foundMissingSource = false;
    for (const filePath of [...pendingMissingSourcePaths]) {
      pendingMissingSourcePaths.delete(filePath);
      if (fs.existsSync(filePath)) {
        continue;
      }
      missingSourcePaths.add(filePath);
      foundMissingSource = true;
    }
    return foundMissingSource;
  }

  function invalidateBoundaryVirtualModules(): void {
    for (const moduleNode of server.moduleGraph.idToModuleMap.values()) {
      const moduleId = moduleNode.id ?? '';
      if (
        moduleId.startsWith(RESOLVED_BOUNDARY_STRINGS_BOUNDARY_MODULE_PREFIX)
        || moduleId.startsWith(RESOLVED_BOUNDARY_STRINGS_PACK_MODULE_PREFIX)
      ) {
        server.moduleGraph.invalidateModule(moduleNode);
      }
    }
  }

  async function flush(): Promise<void> {
    if (disposed || pendingSignal === 'none') {
      clearTimers();
      return;
    }
    if (flushPromise !== undefined) {
      return flushPromise;
    }

    clearTimers();
    const signal = pendingSignal;
    pendingSignal = 'none';
    flushPromise = (async () => {
      switch (signal) {
      case 'restart':
        await server.restart();
        break;
      case 'revision':
        if (persistMissingSources()) {
          await server.restart();
          break;
        }
        invalidateBoundaryVirtualModules();
        revision += 1;
        fs.writeFileSync(revisionFilePath, `${revision}\n`);
        if (server.config.server.hmr !== false) {
          server.ws.send({ type: 'full-reload' });
        }
        break;
      default: {
        const _exhaustive: never = signal;
        throw new Error(`Unsupported Boundary Strings pending signal: ${_exhaustive}`);
      }
      }
    })();

    try {
      await flushPromise;
    } finally {
      flushPromise = undefined;
      if (!disposed && pendingSignal !== 'none') {
        scheduleFlush();
      }
    }
  }

  function runFlush(): void {
    void flush().catch((error: unknown) => {
      const normalizedError = error instanceof Error
        ? error
        : new Error(String(error));
      server.config.logger.error(
        `[naidan-boundary-strings] Failed to converge the development server: ${normalizedError.message}`,
        { error: normalizedError },
      );
    });
  }

  function scheduleFlush(): void {
    if (disposed) {
      return;
    }
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer);
    }
    settleTimer = setTimeout(runFlush, STRUCTURE_REVISION_SETTLE_MILLISECONDS);
    if (maxWaitTimer === undefined) {
      maxWaitTimer = setTimeout(runFlush, STRUCTURE_REVISION_MAX_WAIT_MILLISECONDS);
    }
  }

  function requestSignal({ signal }: {
    signal: Exclude<PendingSignal, 'none'>;
  }): void {
    switch (signal) {
    case 'restart':
      pendingSignal = 'restart';
      break;
    case 'revision':
      switch (pendingSignal) {
      case 'none':
        pendingSignal = 'revision';
        break;
      case 'revision':
      case 'restart':
        break;
      default: {
        const _exhaustive: never = pendingSignal;
        throw new Error(`Unsupported Boundary Strings pending signal: ${_exhaustive}`);
      }
      }
      break;
    default: {
      const _exhaustive: never = signal;
      throw new Error(`Unsupported Boundary Strings signal: ${_exhaustive}`);
    }
    }
    scheduleFlush();
  }

  function markStructureDirty(): void {
    catalogState.markDirty();
    requestSignal({ signal: 'revision' });
  }

  function handleStringsEvent({ event, kind }: {
    event: BoundaryStringWatchEvent;
    kind: BoundaryStringFileKind;
  }): boolean {
    switch (kind) {
    case 'catalog':
      markStructureDirty();
      return true;
    case 'message-module': {
      const kindOfEvent = fileEventKind({ event });
      switch (kindOfEvent) {
      case 'content':
        break;
      case 'topology':
        markStructureDirty();
        break;
      default: {
        const _exhaustive: never = kindOfEvent;
        throw new Error(`Unsupported Boundary Strings file event kind: ${_exhaustive}`);
      }
      }
      return true;
    }
    case 'other':
      return false;
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unsupported Boundary Strings file kind: ${_exhaustive}`);
    }
    }
  }

  function invalidateSourceModule({ moduleId }: {
    moduleId: string;
  }): void {
    const moduleNode = server.moduleGraph.getModuleById(moduleId);
    if (moduleNode !== undefined) {
      server.moduleGraph.invalidateModule(moduleNode);
    }
  }

  function recordMissingSources({ records }: {
    records: readonly BoundaryStringSourceRecord[];
  }): void {
    const boundaryRecords = sourceRecordsWithBoundaries({ records });
    if (boundaryRecords.length === 0) {
      return;
    }
    for (const record of boundaryRecords) {
      pendingMissingSourcePaths.add(record.moduleId);
    }
    requestSignal({ signal: 'revision' });
  }

  function handleSourceEvent({ event, filePath }: {
    event: BoundaryStringWatchEvent;
    filePath: string;
  }): void {
    switch (event) {
    case 'add':
      if (pendingMissingSourcePaths.delete(filePath)) {
        requestSignal({ signal: 'revision' });
        return;
      }
      if (missingSourcePaths.has(filePath)) {
        requestSignal({ signal: 'restart' });
      }
      return;
    case 'addDir':
      return;
    case 'change':
      if (registry.getAnalysis({ moduleId: filePath }) !== undefined) {
        invalidateSourceModule({ moduleId: filePath });
      }
      return;
    case 'unlink': {
      invalidateSourceModule({ moduleId: filePath });
      const removed = registry.removeSource({ moduleId: filePath });
      recordMissingSources({ records: removed === undefined ? [] : [removed] });
      return;
    }
    case 'unlinkDir': {
      const removedRecords = registry.removeSourcesUnder({ directoryPath: filePath });
      for (const record of removedRecords) {
        invalidateSourceModule({ moduleId: record.moduleId });
      }
      recordMissingSources({ records: removedRecords });
      return;
    }
    default: {
      const _exhaustive: never = event;
      throw new Error(`Unsupported Boundary Strings source event: ${_exhaustive}`);
    }
    }
  }

  function acceptEvent({ event, filePath }: {
    event: BoundaryStringWatchEvent;
    filePath: string;
  }): void {
    if (disposed) {
      return;
    }
    const normalizedFilePath = path.resolve(filePath);
    const handledAsStringsFile = handleStringsEvent({
      event,
      kind: classifyBoundaryStringFile({
        filePath: normalizedFilePath,
        paths,
      }),
    });
    if (!handledAsStringsFile) {
      handleSourceEvent({
        event,
        filePath: normalizedFilePath,
      });
    }
  }

  const listeners = {
    add(filePath: string) {
      acceptEvent({ event: 'add', filePath });
    },
    addDir(filePath: string) {
      acceptEvent({ event: 'addDir', filePath });
    },
    change(filePath: string) {
      acceptEvent({ event: 'change', filePath });
    },
    unlink(filePath: string) {
      acceptEvent({ event: 'unlink', filePath });
    },
    unlinkDir(filePath: string) {
      acceptEvent({ event: 'unlinkDir', filePath });
    },
  };

  server.watcher.on('add', listeners.add);
  server.watcher.on('addDir', listeners.addDir);
  server.watcher.on('change', listeners.change);
  server.watcher.on('unlink', listeners.unlink);
  server.watcher.on('unlinkDir', listeners.unlinkDir);

  function watchSourceDirectory({ moduleId }: {
    moduleId: string;
  }): void {
    const directoryPath = path.dirname(moduleId);
    if (watchedSourceDirectories.has(directoryPath)) {
      return;
    }
    watchedSourceDirectories.add(directoryPath);
    server.watcher.add(directoryPath);
  }

  for (const missingSourcePath of missingSourcePaths) {
    watchSourceDirectory({ moduleId: missingSourcePath });
  }
  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    clearTimers();
    server.watcher.off('add', listeners.add);
    server.watcher.off('addDir', listeners.addDir);
    server.watcher.off('change', listeners.change);
    server.watcher.off('unlink', listeners.unlink);
    server.watcher.off('unlinkDir', listeners.unlinkDir);
    try {
      fs.rmSync(revisionDirectoryPath, {
        force: true,
        recursive: true,
      });
    } catch (error) {
      server.config.logger.warn(
        `[naidan-boundary-strings] Failed to remove revision directory: ${String(error)}`,
      );
    }
  }

  return {
    dispose,
    revisionFilePath,
    watchSourceDirectory,
  };
}
