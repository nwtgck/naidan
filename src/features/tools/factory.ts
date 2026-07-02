import type { LmToolName, Tool } from '@/01-models/tool';
import type { ChatGroupId, ChatId } from '@/01-models/ids';
import type { Settings, Mount } from '@/01-models/types';
import { createChoicesTool } from './choices';
import type { RequestChoice } from '@/features/tools/choices/runtime';
import { shouldIncludeWritableTmpMount } from '@/features/wesh/mount-policy';
import type { NaidanSysfsAccessScope } from '@/features/wesh/types';
import { createNaidanSysfsMount } from '@/features/wesh/naidan-sysfs/mount';
import { createModuleLoader } from '@/utils/module-loader';

const calculatorToolModuleLoader = createModuleLoader({
  importModule: () => import('./calculator'),
  onPrefetchError: ({ error }) => {
    console.error('Failed to prefetch calculator tool:', error);
  },
});

const wikipediaToolModuleLoader = createModuleLoader({
  importModule: () => import('./wikipedia'),
  onPrefetchError: ({ error }) => {
    console.error('Failed to prefetch Wikipedia tools:', error);
  },
});

const shellExecuteToolModuleLoader = createModuleLoader({
  importModule: () => import('./wesh/create-shell-execute-tool'),
  onPrefetchError: ({ error }) => {
    console.error('Failed to prefetch Wesh tool:', error);
  },
});

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
    case 'calculator': {
      const { CalculatorTool } = await calculatorToolModuleLoader.load();
      tools.push(new CalculatorTool());
      break;
    }

    case 'choices':
      if (chatId === undefined || requestChoice === undefined) {
        break;
      }
      tools.push(createChoicesTool({
        chatId,
        requestChoice,
      }));
      break;

    case 'wikipedia_search': {
      if (!canExposeWikipediaTools) {
        break;
      }
      const { WikipediaSearchTool } = await wikipediaToolModuleLoader.load();
      tools.push(new WikipediaSearchTool());
      break;
    }

    case 'wikipedia_get_page': {
      if (!canExposeWikipediaTools) {
        break;
      }
      const { WikipediaGetPageTool } = await wikipediaToolModuleLoader.load();
      tools.push(new WikipediaGetPageTool());
      break;
    }

    case 'shell_execute': {
      const { createShellExecuteTool } = await shellExecuteToolModuleLoader.load();
      const tool = await createShellExecuteTool({
        settings,
        chatGroupMounts,
        chatMounts,
        chatId,
        chatGroupId,
        naidanSysfsAccessScope,
        tmpHandle,
      });
      if (tool !== undefined) {
        tools.push(tool);
      }
      break;
    }
    }
  }

  return tools;
}

export async function prefetchEnabledToolModules({ enabledNames }: {
  enabledNames: readonly LmToolName[],
}): Promise<void> {
  for (const name of enabledNames) {
    switch (name) {
    case 'calculator':
      await calculatorToolModuleLoader.prefetch();
      break;
    case 'choices':
      break;
    case 'wikipedia_search':
    case 'wikipedia_get_page':
      await wikipediaToolModuleLoader.prefetch();
      break;
    case 'shell_execute':
      await shellExecuteToolModuleLoader.prefetch();
      break;
    default: {
      const _ex: never = name;
      throw new Error(`Unhandled tool name: ${_ex}`);
    }
    }
  }
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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
