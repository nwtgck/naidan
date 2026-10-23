<script setup lang="ts">
import { computed, nextTick, ref, useId, watch, inject, onBeforeUnmount, type Ref } from 'vue';
import { onClickOutside } from '@vueuse/core';
import { CheckIcon, ChevronDownIcon } from 'lucide-vue-next';
import { useAnchoredPopup } from '@/composables/useAnchoredPopup';
import type { SettingsSourcePresentation } from './SettingsSourceBadge.vue';
import SettingsSourceBadge from './SettingsSourceBadge.vue';
import { useEventTargetListener } from '@/composables/useEventTargetListener';

defineOptions({ inheritAttrs: false });

type SettingsSelectOption = {
  value: string,
  label: string | undefined,
  detail?: string,
  source?: SettingsSourcePresentation,
  disabled?: boolean,
};

const disclosureOpen = inject<Readonly<Ref<boolean>> | undefined>('settings-disclosure-open', undefined);
const disclosureFocusReturn = inject<(() => HTMLElement | undefined) | undefined>('settings-disclosure-focus-return', undefined);
const props = defineProps<{
  modelValue: string,
  options: readonly SettingsSelectOption[],
  label: string | undefined,
  disabled?: boolean,
  surface?: 'default' | 'embedded',
  presentation?: 'default' | 'toolbar' | 'inline',
  size?: 'default' | 'compact',
  menuWidthRem?: number,
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void,
}>();
defineSlots<{
  leading?({ option }: { option: SettingsSelectOption | undefined }): unknown,
  option({ option }: { option: SettingsSelectOption }): unknown,
}>();

const selected = computed(() => props.options.find(option => option.value === props.modelValue));
const triggerRef = ref<HTMLButtonElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);
const open = ref(false);
const menuId = useId();
const popup = useAnchoredPopup({
  anchor: triggerRef,
  preferredWidth: {
    unit: 'rem',
    get value() {
      if (props.menuWidthRem !== undefined) {
        return props.menuWidthRem;
      }
      const size = props.size;
      switch (size) {
      case 'compact': return 10;
      case 'default':
      case undefined: return 20;
      default: {
        const _ex: never = size;
        throw new Error(`Unhandled select size: ${_ex}`);
      }
      }
    },
  },
  maxWidthPx: 560,
});

function close({ restoreFocus }: { restoreFocus: boolean }) {
  open.value = false;
  if (restoreFocus) {
    triggerRef.value?.focus();
  }
}

async function toggle() {
  if (props.disabled || disclosureOpen?.value === false) {
    return;
  }
  if (open.value) {
    close({ restoreFocus: false });
    return;
  }
  popup.refresh();
  open.value = true;
  await nextTick();
  popup.refresh();
  const selectedButton = menuRef.value?.querySelector<HTMLButtonElement>('[aria-selected="true"]:not(:disabled)');
  (selectedButton ?? menuRef.value?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)'))?.focus();
}

function choose({ value }: { value: string }) {
  if (props.disabled || disclosureOpen?.value === false || !open.value || !props.options.some(option => option.value === value && !option.disabled)) {
    return;
  }
  // Reselecting a native select did not request another owner mutation.
  if (value !== props.modelValue) {
    emit('update:modelValue', value);
  }
  close({ restoreFocus: true });
}

function handleMenuKeydown({ event }: { event: KeyboardEvent }) {
  if (event.isComposing || event.keyCode === 229) {
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close({ restoreFocus: true });
    return;
  }
  if (event.key === 'Tab') {
    // Return to the anchor before the browser performs the natural Tab move.
    close({ restoreFocus: true });
    return;
  }
  const buttons = Array.from(menuRef.value?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? []);
  const index = buttons.findIndex(button => button === document.activeElement);
  const nextIndex = event.key === 'ArrowDown' ? (index + 1) % buttons.length
    : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : undefined;
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
    typeahead.value += event.key.toLocaleLowerCase();
    clearTimeout(typeaheadTimer);
    typeaheadTimer = setTimeout(() => {
      typeahead.value = '';
    }, 600);
    const match = buttons.find(button => button.textContent?.trim().toLocaleLowerCase().startsWith(typeahead.value));
    match?.focus();
  }
  if (nextIndex !== undefined) {
    event.preventDefault();
    buttons[nextIndex]?.focus();
  }
}

