import type { HizoFSPhysicalInspectionSource } from './active-physical-inspection-source';
import {
  createHizoFSDebugWorkspace,
  destroyHizoFSDebugWorkspace,
  listHizoFSDebugWorkspaces,
  openHizoFSDebugWorkspace,
  type HizoFSDebugWorkspaceAuthority,
  type HizoFSDebugWorkspaceSession,
  type HizoFSDebugWorkspaceSummary,
} from './debug-workspace';

export type HizoFSWorkbenchSource =
  | {
      readonly type: 'active_encrypted_store';
      readonly sourceId: string;
      readonly label: string;
      readonly access: 'read';
      readonly physicalInspectionSource: HizoFSPhysicalInspectionSource;
    }
  | {
      readonly type: 'ephemeral_debug_workspace';
      readonly sourceId: string;
      readonly label: string;
      readonly access: 'read_write';
      readonly workspace: Extract<HizoFSDebugWorkspaceSummary, { readonly status: 'live' }>;
    }
  | {
      readonly type: 'stale_debug_workspace';
      readonly sourceId: string;
      readonly label: string;
      readonly access: 'unavailable';
      readonly workspace: Extract<HizoFSDebugWorkspaceSummary, { readonly status: 'stale' }>;
    };

export type ActiveHizoFSWorkbenchSource = Extract<
  HizoFSWorkbenchSource,
  { readonly type: 'active_encrypted_store' }
>;

export interface HizoFSWorkbenchSourceRegistry {
  listSources(): Promise<readonly HizoFSWorkbenchSource[]>;
  createWorkspace(): Promise<Extract<
    HizoFSWorkbenchSource,
    { readonly type: 'ephemeral_debug_workspace' }
  >>;
  destroyWorkspace({ source }: {
    source: Extract<HizoFSWorkbenchSource, {
      readonly type: 'ephemeral_debug_workspace' | 'stale_debug_workspace';
    }>;
  }): Promise<void>;
  openWorkspace({ source }: {
    source: Extract<HizoFSWorkbenchSource, { readonly type: 'ephemeral_debug_workspace' }>;
  }): Promise<HizoFSDebugWorkspaceSession>;
}

/**
 * Creates a presentation-only registry. Product storage composition supplies
 * the active encrypted-store source and debug-workspace creation authority;
 * this feature neither imports the storage facade nor reconstructs authority
 * from persisted identifiers.
 */
export function createHizoFSWorkbenchSourceRegistry({
  activeSources,
  debugWorkspaceAuthority,
  nativeOpfsRoot,
}: {
  activeSources: () => Promise<readonly ActiveHizoFSWorkbenchSource[]>;
  debugWorkspaceAuthority: HizoFSDebugWorkspaceAuthority;
  nativeOpfsRoot: FileSystemDirectoryHandle | undefined;
}): HizoFSWorkbenchSourceRegistry {
  return {
    async listSources() {
      const result: HizoFSWorkbenchSource[] = [...await activeSources()];
      const workspaces = await listHizoFSDebugWorkspaces({ nativeOpfsRoot });
      for (const workspace of workspaces) {
        switch (workspace.status) {
        case 'live':
          result.push(createLiveWorkspaceSource({ workspace }));
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
          throw new Error(`Unhandled HizoFS debug workspace status: ${String(_ex)}`);
        }
        }
      }
      return result;
    },

    async createWorkspace() {
      const workspace = await createHizoFSDebugWorkspace({
        authority: debugWorkspaceAuthority,
        nativeOpfsRoot,
      });
      return createLiveWorkspaceSource({ workspace });
    },

    async destroyWorkspace({ source }) {
      await destroyHizoFSDebugWorkspace({
        workspaceId: source.workspace.workspaceId,
        nativeOpfsRoot,
      });
    },

    async openWorkspace({ source }) {
      return openHizoFSDebugWorkspace({ workspaceId: source.workspace.workspaceId });
    },
  };
}

function createLiveWorkspaceSource({ workspace }: {
  workspace: Extract<HizoFSDebugWorkspaceSummary, { readonly status: 'live' }>;
}): Extract<HizoFSWorkbenchSource, { readonly type: 'ephemeral_debug_workspace' }> {
  return {
    type: 'ephemeral_debug_workspace',
    sourceId: `debug-workspace:${workspace.workspaceId}`,
    label: `Ephemeral workspace ${shortId({ value: workspace.workspaceId })}`,
    access: 'read_write',
    workspace,
  };
}

function shortId({ value }: { value: string }): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
