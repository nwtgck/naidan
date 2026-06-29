<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { computed, type Component } from 'vue';
import { useFeatureFlags } from '@/composables/useFeatureFlags';
import { useSettings } from '@/composables/useSettings';
import {
  BookOpenIcon,
  CalculatorIcon,
  InfoIcon,
  ListIcon,
  RotateCcwIcon,
  TerminalIcon,
} from 'lucide-vue-next';
import type {
  BuiltinToolKey,
  ToolConfig,
  ToolConfigStatus,
  WeshToolConfig,
} from '@/01-models/tool';
import {
  findLastToolConfigByKey,
  isBuiltinToolEnabledInToolConfigs,
} from '@/features/tools/tool-config';
import type { NaidanSysfsAccessScope } from '@/features/wesh/types';
import { shouldIncludeWritableTmpMount } from '@/features/wesh/mount-policy';

export type ToolConfigSettingsScope = 'global' | 'chat_group' | 'chat';
export type ToolConfigInheritanceLabel = 'Use global' | 'Use group';

const props = defineProps<{
  scope: ToolConfigSettingsScope,
  toolConfigs: ToolConfig[] | undefined,
  effectiveToolConfigs: ToolConfig[],
  inheritanceLabelByKey?: Readonly<Record<BuiltinToolKey, ToolConfigInheritanceLabel>>,
  isEditable: boolean,
}>();

const emit = defineEmits<{
  (event: 'set-status', payload: { key: BuiltinToolKey, status: ToolConfigStatus }): void,
  (event: 'reset-tool', payload: { key: BuiltinToolKey }): void,
  (event: 'set-wesh-access-scope', payload: { accessScope: NaidanSysfsAccessScope }): void,
  (event: 'reset-all'): void,
}>();

const { isFeatureEnabled } = useFeatureFlags();
const { settings } = useSettings();

type ToolDefinition = {
  readonly key: BuiltinToolKey,
  readonly name: string,
  readonly description: string,
  readonly icon: Component,
};

type ToolDefinitionDraft = Omit<ToolDefinition, 'name' | 'description'> & {
  readonly name: string | undefined,
  readonly description: string | undefined,
};

const toolDefinitions = computed<readonly ToolDefinition[]>(() => {
  const drafts: readonly ToolDefinitionDraft[] = [
    {
      key: 'builtin.calculator',
      name: lazyStrings.ToolConfigHierarchySettings__calculator(),
      description: lazyStrings.ToolConfigHierarchySettings__solve_math_expressions(),
      icon: CalculatorIcon,
    },
    {
      key: 'builtin.choices',
      name: lazyStrings.ToolConfigHierarchySettings__choices(),
      description: lazyStrings.ToolConfigHierarchySettings__choose_from_model_provided_options(),
      icon: ListIcon,
    },
    {
      key: 'builtin.wikipedia',
      name: lazyStrings.ToolConfigHierarchySettings__wikipedia(),
      description: lazyStrings.ToolConfigHierarchySettings__access_global_knowledge(),
      icon: BookOpenIcon,
    },
    {
      key: 'builtin.wesh',
      name: lazyStrings.ToolConfigHierarchySettings__shell(),
      description: lazyStrings.ToolConfigHierarchySettings__shell_in_browser(),
      icon: TerminalIcon,
    },
  ];

  const resolved: ToolDefinition[] = [];
  for (const draft of drafts) {
    if (draft.name === undefined || draft.description === undefined) return [];
    resolved.push({ ...draft, name: draft.name, description: draft.description });
  }
  return resolved;
});

const visibleToolDefinitions = computed(() => toolDefinitions.value.filter((tool) => {
  switch (tool.key) {
  case 'builtin.calculator':
  case 'builtin.choices':
  case 'builtin.wikipedia':
    return true;
  case 'builtin.wesh':
    return isFeatureEnabled({ feature: 'wesh_tool' });
  default: {
    const _ex: never = tool.key;
    throw new Error(`Unhandled builtin tool key: ${_ex}`);
  }
  }
}));

const isWeshFeatureEnabled = computed(() => isFeatureEnabled({ feature: 'wesh_tool' }));
const hasWritableTmp = computed(() => shouldIncludeWritableTmpMount({
  storageType: settings.value.storageType,
}));
const hasOverrides = computed(() => (props.toolConfigs?.length ?? 0) > 0);

