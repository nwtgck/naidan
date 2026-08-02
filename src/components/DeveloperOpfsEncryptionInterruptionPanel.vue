<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  AlertTriangleIcon,
  EyeIcon,
  EyeOffIcon,
  Loader2Icon,
  ShieldAlertIcon,
} from 'lucide-vue-next';
import { storageService } from '@/00-storage/service';
import type { OpfsEncryptionSettingsInspection } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import { validateEncryptionPassphrase } from '@/00-storage/service/naidan-opfs/passphrase';
import {
  interruptOrdinaryOpfsEncryptionTransition,
  type DeveloperOpfsEncryptionInterruptionBoundary,
  type DeveloperOpfsEncryptionInterruptionOperation,
} from './developer-opfs-encryption-transition-interruption';
import { useConfirm } from '@/composables/useConfirm';
import { ensureStrings, lazyStrings } from '@/strings';

const props = defineProps<{
  storageType: string,
}>();

const { showConfirm } = useConfirm();
const inspection = ref<OpfsEncryptionSettingsInspection>({ type: 'plain' });
const operation = ref<DeveloperOpfsEncryptionInterruptionOperation>('enable');
const boundary = ref<DeveloperOpfsEncryptionInterruptionBoundary>('pre_switch');
const loading = ref(false);
const passphrase = ref('');
const confirmPassphrase = ref('');
const showPassphrase = ref(false);
const errorMessage = ref<string>();

const available = computed(() => props.storageType === 'opfs');
const availableOperations = computed<readonly DeveloperOpfsEncryptionInterruptionOperation[]>(() => {
  switch (inspection.value.type) {
  case 'plain': return ['enable'];
  case 'encrypted': {
    const access = inspection.value.access;
    switch (access) {
    case 'locked': return [];
    case 'unlocked': return ['disable', 'reencrypt'];
    default: return access satisfies never;
    }
  }
  case 'recovery_required':
  case 'transitioning': return [];
  default: return inspection.value satisfies never;
  }
});
const passphraseRequired = computed(() => operation.value !== 'disable');
const passphraseValidation = computed(() => validateEncryptionPassphrase({ passphrase: passphrase.value }));
const confirmPassphraseValidation = computed(() => validateEncryptionPassphrase({
  passphrase: confirmPassphrase.value,
}));
const boundaryWhitespaceWarning = computed(() => (
  passphraseValidation.value.type === 'boundary_whitespace'
  || confirmPassphraseValidation.value.type === 'boundary_whitespace'
));
const passphraseValid = computed(() => (
  passphrase.value.length > 0
  && passphrase.value === confirmPassphrase.value
  && passphraseValidation.value.type !== 'line_break'
  && confirmPassphraseValidation.value.type !== 'line_break'
));
const canRun = computed(() => (
  available.value
  && availableOperations.value.includes(operation.value)
  && (!passphraseRequired.value || passphraseValid.value)
  && !loading.value
));

function selectDefaultOperation({ nextInspection }: {
  nextInspection: OpfsEncryptionSettingsInspection;
}): void {
  switch (nextInspection.type) {
  case 'plain':
    operation.value = 'enable';
    return;
  case 'encrypted': {
    const access = nextInspection.access;
    switch (access) {
    case 'locked': return;
    case 'unlocked':
      operation.value = 'disable';
      return;
    default: return access satisfies never;
    }
  }
  case 'recovery_required':
  case 'transitioning': return;
  default: nextInspection satisfies never;
  }
}

async function refreshInspection(): Promise<void> {
  if (!available.value) {
    inspection.value = { type: 'plain' };
    operation.value = 'enable';
    return;
  }
  errorMessage.value = undefined;
  try {
    const nextInspection = await storageService.inspectOpfsEncryptionSettings();
    inspection.value = nextInspection;
    selectDefaultOperation({ nextInspection });
  } catch (error: unknown) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function handlePassphrasePaste({ event }: { event: ClipboardEvent }): Promise<void> {
  const pastedText = event.clipboardData?.getData('text') ?? '';
  const validation = validateEncryptionPassphrase({ passphrase: pastedText });
  switch (validation.type) {
  case 'valid':
  case 'boundary_whitespace': return;
  case 'line_break':
    event.preventDefault();
    errorMessage.value = await ensureStrings.opfsEncryption__passphrases_cannot_contain_line_breaks();
    return;
  default: return validation satisfies never;
  }
}

async function runSelectedTransition({
  selectedBoundary,
  selectedOperation,
}: {
  selectedBoundary: DeveloperOpfsEncryptionInterruptionBoundary;
  selectedOperation: DeveloperOpfsEncryptionInterruptionOperation;
}): Promise<void> {
  await interruptOrdinaryOpfsEncryptionTransition({
    boundary: selectedBoundary,
    operation: selectedOperation,
    run: async ({ onProgress, signal }) => {
      switch (selectedOperation) {
      case 'enable':
        await storageService.enableOpfsEncryption({ onProgress, passphrase: passphrase.value, signal });
        return;
      case 'disable':
        await storageService.disableOpfsEncryption({ onProgress, signal });
        return;
      case 'reencrypt':
        await storageService.reencryptOpfsEncryption({ onProgress, passphrase: passphrase.value, signal });
        return;
      default: selectedOperation satisfies never;
      }
    },
  });
}

async function createInterruption(): Promise<void> {
  if (!canRun.value) return;
  const selectedBoundary = boundary.value;
  const selectedOperation = operation.value;
  loading.value = true;
  errorMessage.value = undefined;
  let transitionRequested = false;
  try {
    const confirmed = await showConfirm({
      title: await ensureStrings.DeveloperOpfsEncryptionInterruptionPanel__interrupt_opfs_transition(),
      message: await ensureStrings.DeveloperOpfsEncryptionInterruptionPanel__ordinary_transition_warning(),
      confirmButtonText: await ensureStrings.DeveloperOpfsEncryptionInterruptionPanel__interrupt_and_reload(),
      confirmButtonVariant: 'danger',
    });
    if (!confirmed) return;
    transitionRequested = true;
    await runSelectedTransition({ selectedBoundary, selectedOperation });
  } catch (error: unknown) {
    const operationErrorMessage = error instanceof Error ? error.message : String(error);
    if (!transitionRequested) await refreshInspection();
    errorMessage.value = operationErrorMessage;
  } finally {
    loading.value = false;
  }
}

watch(() => props.storageType, () => {
  void refreshInspection();
});

onMounted(() => {
  void refreshInspection();
});

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      createInterruption,
      refreshInspection,
    },
  }) || {}),
});
</script>

