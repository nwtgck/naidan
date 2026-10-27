<script setup lang="ts">
import RenderText from '../../components/RenderText';
import RelatedGuide from '../../components/RelatedGuide.vue';
import AudioCreationStep from '../../components/demos/AudioCreationStep.vue';
import type { AudioSpeechMessages, CommonMessages } from '../../messages/types';
import type { DocsLocale } from '../../navigation/routes';

defineProps<{ s: AudioSpeechMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-audio-speech">
    <h1>{{ s.title }}</h1>
    <p class="lead"><RenderText :node="s.generate_speech_with_a_local_model()" /></p>
    <p class="app-entry-intro"><RenderText :node="s.start_in_the_audio_workspace({ locale, destination: { kind: 'screen', screen: 'audio-generation' } })" /></p>

    <section class="media-step" aria-labelledby="audio-open">
      <h2 id="audio-open">{{ s.open_audio_generation_and_prepare_a_model }}</h2>
      <p><RenderText :node="s.find_and_prepare_an_audio_model()" /></p>
      <p><RenderText :node="s.use_your_own_audio_model_files()" /></p>
      <figure class="guide-figure"><AudioCreationStep stage="open" :messages="s" /><figcaption class="caption">{{ s.download_and_select_an_audio_model }}</figcaption></figure>
    </section>

    <section class="media-step" aria-labelledby="audio-text">
      <h2 id="audio-text">{{ s.enter_text_and_choose_its_language }}</h2>
      <p><RenderText :node="s.set_the_speech_text_and_language()" /></p>
      <p>{{ s.recognize_the_selected_audio_model }}</p>
      <figure class="guide-figure"><AudioCreationStep stage="text" :messages="s" /><figcaption class="caption">{{ s.choose_a_model_text_and_language }}</figcaption></figure>
    </section>

    <section class="media-step" aria-labelledby="audio-generate">
      <h2 id="audio-generate">{{ s.generate_and_follow_progress }}</h2>
      <p><RenderText :node="s.generate_speech_and_capture_progress()" /></p>
      <figure class="guide-figure"><AudioCreationStep stage="generate" :messages="s" /><figcaption class="caption">{{ s.speech_generation_progress }}</figcaption></figure>
    </section>

    <section class="media-step" aria-labelledby="audio-save">
      <h2 id="audio-save">{{ s.play_and_save_the_wav }}</h2>
      <p><RenderText :node="s.save_the_completed_wav()" /></p>
      <figure class="guide-figure"><AudioCreationStep stage="save" :messages="s" /><figcaption class="caption"><RenderText :node="s.explicit_wav_save_action()" /></figcaption></figure>
    </section>

    <section class="media-note" aria-labelledby="audio-reference"><h2 id="audio-reference">{{ s.add_a_reference_voice_when_needed }}</h2><p>{{ s.choose_a_reference_voice }}</p></section>
    <section class="media-note" aria-labelledby="audio-reading"><h2 id="audio-reading">{{ s.chat_read_aloud_is_separate }}</h2><p><RenderText :node="s.chat_read_aloud_uses_web_speech()" /></p></section>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'endpoint-type-llama-cpp-browser', title: s.run_a_gguf_model_in_your_browser, description: s.start_a_chat_with_a_local_gguf_model }]" />
  </article>
</template>

<style scoped>
.media-step {
  border-top: 1px solid var(--line);
  margin-top: 36px;
  padding-top: 22px;
}
.media-step h2 {
  margin-top: 0;
}
.media-step > p {
  margin-bottom: 0;
}
.media-step .guide-figure {
  margin: 18px 0 0;
}
.media-step figcaption {
  margin-inline: auto;
  max-width: 680px;
}
.media-note {
  margin-top: 40px;
}
</style>
