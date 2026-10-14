<script setup lang="ts">
import UiText from '../../site/UiText.vue';
import AppEntryLink from '../../site/AppEntryLink.vue';
import GroupStep from '../../site/demos/GroupStep.vue';
import GroupSettingsStep from '../../site/demos/GroupSettingsStep.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import { docsHref } from '../../site/routes';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages } from '../../site/messages';
import type { strings as groupsStrings } from '../../strings/chat/groups/en';

defineProps<{ s: typeof groupsStrings; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-chat-groups">
    <h1>{{ s.title }}</h1>
    <p class="lead"><UiText :text="s.intro" /></p>
    <p class="app-entry-intro">{{ s.launch.before }}<AppEntryLink :destination="{ kind: 'screen', screen: 'home' }" :locale="locale" display="path" /><UiText :text="s.launch.after" /></p>

    <section class="walkthrough-step" aria-labelledby="groups-create">
      <h2 id="groups-create">{{ s.steps.create.title }}</h2>
      <p><UiText :text="s.steps.create.body" /></p>
      <figure class="guide-figure">
        <GroupStep stage="create" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.create.caption" /></figcaption>
      </figure>
    </section>

    <p class="prerequisite">{{ s.setup.before }}<a :href="docsHref({ locale, page: 'models/local-engines' })">{{ s.setup.link }}</a>{{ s.setup.after }}</p>

    <section class="walkthrough-step" aria-labelledby="groups-model">
      <h2 id="groups-model">{{ s.steps.model.title }}</h2>
      <p><UiText :text="s.steps.model.body" /></p>
      <figure class="guide-figure">
        <GroupSettingsStep stage="model" :copy="s.settingsDemo" />
        <figcaption class="caption"><UiText :text="s.steps.model.caption" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="groups-prompt">
      <h2 id="groups-prompt">{{ s.steps.prompt.title }}</h2>
      <p><UiText :text="s.steps.prompt.body" /></p>
      <figure class="guide-figure">
        <GroupSettingsStep stage="prompt" :copy="s.settingsDemo" />
        <figcaption class="caption"><UiText :text="s.steps.prompt.caption" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="groups-move">
      <h2 id="groups-move">{{ s.steps.move.title }}</h2>
      <p><UiText :text="s.steps.move.body" /></p>
      <figure class="guide-figure">
        <GroupStep stage="move" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.move.caption" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="groups-add">
      <h2 id="groups-add">{{ s.steps.add.title }}</h2>
      <p><UiText :text="s.steps.add.body" /></p>
      <figure class="guide-figure">
        <GroupStep stage="add" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.add.caption" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="groups-tidy">
      <h2 id="groups-tidy">{{ s.steps.tidy.title }}</h2>
      <p><UiText :text="s.steps.tidy.body" /></p>
      <figure class="guide-figure">
        <GroupStep stage="tidy" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.tidy.caption" /></figcaption>
      </figure>
    </section>

    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[{ page: 'settings/inheritance', title: s.related, description: s.nextDescription }]" />
  </article>
</template>

<style scoped>
.prerequisite { margin:36px 0 0;padding:16px 19px;border-left:3px solid var(--blue);border-radius:0 10px 10px 0;background:var(--surface); }
.walkthrough-step { border-top:1px solid var(--line);margin-top:38px;padding-top:22px; }
.prerequisite + .walkthrough-step { margin-top:18px; }
.walkthrough-step h2 { margin-top:0; }
.walkthrough-step > p { margin-bottom:0; }
.walkthrough-step .guide-figure { margin:18px 0 0; }
</style>
