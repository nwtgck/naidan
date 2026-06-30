import fs from 'node:fs';
import path from 'node:path';

export type BoundaryStringProcessServeState = {
  missingSourcePaths: Set<string>;
};

type BoundaryStringProcessGlobal = typeof globalThis & {
  __naidanBoundaryStringServeStates?: Map<string, BoundaryStringProcessServeState>;
};

// Vitest recreates plugin objects when its Vite server restarts, but those
// objects still run in the same Node.js process. Keep only missing source paths
// in process-global state so a new plugin instance can observe their return.
// Catalog and source analysis state are deliberately rebuilt from the file system.
export function boundaryStringProcessServeState({ root }: {
  root: string;
}): BoundaryStringProcessServeState {
  const processGlobal = globalThis as BoundaryStringProcessGlobal;
  processGlobal.__naidanBoundaryStringServeStates ??= new Map();
  const stateKey = path.resolve(root);
  let state = processGlobal.__naidanBoundaryStringServeStates.get(stateKey);
  if (state === undefined) {
    state = {
      missingSourcePaths: new Set(),
    };
    processGlobal.__naidanBoundaryStringServeStates.set(stateKey, state);
  }
  for (const filePath of [...state.missingSourcePaths]) {
    if (fs.existsSync(filePath)) {
      state.missingSourcePaths.delete(filePath);
    }
  }
  return state;
}