const typeahead = ref('');
onBeforeUnmount(() => clearTimeout(typeaheadTimer));
let typeaheadTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => props.disabled, disabled => {
  if (disabled) {
    close({ restoreFocus: false });
  }
});
useEventTargetListener(document, 'focusin', event => {
  const target = event.target as Node;
  if (open.value && !triggerRef.value?.contains(target) && !menuRef.value?.contains(target)) {
    close({ restoreFocus: false });
  }
});
onClickOutside(triggerRef, () => close({ restoreFocus: false }), { ignore: [menuRef] });


watch(() => disclosureOpen?.value, value => {
  if (value === false) {
    if (document.activeElement instanceof Node && menuRef.value?.contains(document.activeElement)) {
      disclosureFocusReturn?.()?.focus();
    }
    close({ restoreFocus: false });
  }
});
defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <button
    v-bind="$attrs"
    ref="triggerRef"
    type="button"
    :disabled="disabled"
    :aria-label="`${label ?? ''}: ${selected?.label ?? modelValue}${selected?.detail ? ` (${selected.detail})` : ''}${selected?.source?.description ? ` · ${selected.source.description}` : ''}`"
    aria-haspopup="listbox"
    :aria-expanded="open"
    :aria-controls="open ? menuId : undefined"
    :title="[selected?.label, selected?.detail, selected?.source?.description].filter(Boolean).join(' · ')"
    class="settings-select-trigger"
    :class="{ 'settings-select-trigger-embedded': surface === 'embedded', 'settings-select-trigger-toolbar': presentation === 'toolbar', 'settings-select-trigger-compact': size === 'compact', 'settings-select-trigger-inline': presentation === 'inline' }"
    :tw-class="['group flex min-w-0 items-center gap-3 px-3.5 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30', presentation === 'inline' ? 'w-auto rounded-md border border-transparent bg-transparent hover:border-gray-200 hover:bg-gray-100/70 dark:hover:border-gray-700 dark:hover:bg-gray-800/70' : surface === 'embedded' ? 'h-full w-full rounded-none border-0 bg-transparent shadow-none hover:bg-gray-50 focus-visible:ring-inset dark:hover:bg-gray-800' : 'w-full rounded-xl border border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700/60 dark:bg-gray-800/55 dark:hover:border-gray-600 dark:hover:bg-gray-800']"
    @click="toggle"
    @keydown.down.prevent="open || toggle()"
    @keydown.up.prevent="open || toggle()"
  >
    <slot name="leading" :option="selected" />
    <span :class="{ 'settings-select-content-toolbar': presentation === 'toolbar' || presentation === 'inline' }" tw-class="block min-w-0 flex-1">
      <span class="settings-select-value" :tw-class="['block truncate', presentation === 'inline' ? 'text-[11px] font-normal leading-4 text-gray-500 group-hover:text-gray-700 dark:text-gray-400 dark:group-hover:text-gray-200' : size === 'compact' ? 'text-xs font-medium leading-4 text-gray-800 dark:text-gray-100' : 'text-sm font-medium leading-5 text-gray-800 dark:text-gray-100']">{{ selected?.label ?? modelValue }}</span>
      <span v-if="presentation !== 'toolbar' && presentation !== 'inline'" tw-class="mt-0.5 flex h-4 min-w-0 items-center gap-1.5">
        <SettingsSourceBadge :source="selected?.source" />
        <span v-if="selected?.detail" tw-class="min-w-0 flex-1 truncate text-xs leading-4 text-gray-500 dark:text-gray-400">{{ selected.detail }}</span>
      </span>
    </span>
    <ChevronDownIcon :tw-class="['shrink-0 text-gray-400 transition-transform duration-200 group-hover:text-gray-600 dark:group-hover:text-gray-200', presentation === 'inline' ? 'h-2.5 w-2.5' : size === 'compact' ? 'h-3 w-3' : 'h-4 w-4', open && 'rotate-180']" />
  </button>
  <Teleport to="body">
    <Transition name="settings-select-menu">
      <div
        v-show="open"
        :id="menuId"
        ref="menuRef"
        role="listbox"
        :aria-label="label"
        :aria-hidden="!open"
        :inert="!open || undefined"
        :style="popup.placement.value.style"
        :data-placement="popup.placement.value.direction"
        :data-open="open"
        class="settings-select-menu"
        :tw-class="['overflow-y-auto overscroll-contain border border-gray-200 bg-white p-1.5 shadow-xl shadow-gray-950/15 dark:border-gray-700 dark:bg-gray-900 dark:shadow-black/40', size === 'compact' ? 'rounded-xl' : 'rounded-2xl']"
        @keydown="handleMenuKeydown({ event: $event })"
      >
        <button
          v-for="option in options"
          :key="option.value"
          type="button"
          role="option"
          :data-testid="'settings-select-option-' + option.value"
          :disabled="option.disabled"
          :aria-selected="option.value === modelValue"
          :aria-label="[option.label, option.detail, option.source?.description].filter(Boolean).join(' · ')"
          :title="[option.label, option.detail, option.source?.description].filter(Boolean).join(' · ')"
          :tw-class="['disabled:opacity-45 disabled:cursor-not-allowed flex w-full items-center text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/50', size === 'compact' ? 'min-h-8 gap-2 rounded-md px-2.5 py-1.5' : 'min-h-12 gap-3 rounded-xl px-3 py-2.5', option.value === modelValue ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400' : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800']"
          @click="choose({ value: option.value })"
        >
          <slot name="option" :option="option">
            <span tw-class="block min-w-0 flex-1">
              <span :tw-class="['block truncate font-medium', size === 'compact' ? 'text-xs' : 'text-sm']">{{ option.label }}</span>
              <span v-if="option.detail || option.source" tw-class="mt-1 flex min-w-0 items-center gap-1.5">
                <SettingsSourceBadge :source="option.source" />
                <span v-if="option.detail" tw-class="min-w-0 flex-1 truncate text-xs text-gray-500 dark:text-gray-400">{{ option.detail }}</span>
              </span>
            </span>
          </slot>
          <CheckIcon v-if="option.value === modelValue" tw-class="h-4 w-4 shrink-0" />
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.settings-select-trigger {
  min-height: var(--settings-select-height, 3.75rem);
}