function explicitConfig({ key }: { key: BuiltinToolKey }): ToolConfig | undefined {
  return findLastToolConfigByKey({
    toolConfigs: props.toolConfigs,
    key,
  });
}

function effectiveConfig({ key }: { key: BuiltinToolKey }): ToolConfig {
  const config = findLastToolConfigByKey({
    toolConfigs: props.effectiveToolConfigs,
    key,
  });
  if (config === undefined) {
    throw new Error(`Missing effective tool config: ${key}`);
  }
  return config;
}

function isEffectivelyEnabled({ key }: { key: BuiltinToolKey }): boolean {
  return isBuiltinToolEnabledInToolConfigs({
    toolConfigs: props.effectiveToolConfigs,
    key,
  });
}

function toggleStatus({ key }: { key: BuiltinToolKey }): void {
  emit('set-status', {
    key,
    status: isEffectivelyEnabled({ key }) ? 'disabled' : 'enabled',
  });
}

function inheritanceLabel({ key }: { key: BuiltinToolKey }): string | undefined {
  let label: ToolConfigInheritanceLabel;
  switch (props.scope) {
  case 'global':
    throw new Error('Global tool settings do not inherit from another configurable layer');
  case 'chat_group':
    label = 'Use global';
    break;
  case 'chat': {
    const inheritedLabel = props.inheritanceLabelByKey?.[key];
    if (inheritedLabel === undefined) {
      throw new Error(`Missing Chat tool inheritance label: ${key}`);
    }
    label = inheritedLabel;
    break;
  }
  default: {
    const _ex: never = props.scope;
    throw new Error(`Unhandled tool config scope: ${_ex}`);
  }
  }

  switch (label) {
  case 'Use global':
    return lazyStrings.ToolConfigHierarchySettings__use_global();
  case 'Use group':
    return lazyStrings.ToolConfigHierarchySettings__use_group();
  default: {
    const _ex: never = label;
    throw new Error(`Unhandled tool inheritance label: ${_ex}`);
  }
  }
}

function toggleAriaLabel({
  key,
  toolName,
}: {
  key: BuiltinToolKey,
  toolName: string | undefined,
}): string | undefined {
  if (toolName === undefined) return undefined;
  return isEffectivelyEnabled({ key })
    ? lazyStrings.ToolConfigHierarchySettings__turn_off_tool({ toolName })
    : lazyStrings.ToolConfigHierarchySettings__turn_on_tool({ toolName });
}

function handleAccessScopeChange({ event }: { event: Event }): void {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  const accessScope = target.value as NaidanSysfsAccessScope;
  switch (accessScope) {
  case 'current_chat_only':
  case 'current_chat_with_chat_group':
  case 'main_chats':
    emit('set-wesh-access-scope', { accessScope });
    break;
  case 'none':
    throw new Error('The mounted Shell visibility selector cannot emit none');
  default: {
    const _ex: never = accessScope;
    throw new Error(`Unhandled Wesh access scope: ${_ex}`);
  }
  }
}

const effectiveWeshConfig = computed((): WeshToolConfig => {
  const config = effectiveConfig({ key: 'builtin.wesh' });
  switch (config.key) {
  case 'builtin.wesh':
    return config;
  case 'builtin.calculator':
  case 'builtin.choices':
  case 'builtin.wikipedia':
    throw new Error(`Expected Wesh config, received ${config.key}`);
  default: {
    const _ex: never = config;
    throw new Error(`Unhandled tool config: ${String(_ex)}`);
  }
  }
});

const isWeshMounted = computed(() => effectiveWeshConfig.value.naidanSysfs.accessScope !== 'none');

function toggleWeshMount(): void {
  emit('set-wesh-access-scope', {
    accessScope: isWeshMounted.value ? 'none' : 'current_chat_only',
  });
}

defineExpose({
  TEST_ONLY: {
    hasOverrides,
    isWeshMounted,
  },
});
</script>

