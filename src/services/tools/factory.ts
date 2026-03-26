import type { Tool } from './types';
import type { Settings, Mount } from '@/models/types';
import { CalculatorTool } from './calculator';
import { createWeshTool } from './wesh';
import { createFileProtocolCompatibleWeshWorkerClient } from '@/services/wesh-worker-client';
import { storageService } from '@/services/storage';
import { checkOPFSSupport } from '@/services/storage/opfs-detection';
import { generateId } from '@/utils/id';
import { OPFS_TMP_DIR } from '@/models/constants';
import type { WeshMount } from '@/services/wesh/types';
import { abortOngoingScans, getVolumeExtensions, isVolumeScanned, startVolumeExtensionScan } from './volume-extension-cache';
import { buildShellDescription } from './shell-description';

/**
 * Dynamically creates and returns a list of enabled tools based on settings.
 * chatMounts are per-chat mounts that are merged with global settings.mounts.
 */
export async function getEnabledTools({
  enabledNames,
  settings,
  chatMounts,
  chatId,
}: {
  enabledNames: string[];
  settings: Settings;
  chatMounts?: Mount[];
  chatId: string;
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

      // Create a unique writable /tmp directory for this session.
      // The root `/` uses a virtual read-only handle — no real OPFS dir needed.
      // TODO: clean up naidan-tmp/<chatId>-* dirs on session dispose
      const opfsRoot = await navigator.storage.getDirectory();
      const tmpBase = await opfsRoot.getDirectoryHandle(OPFS_TMP_DIR, { create: true });
      const tmpHandle = await tmpBase.getDirectoryHandle(`${chatId}-${generateId()}`, { create: true });

      // Resolve mounts from settings (global) + chatMounts (per-chat)
      const allMounts = [...settings.mounts, ...(chatMounts ?? [])];
      const resolvedMounts: WeshMount[] = [
        { path: '/tmp', handle: tmpHandle, readOnly: false },
      ];
      const volumeHandles = new Map<string, FileSystemDirectoryHandle>();
      for (const m of allMounts) {
        const handle = await storageService.getVolumeDirectoryHandle({ volumeId: m.volumeId });
        if (handle) {
          resolvedMounts.push({
            path: m.mountPath,
            handle,
            readOnly: m.readOnly,
          });
          volumeHandles.set(m.volumeId, handle);
        }
      }

      // Start in /home/user only when at least one mount lives there.
      const hasHomeUserMount = resolvedMounts.some(m => m.path.startsWith('/home/user/'));
      const client = await createFileProtocolCompatibleWeshWorkerClient({
        rootHandle: 'readonly',
        mounts: resolvedMounts,
        user: 'user',
        initialEnv: {},
        initialCwd: hasHomeUserMount ? '/home/user' : undefined,
      });

      // Abort in-progress scans and read whatever has been collected so far.
      abortOngoingScans();
      const detectedExtensions = new Set<string>();
      for (const m of allMounts) {
        for (const ext of getVolumeExtensions({ volumeId: m.volumeId })) {
          detectedExtensions.add(ext);
        }
      }

      // Start background scans for volumes not yet scanned (e.g. after browser reload).
      // Results will be available on the next send.
      for (const [volumeId, handle] of volumeHandles) {
        if (!isVolumeScanned({ volumeId })) {
          startVolumeExtensionScan({ volumeId, handle });
        }
      }

      tools.push(createWeshTool({
        client,
        mounts: resolvedMounts,
        name: 'shell_execute',
        description: buildShellDescription({ mounts: resolvedMounts, detectedExtensions }),
        defaultStdoutLimit: 4096,
        defaultStderrLimit: 4096,
      }));
      break;
    }
    }
  }

  return tools;
}