.settings-select-trigger-embedded {
  min-height: calc(var(--settings-select-height, 3.75rem) - 2px);
}

.settings-select-trigger-toolbar {
  height: 2.75rem;
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
}

.settings-select-trigger-compact {
  height: auto;
  min-height: 1.75rem;
  padding: 0.25rem 0.625rem;
  gap: 0.5rem;
  border-radius: 0.5rem;
}

.settings-select-trigger-inline {
  min-height: 1.5rem;
  padding: 0.125rem 0.375rem;
  gap: 0.375rem;
  border-radius: 0.375rem;
}

.settings-select-content-toolbar {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.settings-select-content-toolbar > .settings-select-value {
  min-width: 0;
  flex: 1;
}

.settings-select-menu {
  transform-origin: center top;
}

.settings-select-menu[data-placement='top'] {
  transform-origin: center bottom;
}

.settings-select-menu[data-open='false'] {
  pointer-events: none;
}

.settings-select-menu-enter-active,
.settings-select-menu-leave-active {
  transition: opacity 130ms ease, transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.settings-select-menu-enter-from,
.settings-select-menu-leave-to {
  opacity: 0;
  transform: translateY(-3px) scale(0.99);
}

.settings-select-menu[data-placement='top'].settings-select-menu-enter-from,
.settings-select-menu[data-placement='top'].settings-select-menu-leave-to {
  transform: translateY(3px) scale(0.99);
}

@media (prefers-reduced-motion: reduce) {
  .settings-select-menu-enter-active,
  .settings-select-menu-leave-active,
  button svg {
    transition: none;
  }
}
</style>
