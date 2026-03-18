import type { Tool } from './types';
import type { Settings } from '@/models/types';
import { CalculatorTool } from './calculator';
import { createWeshTool } from './wesh';
import { WeshService } from '@/services/wesh-service';
import { storageService } from '@/services/storage';
import { checkOPFSSupport } from '@/services/storage/opfs-detection';
import type { WeshMount } from '@/services/wesh/types';

/**
 * Dynamically creates and returns a list of enabled tools based on settings.
 */
export async function getEnabledTools({
  enabledNames,
  settings,
}: {
  enabledNames: string[];
  settings: Settings;
}): Promise<Tool[]> {
  const tools: Tool[] = [];

  for (const name of enabledNames) {
    switch (name) {
    case 'calculator':
      tools.push(new CalculatorTool());
      break;

    case 'shell_execute': {
      const weshService = await WeshService.getInstance();

      // Initialize Wesh if not already done
      if (!weshService.isInitialized()) {
        let rootHandle: FileSystemDirectoryHandle;
        const opfsSupported = await checkOPFSSupport();

        if (opfsSupported) {
          const root = await navigator.storage.getDirectory();
          const weshDir = await root.getDirectoryHandle('naidan-wesh-runtime', { create: true });
          rootHandle = weshDir;
        } else {
          // Fallback to in-memory mock if OPFS is not available
          const { MockFileSystemDirectoryHandle } = await import('@/services/wesh/mocks/InMemoryFileSystem');
          rootHandle = new MockFileSystemDirectoryHandle('root') as unknown as FileSystemDirectoryHandle;
        }

        await weshService.init({ rootHandle });
      }

      // Resolve mounts from settings
      const resolvedMounts: WeshMount[] = [];
      for (const m of settings.mounts) {
        const handle = await storageService.getVolumeDirectoryHandle({ volumeId: m.volumeId });
        if (handle) {
          resolvedMounts.push({
            path: m.mountPath,
            handle,
            readOnly: false, // Default to read-write for now as per MountVolume structure
          });
        }
      }

      tools.push(createWeshTool({
        wesh: weshService.getWeshInstance(),
        mounts: resolvedMounts,
      }));
      break;
    }
    }
  }

  return tools;
}
