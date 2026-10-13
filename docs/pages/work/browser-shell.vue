<script setup lang="ts">
import ShellWorkspaceDemo from '../../site/demos/ShellWorkspaceDemo.vue';
import { docsHref } from '../../site/routes';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages, ShellMessages } from '../../site/messages';

defineProps<{ s: ShellMessages; locale: DocsLocale; common: CommonMessages }>();
const example = `\
ls /sys/fs/naidan/current-chat
cat /sys/fs/naidan/current-chat/metadata.md`;


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
    <figure class="guide-figure"><ShellWorkspaceDemo :copy="s.demo" :chrome="common.chrome" /><figcaption class="caption">{{ s.diagramCaption }}</figcaption></figure>
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
    <h2>{{ s.stepsTitle }}</h2><ol class="guide-steps"><li v-for="step in s.steps" :key="step">{{ step }}</li></ol>
    <h2>{{ s.exampleTitle }}</h2><pre lang="en"><code>{{ example }}</code></pre>
    <p class="caption">{{ s.exampleNote }}</p>
    <a
      class="next-link"
      :href="docsHref({ locale, page: 'files/privacy' })"
    >{{ s.next }} <span aria-hidden="true">→</span></a>
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
</style>
