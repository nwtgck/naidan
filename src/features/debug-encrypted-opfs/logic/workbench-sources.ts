import { storageService } from '@/00-storage/service';
import { type EncryptedOpfsInspectionReader } from '@/00-storage/service/encrypted-opfs';
import {
  createEncryptedOpfsDebugWorkspace,
  destroyEncryptedOpfsDebugWorkspace,
  listEncryptedOpfsDebugWorkspaces,
  openEncryptedOpfsDebugWorkspace,
  type EncryptedOpfsDebugWorkspaceSummary,
} from './debug-workspace';
import type { StorageDirectoryHandle } from '@/00-storage/service/storage-file-system/types';

export type EncryptedOpfsWorkbenchSource =
  | {
      readonly type: 'naidan_active_store';
      readonly sourceId: 'naidan-active-store';
      readonly label: string;
      readonly access: 'read_only';
      readonly encryptedStoreId: string;
    }
  | {
      readonly type: 'ephemeral_debug_workspace';
      readonly sourceId: string;
      readonly label: string;
      readonly access: 'read_write';
      readonly workspace: Extract<EncryptedOpfsDebugWorkspaceSummary, { readonly status: 'live' }>;
    }
  | {
      readonly type: 'stale_debug_workspace';
      readonly sourceId: string;
      readonly label: string;
      readonly access: 'unavailable';
      readonly workspace: Extract<EncryptedOpfsDebugWorkspaceSummary, { readonly status: 'stale' }>;
    };

export interface EncryptedOpfsWorkbenchSourceSession {
  readonly source: Exclude<EncryptedOpfsWorkbenchSource, { readonly type: 'stale_debug_workspace' }>;
  readonly fileSystemId: string;
  readonly physicalPath: readonly string[];
  readonly decryptedRoot: StorageDirectoryHandle;
  readonly encryptedOpfsReader: EncryptedOpfsInspectionReader;

  dispose(): Promise<void>;
}

export async function listEncryptedOpfsWorkbenchSources(): Promise<readonly EncryptedOpfsWorkbenchSource[]> {
  const result: EncryptedOpfsWorkbenchSource[] = [];
  const inspection = await storageService.inspectOpfsEncryption().catch(() => undefined);
  if (inspection !== undefined) {
    switch (inspection.type) {
    case 'encrypted':
      /**
       * The store currently used by Naidan is exposed read-only. The Workbench
       * must not become a path that bypasses normal storage coordination and
       * mutates product data. Filesystem mutation experiments belong in an
       * isolated ephemeral workspace backed by the same EncryptedOpfs core.
       */
      result.push({
        type: 'naidan_active_store',
        sourceId: 'naidan-active-store',
        label: 'Naidan active encrypted store',
        access: 'read_only',
        encryptedStoreId: inspection.state.activeEncryptedStoreId,
      });
      break;
    case 'plain':
    case 'transitioning':
    case 'recovery_required':
      break;
    default: {
      const _ex: never = inspection;
      throw new Error(`Unhandled OPFS encryption inspection: ${String(_ex)}`);
    }
    }
  }

  const workspaces = await listEncryptedOpfsDebugWorkspaces({ nativeOpfsRoot: undefined });
  for (const workspace of workspaces) {
    switch (workspace.status) {
    case 'live':
      result.push({
        type: 'ephemeral_debug_workspace',
        sourceId: `debug-workspace:${workspace.workspaceId}`,
        label: `Ephemeral workspace ${shortId({ value: workspace.workspaceId })}`,
        access: 'read_write',
        workspace,
      });
      break;
    case 'stale':
      result.push({
        type: 'stale_debug_workspace',
        sourceId: `stale-workspace:${workspace.workspaceId}`,
        label: `Stale workspace ${shortId({ value: workspace.workspaceId })}`,
        access: 'unavailable',
        workspace,
      });
      break;
    default: {
      const _ex: never = workspace;
      throw new Error(`Unhandled EncryptedOpfs debug workspace status: ${String(_ex)}`);
    }
    }
  }
  return result;
}

export async function createEncryptedOpfsWorkbenchWorkspace(): Promise<EncryptedOpfsWorkbenchSource> {
  const workspace = await createEncryptedOpfsDebugWorkspace({ nativeOpfsRoot: undefined });
  return {
    type: 'ephemeral_debug_workspace',
    sourceId: `debug-workspace:${workspace.workspaceId}`,
    label: `Ephemeral workspace ${shortId({ value: workspace.workspaceId })}`,
    access: 'read_write',
    workspace,
  };
}

export async function destroyEncryptedOpfsWorkbenchWorkspace({ source }: {
  source: Extract<EncryptedOpfsWorkbenchSource, {
    readonly type: 'ephemeral_debug_workspace' | 'stale_debug_workspace';
  }>;
}): Promise<void> {
  await destroyEncryptedOpfsDebugWorkspace({
    workspaceId: source.workspace.workspaceId,
    nativeOpfsRoot: undefined,
  });
}

export async function openEncryptedOpfsWorkbenchSource({ source }: {
  source: Exclude<EncryptedOpfsWorkbenchSource, { readonly type: 'stale_debug_workspace' }>;
}): Promise<EncryptedOpfsWorkbenchSourceSession> {
  switch (source.type) {
  case 'naidan_active_store': {
    const session = await storageService.createOpfsEncryptionDebugSession();
    return {
      source,
      fileSystemId: session.encryptedOpfs.descriptor.fileSystemId,
      physicalPath: session.physicalPath,
      decryptedRoot: session.decryptedRoot,
      encryptedOpfsReader: session.encryptedOpfsReader,
      dispose: session.dispose,
    };
  }
  case 'ephemeral_debug_workspace': {
    const session = await openEncryptedOpfsDebugWorkspace({
      workspaceId: source.workspace.workspaceId,
    });
    return {
      source,
      fileSystemId: source.workspace.fileSystemId,
      physicalPath: source.workspace.physicalPath,
      decryptedRoot: session.decryptedRoot,
      encryptedOpfsReader: session.encryptedOpfsReader,
      dispose: session.dispose,
    };
  }
  default: {
    const _ex: never = source;
    throw new Error(`Unhandled EncryptedOpfs Workbench source: ${String(_ex)}`);
  }
  }
}

function shortId({ value }: { value: string }): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
