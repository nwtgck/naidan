<script setup lang="ts">
import { GithubIcon } from 'lucide-vue-next';
import logo from '../assets/naidan.svg';
import AppEntryLink from '../site/AppEntryLink.vue';
import BrowserMock from '../site/BrowserMock.vue';
import ExternalLink from '../site/ExternalLink.vue';
import BoundaryDiagram from '../site/demos/BoundaryDiagram.vue';
import StandaloneDemo from '../site/demos/StandaloneDemo.vue';
import StorageChoiceDemo from '../site/demos/StorageChoiceDemo.vue';
import type { HomeMessages, CommonMessages } from '../site/messages';
import { docsHref } from '../site/routes';
import type { DocsLocale, DocsPageId } from '../site/routes';

const guideCards = [
  { key: 'gguf', page: 'models/llama-cpp-browser', icon: '#i-model' },
  { key: 'image', page: 'images/create', icon: '#i-image' },
  { key: 'audio', page: 'audio/speech', icon: '#i-audio' },
  { key: 'branching', page: 'chat/branching', icon: '#i-branch' },
  { key: 'shell', page: 'work/browser-shell', icon: '#i-terminal' },
  { key: 'groups', page: 'chat/groups', icon: '#i-grid' },
  { key: 'wikipedia', page: 'work/wikipedia', icon: '#i-search' },
  { key: 'offline', page: 'run/offline', icon: '#i-download' },
] as const satisfies readonly { key: keyof HomeMessages['guides']; page: DocsPageId; icon: string }[];

