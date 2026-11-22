import { Secret } from '@/utils/secret';
import { cloneOptionalEndpoint, isHttpEndpoint } from '@/01-models/endpoint';
import { cloneSettingsTitleGeneration } from '@/01-models/title-generation';
import type { ChatGroup, ChatMeta, Endpoint, SidebarItem } from '@/01-models/types';

function redactSysfsEndpoint({ endpoint }: { endpoint: Endpoint | undefined }): Endpoint | undefined {
  const cloned = cloneOptionalEndpoint({ endpoint });
  if (cloned === undefined || !isHttpEndpoint(cloned)) {
    return cloned;
  }
  return { ...cloned, httpHeaders: cloned.httpHeaders?.map(([name, value]) => [name, Secret.from({ value: value.toJSON() })]) };
}

/**
 * Only connection settings are projected here; user-authored content keeps its
 * existing sysfs access policy. Redact BEFORE a persistence mapper can reveal
 * credentials into a remote-reader DTO, not only at final rendering time.
 * Preserve the complete record and never mutate or write back stored values.
 */
export function redactSysfsConnectionSettings<T extends ChatMeta | ChatGroup>({ value }: { value: T }): T {
  const title = value.titleGeneration;
  const titleGeneration = title === undefined || title === 'inherit' ? title : cloneSettingsTitleGeneration({ source: title });
  if (titleGeneration !== undefined && typeof titleGeneration !== 'string' && titleGeneration.endpoint !== 'same_scope') {
    titleGeneration.endpoint = redactSysfsEndpoint({ endpoint: titleGeneration.endpoint })!;
  }
  return { ...value, endpoint: redactSysfsEndpoint({ endpoint: value.endpoint }), titleGeneration };
}

export function redactSysfsSidebarItem({ item }: { item: SidebarItem }): SidebarItem {
  switch (item.type) {
  case 'chat': return item;
  case 'chat_group': return { ...item, chatGroup: redactSysfsConnectionSettings({ value: item.chatGroup }) };
  default: {
    const exhaustive: never = item;
    throw new Error(`Unhandled sidebar item type: ${String(exhaustive)}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
