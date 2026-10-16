<script setup lang="ts">
import { computed } from 'vue';
import RenderText from '../../components/RenderText';
import RelatedGuide from '../../components/RelatedGuide.vue';
import NaidanRpcStep from '../../components/demos/NaidanRpcStep.vue';
import type { CommonMessages, NaidanRpcMessages } from '../../messages/types';
import type { DocsLocale } from '../../navigation/routes';

const props = defineProps<{ s: NaidanRpcMessages; locale: DocsLocale; common: CommonMessages }>();

const steps = computed(() => ({
  enable: { title: props.s.enable_peer_connection_heading, body: props.s.enable_peer_connection_instructions, caption: props.s.enable_peer_connection_figure_caption },
  pair: { title: props.s.pair_browsers_heading, body: props.s.pair_browsers_instructions, caption: props.s.pair_browsers_figure_caption },
  verify: { title: props.s.verify_peer_heading, body: props.s.verify_peer_instructions, caption: props.s.verify_peer_figure_caption },
  provide: { title: props.s.grant_peer_methods_heading, body: props.s.grant_peer_methods_instructions, caption: props.s.grant_peer_methods_figure_caption },
  use: { title: props.s.select_peer_for_chat_heading, body: props.s.select_peer_for_chat_instructions, caption: props.s.select_peer_for_chat_figure_caption },
}));

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-models-naidan-rpc">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>
    <p class="app-entry-intro"><RenderText :node="s.open_app_on_each_device({ locale, destination: { kind: 'screen', screen: 'home' } })" /></p>
    <p class="hosted-example"><RenderText :node="s.hosted_edition_requirement({ locale, href: 'https://naidan.pages.dev/' })" /></p>

    <section v-for="(step, key) in steps" :key="key" class="rpc-step" :aria-labelledby="`rpc-${key}`" data-testid="rpc-guide-step">
      <h2 :id="`rpc-${key}`">{{ step.title }}</h2>
      <p><RenderText :node="step.body()" /></p>
      <p v-if="key === 'pair'" class="relay-origin"><RenderText :node="s.piping_server_relay_example({ locale, href: 'https://github.com/nwtgck/piping-server#public-servers', serverSample: s.sample_relay_origin })" /></p>
      <figure class="guide-figure"><NaidanRpcStep :stage="key" :messages="s" /><figcaption class="caption"><RenderText :node="step.caption()" /></figcaption></figure>
    </section>

    <section class="rpc-note"><h2>{{ s.peer_image_generation_heading }}</h2><p><RenderText :node="s.peer_image_generation_instructions()" /></p></section>
    <section class="rpc-note"><h2>{{ s.peer_data_boundary_heading }}</h2><p>{{ s.peer_data_boundary }}</p></section>
    <section class="rpc-note"><h2>{{ s.peer_inference_availability_heading }}</h2><p><RenderText :node="s.peer_inference_availability()" /></p></section>

    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'endpoint-type-llama-cpp-browser', title: s.serving_browser_model_guide_title, description: s.serving_browser_model_guide_description }]" />
  </article>
</template>

<style scoped>
.rpc-step {
  border-top: 1px solid var(--line);
  margin-top: 36px;
  padding-top: 22px;
}
.rpc-step h2 {
  margin-top: 0;
}
.rpc-step > p {
  margin-bottom: 0;
}
.rpc-step .guide-figure {
  margin: 18px 0 0;
}
.rpc-step figcaption {
  margin-inline: auto;
  max-width: 680px;
}
.rpc-note {
  margin-top: 40px;
}
</style>