defineProps<{ s: HomeMessages; locale: DocsLocale; common: CommonMessages }>();


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
  <section
    class="hero-area"
    aria-labelledby="home-title"
    data-testid="docs-hero"
  >
    <div class="wrap hero">
      <div class="hero-copy">
        <div class="hero-brand" data-docs-hero-brand aria-hidden="true">
          <img :src="logo" width="130" height="130" alt="">
          <span class="brand-wordmark">Naidan</span>
        </div>
        <h1 id="home-title"><span>{{ s.headline[0] }}</span><span class="accent">{{ s.headline[1] }}</span></h1>
        <p
          v-for="(paragraph, index) in s.intro"
          :key="paragraph"
          class="hero-lead"
        ><strong v-if="index === 1">{{ paragraph }}</strong><template v-else>{{ paragraph }}</template></p>
        <div class="hero-actions">
          <AppEntryLink
            class="btn btn-primary hero-action"
            :destination="{ kind: 'screen', screen: 'home' }"
            :locale="locale"
            display="label"
            data-testid="docs-hero-launch"
          >{{ common.launch }}<svg class="icon sm" aria-hidden="true"><use href="#i-arrow" /></svg></AppEntryLink>
          <ExternalLink
            class="btn btn-secondary hero-action"
            href="https://github.com/nwtgck/naidan"
            :locale="locale"
            data-testid="docs-hero-source"
          ><GithubIcon class="icon sm" aria-hidden="true" />{{ common.source }}</ExternalLink>
        </div>
      </div>
      <figure class="home-mock">
        <BrowserMock :copy="s.demo" :chrome="common.chrome" />
      </figure>
    </div>
  </section>
  <section
    class="mechanism-section"
    aria-labelledby="how-title"
    data-testid="docs-how"
  >
    <div class="wrap">
      <div class="how-heading-row">
        <h2
          id="how-title"
          class="section-title"
        >{{ s.howTitle }}</h2>
        <p class="section-description">{{ s.howLead }}</p>
      </div>
      <div class="how-grid">
        <BoundaryDiagram :copy="s.boundary" />
        <div class="mechanism-list">
          <section
            v-for="(item, index) in s.mechanisms"
            :key="item.title"
            class="mechanism-item"
          ><span
             class="mechanism-index"
             aria-hidden="true"
           >0{{ index + 1 }}</span>
            <div>
              <h3>{{ item.title }}</h3>
              <p>{{ item.body }} <a
                v-if="index === 2"
                class="mechanism-detail-link"
                data-testid="docs-local-only-guide"
                :href="docsHref({ locale, page: 'work/local-only' })"
              >{{ s.localOnlyLink }}</a></p>
            </div>
          </section>
        </div>
      </div>
      <p class="boundary-footnote">{{ s.boundaryNote }}</p>
      <a
        class="home-guide-entry"
        data-testid="docs-app-permissions-guide"
        :href="docsHref({ locale, page: 'work/app-permissions' })"
      >
        <span class="home-guide-copy">
          <strong>{{ s.appPermissionsLink }}</strong>
          <span>{{ s.appPermissionsDescription }}</span>
        </span>
        <span class="home-guide-arrow" aria-hidden="true">→</span>
      </a>
      <div class="models-section">
        <h2 class="section-title">{{ s.modelsTitle }}</h2>
        <div class="pair-grid">
          <a
            v-for="(model, index) in s.models"
            :key="model.title"
            :href="docsHref({ locale, page: index === 0 ? 'models/in-browser' : 'models/local-engines' })"
            class="model-card panel"
            data-testid="docs-model-guide"
          >
            <h3><span>{{ model.title }}</span><span aria-hidden="true">→</span></h3>
            <p>{{ model.body }}</p>
          </a>
        </div>
      </div>
    </div>
  </section>
  <section class="standalone-section wrap" aria-labelledby="standalone-title" data-testid="docs-home-standalone">
    <div><h2 id="standalone-title" class="section-title">{{ s.standalone.title }}</h2><p>{{ s.standalone.body }}</p>
      <a
        class="home-guide-entry"
        data-testid="docs-standalone-guide"
        :href="docsHref({ locale, page: 'run/standalone' })"
      >
        <span class="home-guide-copy">
          <strong>{{ s.standaloneLink }}</strong>
          <span>{{ s.standaloneDescription }}</span>
        </span>
        <span class="home-guide-arrow" aria-hidden="true">→</span>
      </a>
    </div>
    <figure class="standalone-preview"><StandaloneDemo :copy="s.standaloneDemo" /></figure>
  </section>
  <section
    class="storage-section"
    aria-labelledby="storage-title"
    data-testid="docs-storage"
  >
    <div class="wrap storage-layout">
      <div class="storage-copy">
        <h2
          id="storage-title"
          class="section-title"
        >{{ s.storageTitle }}</h2>
        <p class="section-description">{{ s.storageLead }}</p>
        <div class="storage-explanation"><section v-for="item in s.storage" :key="item.title"><h3>{{ item.title }}</h3><p>{{ item.body }}</p></section></div>
        <p class="storage-detail-hint">{{ s.storageNote }}</p>
      </div>
      <figure class="storage-preview"><StorageChoiceDemo :copy="s.storageDemo" /><figcaption class="caption">{{ s.storageCaption }}</figcaption></figure>
    </div>
  </section>
  <section
    id="guides"
    class="section"
    aria-labelledby="guides-title"
    data-testid="docs-guides"
  >
    <div class="wrap">
      <div class="section-top">
        <div>
          <h2
            id="guides-title"
            class="section-title"
          >{{ s.guidesTitle }}</h2>
          <p class="section-description">{{ s.guidesLead }}</p>
        </div>
      </div>
      <div class="article-grid">
        <a
          v-for="guide in guideCards"
          :key="guide.page"
          class="article-card"
          data-testid="docs-home-guide-card"
          :href="docsHref({ locale, page: guide.page })"
        >
          <span class="card-top"><span class="card-icon"><svg class="icon lg" aria-hidden="true"><use :href="guide.icon" /></svg></span><span class="card-arrow" aria-hidden="true">→</span></span>
          <h3 class="card-title">{{ s.guides[guide.key].title }}</h3>
          <p class="card-desc">{{ s.guides[guide.key].body }}</p>
        </a>
      </div>
    </div>
  </section>
</template>

<style scoped>
.standalone-section { display: grid; grid-template-columns: minmax(0, .85fr) minmax(0, 1.15fr); gap: 32px; align-items: center; padding-block: 52px; }
.standalone-section p { color: var(--muted); max-width: 760px; line-height: 1.95; }
.standalone-preview { margin: 0; min-width: 0; }
.storage-preview { margin: 0; min-width: 0; }
.storage-preview figcaption { margin-top: 10px; font-size: 11px; }
.storage-layout { gap: 36px; align-items: start; }
.storage-explanation section { margin-top: 20px; }
.storage-explanation h3 { margin: 0 0 6px; font-size: 14px; line-height: 1.6; }
.storage-explanation p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.85; }
@media(max-width:900px) { .standalone-section { grid-template-columns: minmax(0, 1fr); gap: 22px; } .standalone-preview { max-width: 680px; } }
@media(max-width:620px) { .standalone-section { padding-block: 40px; } }

.hero {
  min-height: 0;
  gap: 45px;
  padding-top: 70px;
  padding-bottom: 76px;
}

.hero h1 {
  font-size: clamp(24px, 2.25vw, 34px);
  line-height: 1.45;
  letter-spacing: -.045em;
  margin-top: 0;
  margin-bottom: 24px;
  overflow-wrap: anywhere;
}