<template>
  <div class="space-y-4" data-testid="tool-config-hierarchy-settings">
    <div
      v-if="!isEditable"
      class="flex items-start gap-2.5 rounded-xl border border-amber-200/70 bg-amber-50/60 px-3 py-2.5 text-amber-900 dark:border-amber-700/30 dark:bg-amber-900/10 dark:text-amber-200"
      data-testid="tool-config-read-only-note"
    >
      <InfoIcon class="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <p class="text-[10px] leading-relaxed">
        {{ lazyStrings.ToolConfigHierarchySettings__tool_config_persistence_is_disabled_saved_settings_remain_active_but_changes_cannot_be_saved_here() }}
      </p>
    </div>

    <div
      class="grid grid-cols-1 gap-2"
      :class="scope === 'global' ? 'sm:grid-cols-1' : 'sm:grid-cols-2'"
    >
      <article
        v-for="tool in visibleToolDefinitions"
        :key="tool.key"
        class="overflow-hidden rounded-xl border transition-all duration-300 active:scale-[0.995]"
        :class="[
          'h-[52px]',
          isEffectivelyEnabled({ key: tool.key })
            ? 'border-blue-200 bg-blue-50/30 shadow-sm dark:border-blue-500/30 dark:bg-blue-500/5'
            : 'border-gray-100 bg-white/70 hover:border-gray-200 dark:border-gray-700/60 dark:bg-gray-800/40 dark:hover:border-gray-700',
        ]"
        :data-testid="`tool-config-card-${tool.key}`"
      >
        <div
          class="grid h-full items-center gap-2.5 px-3 py-2 grid-cols-[auto_minmax(0,1fr)_auto]"
        >
          <div
            class="grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-all duration-300"
            :class="isEffectivelyEnabled({ key: tool.key })
              ? 'scale-[1.02] bg-blue-600 text-white shadow-sm shadow-blue-500/10'
              : 'bg-gray-50 text-gray-400 dark:bg-gray-800 dark:text-gray-500'"
          >
            <component :is="tool.icon" class="h-4.5 w-4.5" />
          </div>

          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="truncate text-xs font-bold tracking-tight" :class="isEffectivelyEnabled({ key: tool.key }) ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-300'">{{ tool.name }}</span>
              <span v-if="isEffectivelyEnabled({ key: tool.key })" class="h-1 w-1 shrink-0 rounded-full bg-blue-500 animate-pulse"></span>
            </div>
            <p class="mt-0.5 truncate text-[10px] text-gray-400 dark:text-gray-500 leading-tight">
              {{ tool.description }}
            </p>
          </div>

          <div
            v-if="scope === 'global'"
            class="flex items-center justify-end"
          >
            <button
              type="button"
              role="switch"
              class="relative h-[22px] w-[46px] rounded-full border border-white/10 transition-all duration-200 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              :class="isEffectivelyEnabled({ key: tool.key })
                ? 'bg-blue-600 ring-4 ring-blue-500/10'
                : 'bg-gray-300 dark:bg-gray-600'"
              :disabled="!isEditable"
              :aria-checked="isEffectivelyEnabled({ key: tool.key })"
              :aria-label="toggleAriaLabel({ key: tool.key, toolName: tool.name })"
              :data-testid="`tool-config-${tool.key}-toggle`"
              @click="toggleStatus({ key: tool.key })"
            >
              <span
                class="absolute inset-y-0 flex items-center text-[7px] font-black tracking-[0.08em] text-white"
                :class="isEffectivelyEnabled({ key: tool.key }) ? 'left-1.5' : 'right-1.5'"
              >
                {{ isEffectivelyEnabled({ key: tool.key }) ? lazyStrings.ToolConfigHierarchySettings__on() : lazyStrings.ToolConfigHierarchySettings__off() }}
              </span>
              <span
                class="absolute left-[2px] top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-200 ease-out"
                :class="isEffectivelyEnabled({ key: tool.key }) ? 'translate-x-[24px]' : 'translate-x-0'"
              ></span>
            </button>
          </div>

          <div
            v-else
            class="flex items-center gap-2"
            :data-testid="`tool-config-${tool.key}-control-stack`"
          >
            <div
              class="flex items-center"
              :data-testid="`tool-config-${tool.key}-reset-slot`"
            >
              <Transition name="parent-reset">
                <button
                  v-if="explicitConfig({ key: tool.key }) !== undefined"
                  type="button"
                  class="inline-flex h-[22px] items-center justify-center rounded-lg border border-gray-200 bg-white/60 px-2 text-[9px] font-bold text-gray-500 transition-all hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900/30 dark:text-gray-400 dark:hover:border-blue-600 dark:hover:bg-blue-500/10 dark:hover:text-blue-400 shrink-0"
                  :disabled="!isEditable"
                  :data-testid="`tool-config-${tool.key}-inherit`"
                  @click="emit('reset-tool', { key: tool.key })"
                >
                  {{ inheritanceLabel({ key: tool.key }) }}
                </button>
              </Transition>
            </div>

            <button
              type="button"
              role="switch"
              class="relative h-[22px] w-[46px] rounded-full border border-white/10 transition-all duration-200 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 shrink-0"
              :class="isEffectivelyEnabled({ key: tool.key })
                ? 'bg-blue-600 ring-4 ring-blue-500/10'
                : 'bg-gray-300 dark:bg-gray-600'"
              :disabled="!isEditable"
              :aria-checked="isEffectivelyEnabled({ key: tool.key })"
              :aria-label="toggleAriaLabel({ key: tool.key, toolName: tool.name })"
              :data-testid="`tool-config-${tool.key}-toggle`"
              @click="toggleStatus({ key: tool.key })"
            >
              <span
                class="absolute inset-y-0 flex items-center text-[7px] font-black tracking-[0.08em] text-white"
                :class="isEffectivelyEnabled({ key: tool.key }) ? 'left-1.5' : 'right-1.5'"
              >
                {{ isEffectivelyEnabled({ key: tool.key }) ? lazyStrings.ToolConfigHierarchySettings__on() : lazyStrings.ToolConfigHierarchySettings__off() }}
              </span>
              <span
                class="absolute left-[2px] top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-200 ease-out"
                :class="isEffectivelyEnabled({ key: tool.key }) ? 'translate-x-[24px]' : 'translate-x-0'"
              ></span>
            </button>
          </div>
        </div>
      </article>
    </div>

    <Transition name="shell-settings">
      <section
        v-if="isWeshFeatureEnabled && effectiveWeshConfig.status === 'enabled'"
        class="overflow-hidden rounded-2xl border border-blue-200/60 bg-white/80 shadow-sm dark:border-blue-500/20 dark:bg-gray-900/30"
        data-testid="hierarchical-wesh-settings"
      >
        <header class="border-b border-gray-100 bg-blue-50/40 px-3 py-2.5 dark:border-gray-700/60 dark:bg-blue-500/5">
          <h3 class="text-[11px] font-bold text-gray-700 dark:text-gray-200">{{ lazyStrings.ToolConfigHierarchySettings__shell_settings() }}</h3>
          <p class="mt-0.5 text-[10px] text-gray-500 dark:text-gray-400">
            {{ lazyStrings.SHARED__configure_browser_based_shell_access() }}
          </p>
        </header>

        <div class="divide-y divide-gray-100 dark:divide-gray-700/60">
          <button
            type="button"
            role="switch"
            class="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3 py-3 text-left transition-colors hover:bg-gray-50/70 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-gray-800/30"
            :disabled="!isEditable"
            :aria-checked="isWeshMounted"
            data-testid="hierarchical-wesh-mount-toggle"
            @click="toggleWeshMount()"
          >
            <span class="min-w-0">
              <span class="block text-[11px] font-bold text-gray-700 dark:text-gray-200">
                {{ lazyStrings.SHARED__mount() }} <code class="font-mono text-[10px]">/sys/fs/naidan</code>
              </span>
              <span class="mt-0.5 block text-[10px] leading-relaxed text-gray-500 dark:text-gray-400">
                {{ lazyStrings.SHARED__expose_chat_discovery_paths() }}
              </span>
            </span>

            <span
              class="relative h-3.5 w-7 rounded-full transition-colors duration-200"
              :class="isWeshMounted ? 'bg-blue-500' : 'bg-gray-200 dark:bg-gray-700'"
            >
              <span
                class="absolute left-0.5 top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-transform duration-200"
                :class="isWeshMounted ? 'translate-x-3.5' : 'translate-x-0'"
              ></span>
            </span>
          </button>

          <Transition name="visibility-row">
            <div
              v-if="isWeshMounted"
              class="grid grid-cols-1 items-center gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4"
            >
              <div class="min-w-0">
                <label for="hierarchical-wesh-access-scope" class="block text-[11px] font-bold text-gray-700 dark:text-gray-200">
                  {{ lazyStrings.SHARED__visibility() }}
                </label>
                <p class="mt-0.5 text-[10px] leading-relaxed text-gray-500 dark:text-gray-400">
                  {{ lazyStrings.SHARED__choose_which_chats_are_visible_to_the_shell() }}
                </p>
              </div>

              <select
                id="hierarchical-wesh-access-scope"
                :value="effectiveWeshConfig.naidanSysfs.accessScope"
                :disabled="!isEditable"
                class="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-[11px] text-gray-700 outline-none focus:ring-1 focus:ring-blue-500/50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 sm:w-52"
                data-testid="hierarchical-wesh-access-scope"
                @change="handleAccessScopeChange({ event: $event })"
              >
                <option value="current_chat_only">{{ lazyStrings.SHARED__current_chat() }}</option>
                <option value="current_chat_with_chat_group">{{ lazyStrings.SHARED__current_chat_plus_chat_group() }}</option>
                <option value="main_chats">{{ lazyStrings.SHARED__all_chats() }}</option>
              </select>
            </div>
          </Transition>
        </div>

        <div class="flex items-start gap-2.5 border-t border-gray-100 bg-gray-50/50 px-3 py-2.5 dark:border-gray-700/60 dark:bg-gray-950/20">
          <InfoIcon class="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />
          <p class="text-[10px] leading-relaxed text-gray-500 dark:text-gray-400" data-testid="wesh-storage-mode-note">
            {{ hasWritableTmp ? lazyStrings.SHARED__writable_tmp_is_available_with_opfs_storage() : lazyStrings.SHARED__local_and_memory_storage_expose_wesh_as_read_only_without_tmp() }}
          </p>
        </div>
      </section>
    </Transition>

    <div v-if="scope === 'global'" class="flex justify-end border-t border-gray-100 pt-3 dark:border-gray-800">
      <button
        type="button"
        class="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 text-[9px] font-bold text-gray-500 transition-colors hover:border-blue-200 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:text-gray-400 dark:hover:border-blue-700 dark:hover:text-blue-400"
        :disabled="!isEditable || !hasOverrides"
        data-testid="tool-config-reset-all"
        @click="emit('reset-all')"
      >
        <RotateCcwIcon class="h-3 w-3" />
        {{ lazyStrings.ToolConfigHierarchySettings__reset_to_defaults() }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.parent-reset-enter-active,
.parent-reset-leave-active {
  transition: opacity 180ms ease, transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.parent-reset-enter-from,
.parent-reset-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.shell-settings-enter-active,
.shell-settings-leave-active {
  overflow: hidden;
  transition: opacity 220ms ease, transform 300ms cubic-bezier(0.16, 1, 0.3, 1), max-height 300ms cubic-bezier(0.16, 1, 0.3, 1);
}

.shell-settings-enter-from,
.shell-settings-leave-to {
  max-height: 0;
  opacity: 0;
  transform: translateY(-8px);
}

.shell-settings-enter-to,
.shell-settings-leave-from {
  max-height: 28rem;
}

.visibility-row-enter-active,
.visibility-row-leave-active {
  overflow: hidden;
  transition: opacity 180ms ease, transform 220ms cubic-bezier(0.16, 1, 0.3, 1), max-height 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.visibility-row-enter-from,
.visibility-row-leave-to {
  max-height: 0;
  opacity: 0;
  transform: translateY(-5px);
}

.visibility-row-enter-to,
.visibility-row-leave-from {
  max-height: 6rem;
}

@media (prefers-reduced-motion: reduce) {
  .parent-reset-enter-active,
  .parent-reset-leave-active,
  .shell-settings-enter-active,
  .shell-settings-leave-active,
  .visibility-row-enter-active,
  .visibility-row-leave-active {
    transition-duration: 0.01ms;
  }
}
</style>
