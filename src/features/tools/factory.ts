import type { LmToolName, Tool } from '../../01-models/tool';
import type { ChatGroupId, ChatId, VolumeId } from '@/01-models/ids';
import type { Settings, Mount } from '@/01-models/types';
import { CalculatorTool } from './calculator';
import { createChoicesTool } from './choices';
import type { RequestChoice } from '@/features/tools/choices/runtime';
import { WikipediaGetPageTool, WikipediaSearchTool } from './wikipedia';
import { createWeshTool } from './wesh';
import { createFileProtocolCompatibleWeshWorkerClient } from '@/features/wesh/worker/client';
import { storageService } from '@/00-storage/service';
import { shouldIncludeWritableTmpMount } from '@/features/wesh/mount-policy';
import type { NaidanSysfsAccessScope, WeshMount } from '@/features/wesh/types';
import { createNaidanSysfsMount } from '@/features/wesh/naidan-sysfs/mount';
import { abortOngoingScans, getVolumeExtensions, isVolumeScanned, startVolumeExtensionScan } from './wesh/volume-extension-cache';
import { buildShellDescription } from './wesh/shell-description';

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
  naidanSysfsAccessScope,
  tmpHandle,
  requestChoice,
}: {
  enabledNames: LmToolName[],
  settings: Settings,
  chatGroupMounts?: Mount[],
  chatMounts?: Mount[],
  chatId: ChatId | undefined,
  chatGroupId: ChatGroupId | undefined,
  naidanSysfsAccessScope: NaidanSysfsAccessScope,
  tmpHandle: FileSystemDirectoryHandle | undefined,
  requestChoice: RequestChoice | undefined,
}): Promise<Tool[]> {
  const tools: Tool[] = [];
  const canExposeWikipediaTools = canExposeWikipediaToolsForGeneration({
    enabledNames,
    settings,
    chatId,
    chatGroupId,
    naidanSysfsAccessScope,
    tmpHandle,
  });

  for (const name of enabledNames) {
    switch (name) {
    case 'calculator':
      tools.push(new CalculatorTool());
      break;

    case 'choices':
      if (chatId === undefined || requestChoice === undefined) {
        break;
      }
      tools.push(createChoicesTool({
        chatId,
        requestChoice,
      }));
      break;

    case 'wikipedia_search':
      if (!canExposeWikipediaTools) {
        break;
      }
      tools.push(new WikipediaSearchTool());
      break;

    case 'wikipedia_get_page':
      if (!canExposeWikipediaTools) {
        break;
      }
      tools.push(new WikipediaGetPageTool());
      break;

    case 'shell_execute': {
      const shouldMountTmp = shouldIncludeWritableTmpMount({ storageType: settings.storageType });
      if (shouldMountTmp && !tmpHandle) {
        break;
      }

      // Resolve mounts: global → chat group → chat (later entries win on path conflict)
      const allMounts = [...settings.mounts, ...(chatGroupMounts ?? []), ...(chatMounts ?? [])];
      const resolvedMounts: WeshMount[] = [];
      if (shouldMountTmp) {
        resolvedMounts.push({ type: 'directory', path: '/tmp', handle: tmpHandle!, readOnly: false });
      }
      switch (naidanSysfsAccessScope) {
      case 'none':
        break;
      case 'current_chat_only':
      case 'current_chat_with_chat_group':
      case 'main_chats': {
        const naidanSysfsMount = createNaidanSysfsMount({
          storageType: settings.storageType,
          visibility: naidanSysfsAccessScope,
          binaryObjectAccess: 'data',
          currentChatId: chatId,
          currentChatGroupId: chatGroupId,
        });
        if (naidanSysfsMount !== undefined) {
          resolvedMounts.push(naidanSysfsMount);
        }
        break;
      }
      default: {
        const _ex: never = naidanSysfsAccessScope;
        throw new Error(`Unhandled naidan sysfs access scope: ${String(_ex)}`);
      }
      }
      const volumeHandles = new Map<VolumeId, FileSystemDirectoryHandle>();
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

function canCreateShellTool({
  settings,
  tmpHandle,
}: {
  settings: Settings,
  tmpHandle: FileSystemDirectoryHandle | undefined,
}): boolean {
  const shouldMountTmp = shouldIncludeWritableTmpMount({ storageType: settings.storageType });
  if (shouldMountTmp && tmpHandle === undefined) {
    return false;
  }
  return true;
}

function hasEnabledNaidanSysfsMount({
  settings,
  chatId,
  chatGroupId,
  naidanSysfsAccessScope,
}: {
  settings: Settings,
  chatId: ChatId | undefined,
  chatGroupId: ChatGroupId | undefined,
  naidanSysfsAccessScope: NaidanSysfsAccessScope,
}): boolean {
  switch (naidanSysfsAccessScope) {
  case 'none':
    return false;
  case 'current_chat_only':
  case 'current_chat_with_chat_group':
  case 'main_chats':
    return createNaidanSysfsMount({
      storageType: settings.storageType,
      visibility: naidanSysfsAccessScope,
      binaryObjectAccess: 'data',
      currentChatId: chatId,
      currentChatGroupId: chatGroupId,
    }) !== undefined;
  default: {
    const _ex: never = naidanSysfsAccessScope;
    throw new Error(`Unhandled naidan sysfs access scope: ${String(_ex)}`);
  }
  }
}

function canExposeWikipediaToolsForGeneration({
  enabledNames,
  settings,
  chatId,
  chatGroupId,
  naidanSysfsAccessScope,
  tmpHandle,
}: {
  enabledNames: LmToolName[],
  settings: Settings,
  chatId: ChatId | undefined,
  chatGroupId: ChatGroupId | undefined,
  naidanSysfsAccessScope: NaidanSysfsAccessScope,
  tmpHandle: FileSystemDirectoryHandle | undefined,
}): boolean {
  if (!enabledNames.includes('shell_execute')) {
    return false;
  }
  if (!canCreateShellTool({ settings, tmpHandle })) {
    return false;
  }
  if (!hasEnabledNaidanSysfsMount({
    settings,
    chatId,
    chatGroupId,
    naidanSysfsAccessScope,
  })) {
    return false;
  }
  return true;
}
