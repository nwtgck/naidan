<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { checkBrowserAiAvailability } from './native';
import { readBrowserAiMessages } from './messages';
import type { BrowserAiAvailabilityStatus } from './native';
import type { BrowserAiAvailabilityPayload } from './contracts';

const props = defineProps<BrowserAiAvailabilityPayload>();
const messages = readBrowserAiMessages({ locale: props.locale });
type Status = 'unchecked' | 'checking' | BrowserAiAvailabilityStatus;
const status = ref<Status>('unchecked');
let active = false;
let revision = 0;

const message = computed(() => {
  switch (status.value) {
  case 'unchecked': return messages.not_checked_yet;
  case 'checking': return messages.checking_browser_model;
  case 'available': return messages.browser_model_available;
  case 'downloadable': return messages.browser_model_downloadable;
  case 'downloading': return messages.browser_model_downloading;
  case 'unavailable': return messages.browser_model_unavailable;
  case 'apiAbsent': return messages.language_model_api_is_not_exposed;
  case 'unknown': return messages.unrecognized_browser_status;
  case 'rejected': return messages.browser_check_failed;
  default: { const unreachable: never = status.value; throw new Error(`Unknown browser AI availability status: ${unreachable}`); }
  }
});

const tone = computed(() => {
  switch (status.value) {
  case 'available': return 'available';
  case 'downloadable':
  case 'downloading': return 'preparation';
  case 'unchecked':
  case 'checking':
  case 'unavailable':
  case 'apiAbsent':
  case 'unknown':
  case 'rejected': return 'neutral';
  default: { const unreachable: never = status.value; throw new Error(`Unknown browser AI availability status: ${unreachable}`); }
  }
});

async function recheck(): Promise<void> {
  const current = ++revision;
  status.value = 'checking';
  const result = await checkBrowserAiAvailability({ nativeScope: globalThis as typeof globalThis & { LanguageModel?: unknown } });
  if (active && current === revision) status.value = result;
}

onMounted(() => {
  active = true;
  void recheck();
});
onUnmounted(() => {
  active = false;
  revision += 1;
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
  <section class="browser-ai-availability" data-testid="browser-ai-availability">
    <h2>{{ messages.check_this_browser_heading }}</h2>
    <p class="scope">{{ messages.browser_scope }}</p>
    <div class="result" :data-tone="tone">
      <p role="status" aria-live="polite" aria-atomic="true" data-testid="browser-ai-availability-status">{{ message }}</p>
      <button type="button" :disabled="status === 'unchecked' || status === 'checking'" @click="recheck">{{ messages.check_again }}</button>
    </div>
    <p class="limits">{{ messages.availability_check_limits }}</p>
  </section>
</template>

<style scoped>
.browser-ai-availability {
  margin: 32px 0;
  padding: 21px 23px;
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  background: var(--surface);
}
.browser-ai-availability h2 {
  margin: 0 0 8px;
  font-size: 1.16em;
}
.browser-ai-availability p {
  margin: 0;
}
.scope,.limits {
  color: var(--muted);
  font-size: .9em;
  line-height: 1.7;
}
.result {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 17px 0;
  padding: 14px 16px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--surface-2);
}
.result[data-tone="available"] {
  border-color: color-mix(in srgb,var(--green) 52%,var(--line));
  color: var(--green);
}
.result[data-tone="preparation"] {
  border-color: color-mix(in srgb,var(--blue) 44%,var(--line));
  color: var(--blue);
}
.result p {
  font-weight: 650;
  line-height: 1.6;
}
.result button {
  flex: none;
  padding: 7px 11px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font-size: .8em;
  font-weight: 700;
}
.result button:disabled {
  opacity: .55;
  cursor: default;
}
@media(max-width:620px) {
  .browser-ai-availability {
    padding: 18px;
  }
  .result {
    align-items: flex-start;
    flex-direction: column;
  }
  .result button {
    align-self: flex-start;
  }
}
</style>
