import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViteDevServer } from 'vite';

import { createBoundaryStringCatalogState } from './catalog-state';
import { createBoundaryStringProjectPaths } from './message-catalog';
import { createBoundaryStringServeCoordinator } from './serve-coordinator';
import { createBoundaryStringSourceRegistry } from './source-registry';

const temporaryDirectories: string[] = [];

class FakeWatcher extends EventEmitter {
  readonly add = vi.fn();
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-boundary-coordinator-'));
  temporaryDirectories.push(root);
  const sourcePath = path.join(root, 'src/example.ts');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, 'export const value = 1;\n');

  const watcher = new FakeWatcher();
  const restart = vi.fn(async () => {});
  const sourceModuleNode = { id: sourcePath };
  const invalidateModule = vi.fn();
  const server = {
    config: {
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
      },
      server: {
        hmr: false,
      },
    },
    moduleGraph: {
      getModuleById(moduleId: string) {
        return moduleId === sourcePath ? sourceModuleNode : undefined;
      },
      idToModuleMap: new Map(),
      invalidateModule,
    },
    restart,
    watcher,
    ws: {
      send: vi.fn(),
    },
  } as unknown as ViteDevServer;
  const registry = createBoundaryStringSourceRegistry();
  registry.replaceSource({
    analysis: {
      importedBindingNames: ['lazyStrings'],
      keys: ['Example__message'],
    },
    boundaryRelativeModulePath: 'src/example.ts',
    moduleId: sourcePath,
  });
  const coordinator = createBoundaryStringServeCoordinator({
    catalogState: createBoundaryStringCatalogState({
      readCatalog: () => ({
        messages: [],
        messagesByKey: new Map(),
      }),
    }),
    missingSourcePaths: new Set(),
    paths: createBoundaryStringProjectPaths({ root }),
    registry,
    server,
  });
  coordinator.watchSourceDirectory({ moduleId: sourcePath });
  return {
    coordinator,
    invalidateModule,
    restart,
    root,
    sourceModuleNode,
    sourcePath,
    watcher,
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe('Boundary Strings serve coordinator', () => {
  it('coalesces an atomic source replacement without restarting the server', async () => {
    vi.useFakeTimers();
    const {
      coordinator,
      invalidateModule,
      restart,
      sourceModuleNode,
      sourcePath,
      watcher,
    } = createFixture();

    fs.rmSync(sourcePath);
    watcher.emit('unlink', sourcePath);
    fs.writeFileSync(sourcePath, 'export const value = 2;\n');
    watcher.emit('add', sourcePath);
    await vi.advanceTimersByTimeAsync(60);

    expect(restart).not.toHaveBeenCalled();
    expect(invalidateModule).toHaveBeenCalledWith(sourceModuleNode);
    expect(fs.readFileSync(coordinator.revisionFilePath, 'utf8')).toBe('1\n');
    coordinator.dispose();
  });

  it('restarts when a missing source returns through the watched parent directory', async () => {
    vi.useFakeTimers();
    const { coordinator, restart, sourcePath, watcher } = createFixture();

    fs.rmSync(sourcePath);
    watcher.emit('unlink', sourcePath);
    await vi.advanceTimersByTimeAsync(60);
    expect(restart).toHaveBeenCalledTimes(1);

    fs.writeFileSync(sourcePath, 'export const value = 2;\n');
    watcher.emit('add', sourcePath);
    await vi.advanceTimersByTimeAsync(60);

    expect(restart).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it('leaves message content changes to the normal Vite module graph', async () => {
    vi.useFakeTimers();
    const { coordinator, restart, root, watcher } = createFixture();
    const messagePath = path.join(
      root,
      'src/strings/messages/Example__message/en.ts',
    );

    watcher.emit('change', messagePath);
    await vi.advanceTimersByTimeAsync(400);

    expect(restart).not.toHaveBeenCalled();
    expect(fs.readFileSync(coordinator.revisionFilePath, 'utf8')).toBe('0\n');
    coordinator.dispose();
  });

  it('disposes listeners, timers, and the external revision directory idempotently', () => {
    vi.useFakeTimers();
    const { coordinator, sourcePath, watcher } = createFixture();
    const revisionDirectoryPath = path.dirname(coordinator.revisionFilePath);

    watcher.emit('unlink', sourcePath);
    coordinator.dispose();
    coordinator.dispose();
    vi.runAllTimers();

    expect(fs.existsSync(revisionDirectoryPath)).toBe(false);
    expect(watcher.listenerCount('unlink')).toBe(0);
  });
});
