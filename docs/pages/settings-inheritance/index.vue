<script setup lang="ts">
import RenderText from '../../components/RenderText';
import SettingsInheritanceDiagram from '../../components/demos/SettingsInheritanceDiagram.vue';
import SettingsInheritanceStep from '../../components/demos/SettingsInheritanceStep.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import type { DocsLocale } from '../../navigation/routes';
import type { CommonMessages, InheritanceGuideMessages } from '../../messages/types';

const { s } = defineProps<{ s: InheritanceGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-settings-inheritance">
    <h1>{{ s.title }}</h1>

    <section class="guide-purpose" aria-labelledby="inheritance-why">
      <h2 id="inheritance-why">{{ s.why_set_a_group_model_heading }}</h2>
      <p class="lead">{{ s.why_set_a_group_model }}</p>
    </section>

    <section class="guide-concept" aria-labelledby="inheritance-concept-heading">
      <h2 id="inheritance-concept-heading">{{ s.which_model_answers_heading }}</h2>
      <p>{{ s.how_model_inheritance_works }}</p>
      <p>{{ s.model_choice_scenes_introduction }}</p>
      <figure class="guide-figure">
        <SettingsInheritanceDiagram :messages="s" />
        <figcaption class="caption">{{ s.model_choice_diagram_caption }}</figcaption>
      </figure>
      <p>{{ s.model_lookup_order }}</p>
    </section>

    <h2 class="setup-heading">{{ s.set_values_in_naidan_heading }}</h2>
    <p class="app-entry-intro"><RenderText :node="s.open_naidan_for_settings({ locale, destination: { kind: 'screen', screen: 'home' } })" /></p>
    <p class="sample-note">{{ s.example_addresses_and_models }}</p>

    <section class="walkthrough-step" aria-labelledby="inheritance-global">
      <h3 id="inheritance-global">{{ s.set_global_starting_point_heading }}</h3>
      <p><RenderText :node="s.set_global_starting_point_instructions()" /></p>
      <figure class="guide-figure">
        <SettingsInheritanceStep stage="global" :messages="s" />
        <figcaption class="caption"><RenderText :node="s.global_connection_caption()" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="inheritance-group">
      <h3 id="inheritance-group">{{ s.set_group_model_and_endpoint_heading }}</h3>
      <p class="group-preparation"><RenderText :node="s.prepare_a_chat_group({ locale })" /></p>
      <p><RenderText :node="s.set_group_model_and_endpoint_instructions()" /></p>
      <figure class="guide-figure">
        <SettingsInheritanceStep stage="group" :messages="s" />
        <figcaption class="caption">{{ s.group_endpoint_caption }}</figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="inheritance-chat">
      <h3 id="inheritance-chat">{{ s.read_inherited_chat_values_heading }}</h3>
      <p><RenderText :node="s.read_inherited_chat_values_instructions()" /></p>
      <figure class="guide-figure">
        <SettingsInheritanceStep stage="inheritedChat" :messages="s" />
        <figcaption class="caption">{{ s.inherited_chat_values_caption }}</figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="inheritance-chat-model">
      <h3 id="inheritance-chat-model">{{ s.change_one_chat_model_heading }}</h3>
      <p><RenderText :node="s.change_one_chat_model_instructions()" /></p>
      <figure class="guide-figure">
        <SettingsInheritanceStep stage="chatModel" :messages="s" />
        <figcaption class="caption">{{ s.chat_model_override_caption }}</figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="inheritance-reset">
      <h3 id="inheritance-reset">{{ s.change_endpoint_then_inherit_heading }}</h3>
      <p><RenderText :node="s.change_endpoint_then_inherit_instructions()" /></p>
      <figure class="guide-figure">
        <SettingsInheritanceStep stage="reset" :messages="s" />
        <figcaption class="caption"><RenderText :node="s.return_to_inherited_endpoint_caption()" /></figcaption>
      </figure>
    </section>

    <p class="closing-note"><RenderText :node="s.restore_inherited_settings()" /></p>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'chat-groups', title: s.chat_groups_guide, description: s.organize_chats_and_settings_by_purpose }, { page: 'endpoint-type-ollama', title: s.connect_to_ollama_guide, description: s.choose_ollama_connection_and_model }]" />
  </article>
</template>

<style scoped>
.sample-note,.closing-note { padding:17px 20px;border-left:3px solid var(--blue);background:var(--surface);border-radius:0 10px 10px 0; }
.guide-purpose,.guide-concept { margin-top:30px; }
.guide-purpose h2,.guide-concept h2 { margin-bottom:10px; }
.guide-purpose .lead { margin-bottom:0; }
.guide-concept .guide-figure { margin:18px 0; }
.guide-concept figcaption { margin-inline:auto;max-width:680px; }
.setup-heading { border-top:1px solid var(--line);margin-top:38px;padding-top:22px; }
.walkthrough-step { border-top:1px solid var(--line);margin-top:38px;padding-top:22px; }
.walkthrough-step h3 { margin-top:0; }
.walkthrough-step > p { margin-bottom:0; }
.walkthrough-step > .group-preparation { margin-bottom:12px; }
.walkthrough-step .guide-figure { margin:18px 0 0; }
.walkthrough-step figcaption { margin-inline:auto;max-width:680px; }
.closing-note { margin-top:34px; }
</style>
