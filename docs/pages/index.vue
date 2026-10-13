<script setup lang="ts">
import BrowserMock from '../site/BrowserMock.vue';
import BoundaryDiagram from '../site/demos/BoundaryDiagram.vue';
import StandaloneDemo from '../site/demos/StandaloneDemo.vue';
import StorageChoiceDemo from '../site/demos/StorageChoiceDemo.vue';
import type { HomeMessages, CommonMessages } from '../site/messages';
import { docsHref } from '../site/routes';
import type { DocsLocale } from '../site/routes';

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
        <h1 id="home-title"><span>{{ s.headline[0] }}</span><span class="accent">{{ s.headline[1] }}</span></h1>
        <p
          v-for="(paragraph, index) in s.intro"
          :key="paragraph"
          class="hero-lead"
        ><strong v-if="index === 1">{{ paragraph }}</strong><template v-else>{{ paragraph }}</template></p>
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
              <p>{{ item.body }}</p>
            </div>
          </section>
        </div>
      </div>
      <p class="boundary-footnote">{{ s.boundaryNote }}</p>
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
      <a class="next-link" :href="docsHref({ locale, page: 'run/standalone' })">{{ s.standaloneLink }} <span aria-hidden="true">→</span></a>
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
          class="article-card card-feature"
          :href="docsHref({ locale, page: 'files/privacy' })"
        ><span class="card-top"><span class="card-icon"><svg
           class="icon lg"
           aria-hidden="true"
         >
           <use href="#i-folder" />
         </svg></span><span aria-hidden="true">→</span></span>
          <h3 class="card-title">{{ s.guides.files.title }}</h3>
          <p class="card-desc">{{ s.guides.files.body }}</p>
        </a>
        <a
          class="article-card"
          :href="docsHref({ locale, page: 'work/boundary' })"
        ><span class="card-top"><span class="card-icon"><svg
           class="icon lg"
           aria-hidden="true"
         >
           <use href="#i-shield" />
         </svg></span><span aria-hidden="true">→</span></span>
          <h3 class="card-title">{{ s.guides.boundary.title }}</h3>
          <p class="card-desc">{{ s.guides.boundary.body }}</p>
        </a>
        <a
          class="article-card"
          :href="docsHref({ locale, page: 'chat/branching' })"
        ><span class="card-top"><span class="card-icon"><svg
           class="icon lg"
           aria-hidden="true"
         >
           <use href="#i-branch" />
         </svg></span><span aria-hidden="true">→</span></span>
          <h3 class="card-title">{{ s.guides.branching.title }}</h3>
          <p class="card-desc">{{ s.guides.branching.body }}</p>
        </a>
        <a
          class="article-card"
          :href="docsHref({ locale, page: 'work/browser-shell' })"
        ><span class="card-top"><span class="card-icon"><svg
           class="icon lg"
           aria-hidden="true"
         >
           <use href="#i-terminal" />
         </svg></span><span aria-hidden="true">→</span></span>
          <h3 class="card-title">{{ s.guides.shell.title }}</h3>
          <p class="card-desc">{{ s.guides.shell.body }}</p>
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
  font-size: clamp(32px, 3.75vw, 56px);
  line-height: 1.45;
  letter-spacing: -.06em;
  margin-top: 0;
  overflow-wrap: anywhere;
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

.home-mock {
  margin: 0;
  min-width: 0;
}

.models-section {
  margin-top: 64px;
}

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
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.card-feature {
  grid-column: auto;
}

@media(max-width:900px) {
  .hero {
    grid-template-columns: 1fr;
  }

  .hero h1 {
    font-size: clamp(36px, 6vw, 52px);
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
  .hero {
    padding-top: 45px;
    padding-bottom: 48px;
    gap: 24px;
  }

  .hero h1 {
    font-size: clamp(29px, 7.7vw, 42px);
  }

  .hero-lead {
    font-size: 14px;
  }

  .article-grid {
    grid-template-columns: 1fr;
  }

  .panel {
    padding: 22px;
  }
}
</style>
