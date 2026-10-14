<script setup lang="ts">
import DocsLink from '../../site/DocsLink.vue';
import AppEntryLink from '../../site/AppEntryLink.vue';
import ShellWorkspaceDemo from '../../site/demos/ShellWorkspaceDemo.vue';
import ShellEnableStep from '../../site/demos/ShellEnableStep.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import UiText from '../../site/UiText.vue';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages, ShellMessages } from '../../site/messages';

defineProps<{ s: ShellMessages; locale: DocsLocale; common: CommonMessages }>();


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
  <article
    class="prose"
    data-testid="docs-shell"
  >
    <h1>{{ s.title }}</h1>
    <p
      v-for="paragraph in s.intro"
      :key="paragraph"
      class="lead"
    >{{ paragraph }}</p>
    <p class="app-entry-intro">{{ s.launch.before }}<AppEntryLink :destination="{ kind: 'screen', screen: 'home' }" :locale="locale" display="path" />{{ s.launch.after }}</p>
    <figure class="guide-figure"><ShellWorkspaceDemo :copy="s.demo" :chrome="common.chrome" /><figcaption class="caption">{{ s.diagramCaption }}</figcaption></figure>
    <section class="shell-walkthrough" data-testid="docs-shell-walkthrough">
      <h2>{{ s.walkthrough.title }}</h2>
      <section class="shell-walkthrough-step">
        <h3>{{ s.walkthrough.open.title }}</h3>
        <p><UiText :text="s.walkthrough.open.body" /></p>
        <figure class="guide-figure"><ShellEnableStep stage="open" :copy="s.walkthrough.demo" /><figcaption class="caption"><UiText :text="s.walkthrough.open.caption" /></figcaption></figure>
      </section>
      <section class="shell-walkthrough-step">
        <h3>{{ s.walkthrough.enable.title }}</h3>
        <p><UiText :text="s.walkthrough.enable.body" /></p>
        <figure class="guide-figure"><ShellEnableStep stage="enable" :copy="s.walkthrough.demo" /><figcaption class="caption"><UiText :text="s.walkthrough.enable.caption" /></figcaption></figure>
        <p><UiText :text="s.walkthrough.enable.sysfs.before" /><DocsLink :locale="locale" page="wesh-sysfs">{{ s.walkthrough.enable.sysfs.link }}</DocsLink><UiText :text="s.walkthrough.enable.sysfs.after" /></p>
      </section>
      <p><UiText :text="s.walkthrough.use.before" /><DocsLink :locale="locale" page="file-access">{{ s.walkthrough.use.filesLink }}</DocsLink><UiText :text="s.walkthrough.use.after" /></p>
    </section>
    <section
      v-for="section in s.sections"
      :key="section.title"
    >
      <h2>{{ section.title }}</h2>
      <p>{{ section.body }}</p>
    </section>
    <section>
      <h2>{{ s.commandsTitle }}</h2>
      <p>{{ s.commandsIntro }}</p>
      <ul class="shell-command-list" data-testid="docs-shell-command-list">
        <li v-for="group in s.commands" :key="group.title">
          <strong>{{ group.title }}</strong>
          <span class="shell-command-names"><code v-for="name in group.names" :key="name">{{ name }}</code></span>
          <p>{{ group.body }}</p>
        </li>
      </ul>
      <p class="caption">{{ s.commandsHelp }} <code>help</code> · <code>help grep</code> · <code>grep --help</code></p>
    </section>
    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[
      { page: 'file-access', title: s.next, description: s.nextDescription },
      { page: 'tool-wikipedia', title: s.relatedWikipedia.title, description: s.relatedWikipedia.description },
    ]" />
  </article>
</template>

<style scoped>
.shell-command-list {
  padding-left: 1.3em;
}
.shell-command-list li {
  min-width: 0;
  margin-block: 18px;
  overflow-wrap: anywhere;
}
.shell-command-names {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 12px;
  margin-top: 4px;
}
.shell-command-names code {
  font-size: .85em;
  overflow-wrap: anywhere;
}
.shell-command-list p {
  margin: 4px 0 0;
}
.shell-walkthrough {
  margin-block: 35px 45px;
}
.shell-walkthrough-step {
  margin-top: 25px;
}
.shell-walkthrough-step .guide-figure {
  margin-top: 16px;
}
</style>
