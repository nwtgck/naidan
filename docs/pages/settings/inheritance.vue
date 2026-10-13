<script setup lang="ts">
import SettingsInheritanceStep from '../../site/demos/SettingsInheritanceStep.vue';
import { docsHref } from '../../site/routes';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages, InheritanceGuideMessages } from '../../site/messages';

defineProps<{ s: InheritanceGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-settings-inheritance">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>
    <p class="sample-note">{{ s.example }}</p>

    <section class="walkthrough-step" aria-labelledby="inheritance-global">
      <h2 id="inheritance-global">{{ s.steps.global.title }}</h2>
      <p>{{ s.steps.global.body }}</p>
      <figure class="guide-figure">
        <SettingsInheritanceStep stage="global" :copy="s.demo" />
        <figcaption class="caption">{{ s.steps.global.caption }}</figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="inheritance-group">
      <h2 id="inheritance-group">{{ s.steps.group.title }}</h2>
      <p>{{ s.steps.group.body }}</p>
      <figure class="guide-figure">
        <SettingsInheritanceStep stage="group" :copy="s.demo" />
        <figcaption class="caption">{{ s.steps.group.caption }}</figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="inheritance-chat">
      <h2 id="inheritance-chat">{{ s.steps.inheritedChat.title }}</h2>
      <p>{{ s.steps.inheritedChat.body }}</p>
      <figure class="guide-figure">
        <SettingsInheritanceStep stage="inheritedChat" :copy="s.demo" />
        <figcaption class="caption">{{ s.steps.inheritedChat.caption }}</figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="inheritance-chat-model">
      <h2 id="inheritance-chat-model">{{ s.steps.chatModel.title }}</h2>
      <p>{{ s.steps.chatModel.body }}</p>
      <figure class="guide-figure">
        <SettingsInheritanceStep stage="chatModel" :copy="s.demo" />
        <figcaption class="caption">{{ s.steps.chatModel.caption }}</figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="inheritance-reset">
      <h2 id="inheritance-reset">{{ s.steps.reset.title }}</h2>
      <p>{{ s.steps.reset.body }}</p>
      <figure class="guide-figure">
        <SettingsInheritanceStep stage="reset" :copy="s.demo" />
        <figcaption class="caption">{{ s.steps.reset.caption }}</figcaption>
      </figure>
    </section>

    <p class="closing-note">{{ s.after }}</p>
    <a class="next-link" :href="docsHref({ locale, page: 'models/ollama' })">{{ s.ollamaLink }} <span aria-hidden="true">→</span></a>
  </article>
</template>

<style scoped>
.sample-note,.closing-note { padding:17px 20px;border-left:3px solid var(--blue);background:var(--surface);border-radius:0 10px 10px 0; }
.walkthrough-step { border-top:1px solid var(--line);margin-top:38px;padding-top:22px; }
.walkthrough-step h2 { margin-top:0; }
.walkthrough-step > p { margin-bottom:0; }
.walkthrough-step .guide-figure { margin:18px 0 0; }
.walkthrough-step figcaption { margin-inline:auto;max-width:680px; }
.closing-note { margin-top:34px; }
</style>