.hero-brand {
  display: inline-flex;
  align-items: center;
  gap: 14px;
  max-width: 100%;
  margin-bottom: 28px;
  margin-inline-start: -20px;
  white-space: nowrap;
  font-size: 75px;
}

.hero-brand img {
  display: block;
  width: 130px;
  height: auto;
  aspect-ratio: 1;
  flex: none;
}

.hero h1 span {
  display: block;
}

.hero h1 .accent {
  white-space: normal;
}

.hero-lead {
  font-size: 15px;
  margin-bottom: 19px;
  line-height: 2;
}

.hero-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
.hero-action { max-width: 100%; min-width: 0; height: auto; padding-block: 12px; text-align: center; line-height: 1.4; overflow-wrap: anywhere; }
.hero-action.btn-secondary { font-weight: 700; }

.home-mock {
  margin: 0;
  min-width: 0;
}

.models-section {
  margin-top: 64px;
}

.mechanism-detail-link { color: var(--blue); text-underline-offset: .16em; }
.mechanism-detail-link:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }

.home-guide-entry {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  width: min(100%, 520px);
  min-width: 0;
  margin-top: 18px;
  padding: 14px 17px;
  border: 1px solid var(--line-strong);
  border-radius: 13px;
  background: var(--surface);
  color: var(--text);
  text-decoration: none;
  transition: border-color .18s ease, background-color .18s ease, box-shadow .18s ease;
}
.home-guide-copy { display: grid; gap: 4px; min-width: 0; overflow-wrap: anywhere; }
.home-guide-copy strong { font-size: 14px; font-weight: 750; line-height: 1.5; }
.home-guide-copy > span { color: var(--muted); font-size: 12px; line-height: 1.65; }
.home-guide-arrow { color: var(--blue); font-size: 21px; line-height: 1; transition: transform .18s ease; }
.home-guide-entry:hover { border-color: var(--blue); background: var(--surface-2); box-shadow: var(--panel-shadow); }
.home-guide-entry:hover .home-guide-arrow, .home-guide-entry:focus-visible .home-guide-arrow { transform: translateX(3px); }
.home-guide-entry:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) { .home-guide-entry, .home-guide-arrow { transition: none; } }

.models-section h2 {
  margin-bottom: 27px;
}

.model-card { display: block; min-width: 0; color: var(--text); text-decoration: none; }
.model-card h3 { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; line-height: 1.6; }
.model-card h3 > span:first-child { min-width: 0; }
.model-card h3 > span:last-child { color: var(--blue); }
.model-card:hover { border-color: var(--blue); }
.model-card:focus-visible { outline: 2px solid var(--blue); outline-offset: 4px; }

.panel p {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.95;
}

.article-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  grid-auto-rows: 1fr;
}

.article-grid .article-card {
  min-height: 172px;
  padding: 19px;
}

.article-grid .card-icon { width: 36px; height: 36px; border-radius: 10px; }
.article-grid .card-title { margin-top: 15px; font-size: 15px; }
.article-grid .card-desc { max-width: none; font-size: 12px; line-height: 1.7; }

@media(max-width:900px) {
  .article-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .hero-brand { gap: 11.4px; margin-inline-start: -17px; font-size: 62.5px; }
  .hero-brand img { width: 108px; }

  .hero {
    grid-template-columns: 1fr;
  }

  .hero h1 {
    font-size: clamp(25px, 3.6vw, 32px);
    max-width: 720px;
  }

  .hero-lead {
    max-width: 680px;
  }

  .home-mock {
    max-width: 570px;
    width: 100%;
    margin-inline: auto;
  }
}

@media(max-width:620px) {
  .hero-brand { margin-inline-start: -15px; font-size: 54.2px; }
  .hero-brand img { width: 97px; }

  .hero {
    padding-top: 45px;
    padding-bottom: 48px;
    gap: 24px;
  }

  .hero h1 {
    font-size: clamp(22px, 5.3vw, 29px);
  }

  .hero-brand {
    margin-bottom: 22px;
  }

  .hero-lead {
    font-size: 14px;
  }

  .article-grid {
    grid-template-columns: 1fr;
  }

  .article-grid .article-card { min-height: 150px; }

  .panel {
    padding: 22px;
  }
}

@media(max-width:480px) {
  .hero-brand { gap: 9px; margin-inline-start: -13.5px; font-size: 48px; }
  .hero-brand img { width: 86px; }
}

@media(max-width:350px) {
  .hero-brand { gap: 7px; margin-inline-start: -11px; font-size: 42px; }
  .hero-brand img { width: 70px; }
}
</style>
