import type { Tool } from './types';
import type { Settings, Mount } from '@/models/types';
import { CalculatorTool } from './calculator';
import { createWeshTool } from './wesh';
import { createFileProtocolCompatibleWeshWorkerClient } from '@/services/wesh-worker-client';
import { storageService } from '@/services/storage';
import { checkOPFSSupport } from '@/services/storage/opfs-detection';
import type { WeshMount } from '@/services/wesh/types';

/**
 * Dynamically creates and returns a list of enabled tools based on settings.
 * chatMounts are per-chat mounts that are merged with global settings.mounts.
 */
export async function getEnabledTools({
  enabledNames,
  settings,
  chatMounts,
}: {
  enabledNames: string[];
  settings: Settings;
  chatMounts?: Mount[];
}): Promise<Tool[]> {
  const tools: Tool[] = [];

  for (const name of enabledNames) {
    switch (name) {
    case 'calculator':
      tools.push(new CalculatorTool());
      break;

    case 'shell_execute': {
      const opfsSupported = await checkOPFSSupport();
      if (!opfsSupported) {
        break;
      }

      const root = await navigator.storage.getDirectory();
      const rootHandle = await root.getDirectoryHandle('naidan-wesh-runtime', { create: true });

      // Resolve mounts from settings (global) + chatMounts (per-chat)
      const allMounts = [...settings.mounts, ...(chatMounts ?? [])];
      const resolvedMounts: WeshMount[] = [];
      for (const m of allMounts) {
        const handle = await storageService.getVolumeDirectoryHandle({ volumeId: m.volumeId });
        if (handle) {
          resolvedMounts.push({
            path: m.mountPath,
            handle,
            readOnly: m.readOnly,
          });
        }
      }

      const client = await createFileProtocolCompatibleWeshWorkerClient({
        rootHandle,
        mounts: resolvedMounts,
        user: 'user',
        initialEnv: {},
        initialCwd: undefined,
      });

      tools.push(createWeshTool({
        client,
        mounts: resolvedMounts,
        name: 'shell_execute',
        description: undefined,
        defaultStdoutLimit: 4096,
        defaultStderrLimit: 4096,
      }));
      break;
    }
    }
  }

  return tools;
}