<template>
  <section
    data-testid="developer-opfs-encryption-interruption-panel"
    tw-class="space-y-4 rounded-2xl border border-amber-200/80 bg-amber-50/50 p-4 dark:border-amber-900/50 dark:bg-amber-950/10"
  >
    <div tw-class="flex items-start gap-3">
      <div tw-class="rounded-xl border border-amber-200 bg-white p-2 text-amber-600 shadow-sm dark:border-amber-900/60 dark:bg-gray-900 dark:text-amber-400">
        <ShieldAlertIcon tw-class="h-4 w-4" />
      </div>
      <div tw-class="space-y-1">
        <h4 tw-class="text-sm font-bold text-gray-800 dark:text-white">
          {{ lazyStrings.DeveloperOpfsEncryptionInterruptionPanel__opfs_transition_interruption() }}
        </h4>
        <p tw-class="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
          {{ lazyStrings.DeveloperOpfsEncryptionInterruptionPanel__interrupts_ordinary_transition() }}
        </p>
      </div>
    </div>

    <div v-if="!available" tw-class="rounded-xl border border-gray-200 bg-white/70 p-3 text-xs text-gray-500 dark:border-gray-800 dark:bg-gray-900/70 dark:text-gray-400">
      {{ lazyStrings.DeveloperOpfsEncryptionInterruptionPanel__opfs_only() }}
    </div>

    <div v-else-if="inspection.type === 'transitioning'" tw-class="rounded-xl border border-amber-200 bg-white/70 p-3 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-gray-900/70 dark:text-amber-300">
      {{ lazyStrings.DeveloperOpfsEncryptionInterruptionPanel__transition_in_progress() }}
    </div>

    <div v-else-if="inspection.type === 'encrypted' && inspection.access === 'locked'" tw-class="rounded-xl border border-amber-200 bg-white/70 p-3 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-gray-900/70 dark:text-amber-300">
      {{ lazyStrings.opfsEncryption__enter_passphrase_for_opfs_storage() }}
    </div>

    <div v-else-if="inspection.type === 'recovery_required'" tw-class="rounded-xl border border-red-200 bg-white/70 p-3 text-xs text-red-700 dark:border-red-900/60 dark:bg-gray-900/70 dark:text-red-300">
      {{ inspection.error instanceof Error ? inspection.error.message : String(inspection.error) }}
    </div>

    <div v-else tw-class="space-y-3">
      <div tw-class="grid gap-3 sm:grid-cols-2">
        <fieldset tw-class="min-w-0">
          <legend tw-class="text-xs font-bold text-gray-600 dark:text-gray-300">
            {{ lazyStrings.DeveloperOpfsEncryptionInterruptionPanel__operation() }}
          </legend>
          <div tw-class="mt-1.5 grid min-h-10 grid-flow-col auto-cols-fr overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
            <button
              v-if="availableOperations.includes('enable')"
              type="button"
              data-testid="developer-opfs-interruption-operation-enable"
              :aria-pressed="operation === 'enable'"
              :disabled="loading"
              tw-class="min-w-0 px-2 py-2 text-xs font-semibold text-gray-600 aria-pressed:bg-amber-600 aria-pressed:text-white dark:text-gray-300"
              @click="operation = 'enable'"
            >
              {{ lazyStrings.opfsEncryption__enable_opfs_encryption() }}
            </button>
            <button
              v-if="availableOperations.includes('disable')"
              type="button"
              data-testid="developer-opfs-interruption-operation-disable"
              :aria-pressed="operation === 'disable'"
              :disabled="loading"
              tw-class="min-w-0 px-2 py-2 text-xs font-semibold text-gray-600 aria-pressed:bg-amber-600 aria-pressed:text-white dark:text-gray-300"
              @click="operation = 'disable'"
            >
              {{ lazyStrings.opfsEncryption__decrypt_storage() }}
            </button>
            <button
              v-if="availableOperations.includes('reencrypt')"
              type="button"
              data-testid="developer-opfs-interruption-operation-reencrypt"
              :aria-pressed="operation === 'reencrypt'"
              :disabled="loading"
              tw-class="min-w-0 border-l border-gray-200 px-2 py-2 text-xs font-semibold text-gray-600 aria-pressed:bg-amber-600 aria-pressed:text-white dark:border-gray-700 dark:text-gray-300"
              @click="operation = 'reencrypt'"
            >
              {{ lazyStrings.opfsEncryption__re_encrypt() }}
            </button>
          </div>
        </fieldset>

        <fieldset tw-class="min-w-0">
          <legend tw-class="text-xs font-bold text-gray-600 dark:text-gray-300">
            {{ lazyStrings.DeveloperOpfsEncryptionInterruptionPanel__interruption_boundary() }}
          </legend>
          <div tw-class="mt-1.5 grid min-h-10 grid-cols-2 overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
            <button
              type="button"
              data-testid="developer-opfs-interruption-boundary-pre-switch"
              :aria-pressed="boundary === 'pre_switch'"
              :disabled="loading"
              tw-class="min-w-0 px-2 py-2 text-xs font-semibold text-gray-600 aria-pressed:bg-amber-600 aria-pressed:text-white dark:text-gray-300"
              @click="boundary = 'pre_switch'"
            >
              {{ lazyStrings.DeveloperOpfsEncryptionInterruptionPanel__before_authority_switch() }}
            </button>
            <button
              type="button"
              data-testid="developer-opfs-interruption-boundary-post-switch"
              :aria-pressed="boundary === 'post_switch'"
              :disabled="loading"
              tw-class="min-w-0 border-l border-gray-200 px-2 py-2 text-xs font-semibold text-gray-600 aria-pressed:bg-amber-600 aria-pressed:text-white dark:border-gray-700 dark:text-gray-300"
              @click="boundary = 'post_switch'"
            >
              {{ lazyStrings.DeveloperOpfsEncryptionInterruptionPanel__after_authority_switch() }}
            </button>
          </div>
        </fieldset>
      </div>

      <template v-if="passphraseRequired">
        <label tw-class="block text-xs font-bold text-gray-600 dark:text-gray-300">
          {{ lazyStrings.opfsEncryption__passphrase() }}
        </label>
        <div tw-class="relative">
          <input
            v-model="passphrase"
            data-testid="developer-opfs-interruption-passphrase"
            :type="showPassphrase ? 'text' : 'password'"
            autocomplete="new-password"
            :disabled="loading"
            tw-class="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 pr-11 text-sm text-gray-900 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            @paste="handlePassphrasePaste({ event: $event })"
          />
          <button
            type="button"
            :disabled="loading"
            :aria-label="lazyStrings.opfsEncryption__show_passphrase()"
            tw-class="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            @click="showPassphrase = !showPassphrase"
          >
            <EyeOffIcon v-if="showPassphrase" tw-class="h-4 w-4" />
            <EyeIcon v-else tw-class="h-4 w-4" />
          </button>
        </div>
        <input
          v-model="confirmPassphrase"
          data-testid="developer-opfs-interruption-confirm-passphrase"
          :type="showPassphrase ? 'text' : 'password'"
          autocomplete="new-password"
          :disabled="loading"
          :placeholder="lazyStrings.DeveloperOpfsEncryptionInterruptionPanel__confirm_passphrase()"
          tw-class="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          @paste="handlePassphrasePaste({ event: $event })"
        />
        <p
          v-if="passphraseValidation.type === 'line_break' || confirmPassphraseValidation.type === 'line_break'"
          tw-class="text-xs text-red-600 dark:text-red-400"
        >
          {{ lazyStrings.opfsEncryption__passphrases_cannot_contain_line_breaks() }}
        </p>
        <p v-else-if="boundaryWhitespaceWarning" tw-class="text-xs text-amber-700 dark:text-amber-400">
          {{ lazyStrings.opfsEncryption__leading_or_trailing_whitespace_is_part_of_passphrase() }}
        </p>
      </template>

      <button
        type="button"
        data-testid="developer-opfs-interruption-run"
        :disabled="!canRun"
        tw-class="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-600 px-4 py-3 text-xs font-bold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
        @click="createInterruption"
      >
        <Loader2Icon v-if="loading" tw-class="h-4 w-4 animate-spin" />
        {{ lazyStrings.DeveloperOpfsEncryptionInterruptionPanel__interrupt_and_reload() }}
      </button>
    </div>

    <p v-if="errorMessage" tw-class="flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
      <AlertTriangleIcon tw-class="mt-0.5 h-4 w-4 shrink-0" />
      <span tw-class="break-words">{{ errorMessage }}</span>
    </p>
  </section>
</template>
