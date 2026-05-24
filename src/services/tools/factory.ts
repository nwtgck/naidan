import type { Tool } from './types';
import type { Settings, Mount } from '@/models/types';
import { CalculatorTool } from './calculator';
import { createWeshTool } from './wesh';
import { createFileProtocolCompatibleWeshWorkerClient } from '@/services/wesh/worker/client';
import { storageService } from '@/services/storage';
import { checkOPFSSupport } from '@/services/storage/opfs-detection';
import type { NaidanSysfsMountSelection, WeshMount } from '@/services/wesh/types';
import { createNaidanSysfsMount } from '@/services/wesh/naidan-sysfs/mount';
import { abortOngoingScans, getVolumeExtensions, isVolumeScanned, startVolumeExtensionScan } from './volume-extension-cache';
import { buildShellDescription } from './shell-description';

/**
 * Dynamically creates and returns a list of enabled tools based on settings.
 * Mount resolution order: global (settings.mounts) → group → chat (per-chat overrides).
 */
export async function getEnabledTools({
  enabledNames,
  settings,
  chatGroupMounts,
  chatMounts,
  chatId,
  chatGroupId,
  naidanSysfsVisibility,
  tmpHandle,
}: {
  enabledNames: string[];
  settings: Settings;
  chatGroupMounts?: Mount[];
  chatMounts?: Mount[];
  chatId: string | undefined;
  chatGroupId: string | undefined;
  naidanSysfsVisibility: NaidanSysfsMountSelection;
  tmpHandle: FileSystemDirectoryHandle | undefined;
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

      if (!tmpHandle) {
        break;
      }

      // Resolve mounts: global → chat group → chat (later entries win on path conflict)
      const allMounts = [...settings.mounts, ...(chatGroupMounts ?? []), ...(chatMounts ?? [])];
      const resolvedMounts: WeshMount[] = [
        { type: 'directory', path: '/tmp', handle: tmpHandle, readOnly: false },
      ];
      if (naidanSysfsVisibility !== 'none') {
        const naidanSysfsMount = createNaidanSysfsMount({
          storageType: settings.storageType,
          visibility: naidanSysfsVisibility,
          currentChatId: chatId,
          currentChatGroupId: chatGroupId,
        });
        if (naidanSysfsMount !== undefined) {
          resolvedMounts.push(naidanSysfsMount)
        }
      }
      const volumeHandles = new Map<string, FileSystemDirectoryHandle>();
      for (const m of allMounts) {
        const handle = await storageService.getVolumeDirectoryHandle({ volumeId: m.volumeId });
        if (handle) {
          resolvedMounts.push({
            type: 'directory',
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
        defaultStdoutLimit: 32768,
        defaultStderrLimit: 16384,
      }));
      break;
    }
    }
  }

  return tools;
}
