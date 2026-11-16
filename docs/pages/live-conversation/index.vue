<script setup lang="ts">
import RenderText from '../../components/RenderText';
import RelatedGuide from '../../components/RelatedGuide.vue';
import LiveConversationFlowDiagram from '../../components/demos/LiveConversationFlowDiagram.vue';
import LiveConversationGuideStep from '../../components/demos/LiveConversationGuideStep.vue';
import type { CommonMessages, LiveConversationGuideMessages } from '../../messages/types';
import type { DocsLocale } from '../../navigation/routes';

defineProps<{ s: LiveConversationGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-live-conversation">
    <h1>{{ s.title }}</h1>
    <p class="lead"><RenderText :node="s.introduction()" /></p>
    <p class="app-entry-intro"><RenderText :node="s.open_workspace({ locale, destination: { kind: 'screen', screen: 'live-conversation' } })" /></p>
    <figure class="guide-figure"><LiveConversationFlowDiagram :messages="s" /><figcaption class="caption">{{ s.local_flow_caption }}</figcaption></figure>

    <section aria-labelledby="live-prepare">
      <h2 id="live-prepare">{{ s.prepare_heading }}</h2>
      <p><RenderText :node="s.prepare_model()" /></p>
      <p><RenderText :node="s.prepare_files()" /></p>
      <figure class="guide-figure"><LiveConversationGuideStep stage="prepare" :messages="s" /><figcaption class="caption">{{ s.prepare_caption }}</figcaption></figure>
    </section>
    <section aria-labelledby="live-talk">
      <h2 id="live-talk">{{ s.talk_heading }}</h2>
      <p><RenderText :node="s.record_and_send()" /></p>
      <figure class="guide-figure"><LiveConversationGuideStep stage="talk" :messages="s" /><figcaption class="caption">{{ s.talk_caption }}</figcaption></figure>
      <p><RenderText :node="s.choose_outputs()" /></p>
    </section>
    <section aria-labelledby="live-interrupt">
      <h2 id="live-interrupt">{{ s.interrupt_heading }}</h2>
      <p><RenderText :node="s.interrupt_response()" /></p>
      <figure class="guide-figure"><LiveConversationGuideStep stage="interrupt" :messages="s" /><figcaption class="caption">{{ s.interrupt_caption }}</figcaption></figure>
      <p><RenderText :node="s.queue_next_message()" /></p>
    </section>
    <section aria-labelledby="live-inputs">
      <h2 id="live-inputs">{{ s.other_inputs_heading }}</h2>
      <p><RenderText :node="s.attach_audio()" /></p>
      <figure class="guide-figure"><LiveConversationGuideStep stage="attachments" :messages="s" /><figcaption class="caption">{{ s.attachments_caption }}</figcaption></figure>
      <p><RenderText :node="s.text_and_images()" /></p>
      <p><RenderText :node="s.transcription_note()" /></p>
    </section>
    <section aria-labelledby="live-shell">
      <h2 id="live-shell">{{ s.shell_heading }}</h2>
      <p><RenderText :node="s.shell_setup()" /></p>
      <p><RenderText :node="s.shell_approval()" /></p>
      <figure class="guide-figure"><LiveConversationGuideStep stage="shell" :messages="s" /><figcaption class="caption">{{ s.shell_caption }}</figcaption></figure>
      <p>{{ s.shell_writes_remain }}</p>
    </section>
    <section aria-labelledby="live-memory">
      <h2 id="live-memory">{{ s.memory_heading }}</h2>
      <p><RenderText :node="s.temporary_history()" /></p>
      <p><RenderText :node="s.reset_and_release()" /></p>
    </section>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'endpoint-type-llama-cpp-browser', title: s.model_guide_title, description: s.model_guide_description }, { page: 'file-and-folder-settings', title: s.folder_guide_title, description: s.folder_guide_description }, { page: 'audio-generation', title: s.speech_guide_title, description: s.speech_guide_description }]" />
  </article>
</template>
