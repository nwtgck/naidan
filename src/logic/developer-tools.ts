import type { Component } from 'vue';
import { AudioLinesIcon, CpuIcon, FileTextIcon, FlaskConicalIcon, ImageIcon, SearchCheckIcon, Settings2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { isModelSupportInvestigationAvailable } from '@/features/transformers-js/model-support-investigation';

export type DeveloperToolEntry = {
  id: string, section: 'investigation' | 'settings', icon: Component,
  title: () => string | undefined, description: () => string | undefined,
  availability: 'available' | 'hosted-only' | 'standalone-only',
  action:
    | { kind: 'route', path: '/llama-cpp-browser/diagnostics' | '/debug/standalone' | '/image-generation/diagnostics' | '/live-conversation/diagnostics' | '/live-conversation/diagnostics/transcription' }
    | { kind: 'model-support' }
    | { kind: 'settings' },
};

export function createDeveloperToolEntries(): readonly DeveloperToolEntry[] {
  return [
    { id: 'llama-diagnostics', section: 'investigation', icon: CpuIcon, title: () => lazyStrings.DeveloperToolsPanel__llama_cpp_inference_diagnostics(), description: () => lazyStrings.DeveloperToolsPanel__measure_saved_lm_models(), availability: 'available', action: { kind: 'route', path: '/llama-cpp-browser/diagnostics' } },
    { id: 'standalone-verification', section: 'investigation', icon: FlaskConicalIcon, title: () => lazyStrings.DeveloperToolsPanel__standalone_verification(), description: () => lazyStrings.DeveloperToolsPanel__check_the_standalone_runtime(), availability: __BUILD_MODE_IS_STANDALONE__ ? 'available' : 'standalone-only', action: { kind: 'route', path: '/debug/standalone' } },
    { id: 'transformers-model-support', section: 'investigation', icon: SearchCheckIcon, title: () => lazyStrings.DeveloperToolsPanel__transformers_model_support_investigation(), description: () => lazyStrings.DeveloperToolsPanel__check_transformers_model_compatibility(), availability: isModelSupportInvestigationAvailable ? 'available' : 'hosted-only', action: { kind: 'model-support' } },
    { id: 'image-diagnostics', section: 'investigation', icon: ImageIcon, title: () => lazyStrings.DeveloperToolsPanel__image_generation_investigation(), description: () => lazyStrings.DeveloperToolsPanel__measure_image_generation(), availability: __BUILD_MODE_IS_HOSTED__ ? 'available' : 'hosted-only', action: { kind: 'route', path: '/image-generation/diagnostics' } },
    { id: 'audio-response', section: 'investigation', icon: AudioLinesIcon, title: () => lazyStrings.DeveloperToolsPanel__audio_response_investigation(), description: () => lazyStrings.DeveloperToolsPanel__compare_audio_responses(), availability: __BUILD_MODE_IS_HOSTED__ ? 'available' : 'hosted-only', action: { kind: 'route', path: '/live-conversation/diagnostics' } },
    { id: 'transcription', section: 'investigation', icon: FileTextIcon, title: () => lazyStrings.DeveloperToolsPanel__transcription_investigation(), description: () => lazyStrings.DeveloperToolsPanel__measure_audio_transcription(), availability: __BUILD_MODE_IS_HOSTED__ ? 'available' : 'hosted-only', action: { kind: 'route', path: '/live-conversation/diagnostics/transcription' } },
    { id: 'developer-settings', section: 'settings', icon: Settings2Icon, title: () => lazyStrings.DeveloperToolsPanel__developer_settings(), description: () => lazyStrings.DeveloperToolsPanel__open_advanced_settings(), availability: 'available', action: { kind: 'settings' } },
  ];
}

export const developerToolSections = [
  { id: 'investigation', title: () => lazyStrings.DeveloperToolsPanel__investigations() },
  { id: 'settings', title: () => lazyStrings.DeveloperToolsPanel__settings() },
] as const;

export function developerToolAvailable({ entry }: { entry: DeveloperToolEntry }): boolean {
  const value = entry.availability;
  switch (value) {
  case 'available': return true;
  case 'hosted-only': case 'standalone-only': return false;
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
}

export function developerToolUnavailableReason({ entry }: { entry: DeveloperToolEntry }): string | undefined {
  const value = entry.availability;
  switch (value) {
  case 'available': return undefined;
  case 'hosted-only': return lazyStrings.DeveloperToolsPanel__hosted_version_only();
  case 'standalone-only': return lazyStrings.DeveloperToolsPanel__standalone_version_only();
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
