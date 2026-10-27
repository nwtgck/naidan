<script setup lang="ts">
import { ActivityIcon, BookmarkPlusIcon, CheckCircle2Icon, CheckIcon, ChevronDownIcon, LinkIcon, Loader2Icon, MousePointer2Icon, RefreshCwIcon, SaveIcon, SearchIcon } from 'lucide-vue-next';
import SettingsCameraFrame from './SettingsCameraFrame.vue';
import type { messages as english } from '../../pages/endpoint-type-ollama/messages/en';

defineProps<{ stage: 'open' | 'provider' | 'check' | 'model'; messages: typeof english }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="endpoint-scene" :class="`stage-${stage}`">
    <SettingsCameraFrame :focus="stage" :messages="messages" :animation-id="`ollama-${stage}`" :test-id="`ollama-settings-${stage}`">
      <div class="guide-content">
        <div class="connection-toolbar"><span class="copy-url"><LinkIcon :size="13" />{{ messages.copy_setup_url }}</span></div>
        <div class="connection-layout">
          <div class="field provider-field">
            <span class="field-label">{{ messages.api_provider }}</span>
            <div class="field-box"><span class="layered"><span class="provider-before">{{ messages.openai_compatible }}</span><span class="provider-after">{{ messages.ollama }}</span></span><ChevronDownIcon :size="17" /><MousePointer2Icon v-if="stage === 'provider'" class="pointer provider-pointer" :size="23" /></div>
            <div v-if="stage === 'provider'" class="provider-options"><span>{{ messages.openai_compatible }}</span><span class="provider-option-target">{{ messages.ollama }}<MousePointer2Icon class="pointer option-pointer" :size="23" /></span></div>
          </div>
          <div class="connection-details">
            <div class="presets"><span class="preset target-preset">{{ messages.ollama_local_preset }}<MousePointer2Icon v-if="stage === 'provider'" class="pointer preset-pointer" :size="23" /></span></div>
            <div class="field url-field">
              <div class="field-heading"><span class="field-label">{{ messages.endpoint_url }}</span><span class="check-action"><span class="check-idle"><ActivityIcon :size="14" />{{ messages.check_connection }}</span><span class="check-loading"><Loader2Icon class="spinner" :size="14" />{{ messages.check_connection }}</span><span class="check-done"><CheckIcon :size="14" />{{ messages.check_connection }}</span><MousePointer2Icon v-if="stage === 'check'" class="pointer check-pointer" :size="23" /></span></div>
              <div class="field-box url-box"><span class="layered"><span class="url-before">http://localhost:1234/v1</span><span class="url-after">http://localhost:11434</span></span></div>
              <p class="auto-hint">{{ messages.localhost_auto_check_note }}</p>
            </div>
            <div class="headers-disclosure"><div class="headers-heading"><span>{{ messages.custom_http_headers }}</span><span class="header-count">0</span><ChevronDownIcon :size="15" /></div></div>
          </div>
          <div class="field model-section">
            <span class="field-label">{{ messages.default_model }}</span>
            <div class="model-picker">
              <div class="field-box model-box"><span class="layered"><span class="model-before">{{ messages.none }}</span><span class="model-after">{{ messages.sample_ollama_model }}</span></span><ChevronDownIcon :size="17" /><MousePointer2Icon v-if="stage === 'model'" class="pointer model-pointer" :size="23" /></div>
              <div v-if="stage === 'model'" class="model-options"><div class="model-options-tools"><span class="model-search"><SearchIcon :size="13" />{{ messages.filter_models }}</span><RefreshCwIcon :size="13" /></div><span class="model-option">{{ messages.none }}</span><span class="model-option model-option-target">{{ messages.sample_ollama_model }}<MousePointer2Icon class="pointer model-option-pointer" :size="23" /></span></div>
            </div>
            <small>{{ messages.inherited_default_note }}</small>
          </div>
        </div>
      </div>
      <template #footer><span class="secondary-save"><BookmarkPlusIcon :size="15" />{{ messages.save_as_new_profile }}</span><span class="save-action"><span class="save-idle"><SaveIcon :size="15" />{{ messages.save_changes }}</span><span class="save-done"><CheckCircle2Icon :size="15" />{{ messages.settings_saved }}</span><MousePointer2Icon v-if="stage === 'model'" class="pointer save-pointer" :size="23" /></span></template>
    </SettingsCameraFrame>
  </div>
</template>
