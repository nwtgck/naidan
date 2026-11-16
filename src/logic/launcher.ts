import type { Component } from 'vue';
import { AudioLinesIcon, ClapperboardIcon, FileTextIcon, HeadphonesIcon, LanguagesIcon, MessageSquareIcon, MicIcon, SlidersHorizontalIcon, SparklesIcon, WorkflowIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';

export type LauncherCategory = 'all' | 'create' | 'write' | 'edit';
export type LauncherEntry = {
  // A Vue list key created once with this definition.
  forKey: symbol,
  icon: Component,
  category: Exclude<LauncherCategory, 'all'>,
  searchAliases: readonly string[],
  title: () => string | undefined,
  description: () => string | undefined,
  destination: { kind: 'route', path: string } | { kind: 'chat' } | { kind: 'unimplemented' },
};

// Keep entry definitions and their curated order here so changes intentionally
// reach both Home and the launcher without a second list being overlooked.
// Each surface owns its presentation; sharing entries does not require sharing
// their layout. Categories filter this order instead of ranking it again.
export const launcherEntries: readonly LauncherEntry[] = [
  { forKey: Symbol(), icon: MessageSquareIcon, category: 'write', searchAliases: ['chat', 'conversation'], title: () => lazyStrings.launcher__chat(), description: () => lazyStrings.launcher__return_to_your_conversation(), destination: { kind: 'chat' } },
  { forKey: Symbol(), icon: LanguagesIcon, category: 'write', searchAliases: ['translate', 'translation'], title: () => lazyStrings.launcher__translation(), description: () => lazyStrings.launcher__translate_text_into_another_language(), destination: { kind: 'route', path: '/translation' } },
  { forKey: Symbol(), icon: SparklesIcon, category: 'create', searchAliases: ['image', 'picture'], title: () => lazyStrings.launcher__image_generation(), description: () => lazyStrings.launcher__create_images_from_text(), destination: { kind: 'route', path: '/image-generation' } },
  { forKey: Symbol(), icon: AudioLinesIcon, category: 'create', searchAliases: ['audio', 'speech', 'tts'], title: () => lazyStrings.launcher__audio_generation(), description: () => lazyStrings.launcher__read_text_in_a_voice_you_choose(), destination: { kind: 'route', path: '/audio-generation' } },
  { forKey: Symbol(), icon: HeadphonesIcon, category: 'write', searchAliases: ['live', 'conversation', 'voice', 'dialogue'], title: () => lazyStrings.launcher__live_conversation(), description: () => lazyStrings.launcher__talk_with_ai_using_your_voice(), destination: { kind: 'route', path: '/live-conversation' } },
  { forKey: Symbol(), icon: WorkflowIcon, category: 'create', searchAliases: ['workflow', 'automation'], title: () => lazyStrings.launcher__workflows(), description: () => lazyStrings.launcher__connect_and_run_multiple_steps(), destination: { kind: 'route', path: '/workflows' } },
  { forKey: Symbol(), icon: FileTextIcon, category: 'write', searchAliases: ['transcription', 'transcribe', 'asr', 'speech to text'], title: () => lazyStrings.launcher__audio_transcription(), description: () => lazyStrings.launcher__turn_recordings_and_videos_into_text(), destination: { kind: 'unimplemented' } },
  { forKey: Symbol(), icon: MicIcon, category: 'write', searchAliases: ['dictation'], title: () => lazyStrings.launcher__long_form_dictation(), description: () => lazyStrings.launcher__write_by_speaking(), destination: { kind: 'unimplemented' } },
  { forKey: Symbol(), icon: SlidersHorizontalIcon, category: 'edit', searchAliases: ['repair', 'enhance', 'denoise'], title: () => lazyStrings.launcher__recording_enhancement(), description: () => lazyStrings.launcher__reduce_noise_and_echo_in_recordings(), destination: { kind: 'unimplemented' } },
  { forKey: Symbol(), icon: ClapperboardIcon, category: 'edit', searchAliases: ['video', 'subtitle', 'caption'], title: () => lazyStrings.launcher__video_and_subtitle_editing(), description: () => lazyStrings.launcher__create_subtitles_and_edit_video(), destination: { kind: 'unimplemented' } },
  { forKey: Symbol(), icon: HeadphonesIcon, category: 'create', searchAliases: ['drama'], title: () => lazyStrings.launcher__audio_drama(), description: () => lazyStrings.launcher__perform_a_script_with_multiple_voices(), destination: { kind: 'unimplemented' } },
];

export const launcherCategories: readonly LauncherCategory[] = ['all', 'create', 'write', 'edit'];

export function launcherCategoryLabel({ category }: { category: LauncherCategory }): string | undefined {
  switch (category) {
  case 'all': return lazyStrings.launcher__all();
  case 'create': return lazyStrings.launcher__create();
  case 'write': return lazyStrings.launcher__speak_and_write();
  case 'edit': return lazyStrings.launcher__edit();
  default: {
    const exhaustive: never = category;
    return exhaustive;
  }
  }
}

export function selectLauncherEntries({ category, query, unimplementedLauncherEntries }: {
  category: LauncherCategory,
  query: string,
  unimplementedLauncherEntries: 'show' | 'hide',
}): readonly LauncherEntry[] {
  const search = query.trim().toLocaleLowerCase();
  return launcherEntries.filter(entry => {
    if (entry.destination.kind === 'unimplemented' && unimplementedLauncherEntries === 'hide') {
      return false;
    }
    if (category !== 'all' && entry.category !== category) {
      return false;
    }
    return search.length === 0 || `${entry.title() ?? ''} ${entry.description() ?? ''} ${entry.searchAliases.join(' ')}`.toLocaleLowerCase().includes(search);
  });
}

export const TEST_ONLY = {
};
