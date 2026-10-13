<script setup lang="ts">
import BrowserMock from '../site/BrowserMock.vue';
import BoundaryDiagram from '../site/demos/BoundaryDiagram.vue';
import type { HomeMessages } from '../site/messages';
import { docsHref } from '../site/routes';
import type { DocsLocale } from '../site/routes';

defineProps<{ s: HomeMessages; locale: DocsLocale }>();


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
        <BrowserMock />
        <figcaption class="caption">{{ s.mock }}</figcaption>
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
        <BoundaryDiagram />
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
          <section
            v-for="model in s.models"
            :key="model.title"
            class="panel"
          >
            <h3>{{ model.title }}</h3>
            <p>{{ model.body }}</p>
          </section>
        </div>
      </div>
    </div>
  </section>
  <section class="standalone-section wrap" data-testid="docs-home-standalone">
    <div class="local-file-badge" aria-hidden="true"><span>index.html</span><code>file://</code></div>
    <div><h2 class="section-title">{{ s.standalone.title }}</h2><p>{{ s.standalone.body }}</p>
      <a class="next-link" :href="docsHref({ locale, page: 'run/standalone' })">{{ s.standaloneLink }} <span aria-hidden="true">→</span></a>
    </div>
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
        <p class="storage-detail-hint">{{ s.storageNote }}</p>
      </div>
      <div class="storage-options">
        <section
          v-for="(item, index) in s.storage"
          :key="item.title"
          class="storage-option-card panel"
        ><span class="storage-state">{{ index === 0 ? 'OPFS' : 'Memory' }}</span>
          <h3>{{ item.title }}</h3>
          <p>{{ item.body }}</p>
        </section>
      </div>
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
.standalone-section { display: grid; grid-template-columns: 160px 1fr; gap: 36px; align-items: center; padding-block: 64px; }
.standalone-section p { color: var(--muted); max-width: 760px; line-height: 1.95; }
.local-file-badge { border: 1px solid var(--line-strong); border-radius: 22px; aspect-ratio: 1; display: grid; place-content: center; gap: 15px; text-align: center; background: linear-gradient(145deg,var(--surface),var(--bg)); }
.local-file-badge span { font-size: 13px; color: var(--muted); }
.local-file-badge code { color: var(--blue); font-size: 28px; }
@media(max-width:620px) { .standalone-section { grid-template-columns: 1fr; gap: 20px; padding-block: 40px; } .local-file-badge { aspect-ratio: auto; display:flex; align-items:center; padding:18px; justify-content:space-between; } }

.hero {
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

.home-mock figcaption {
  margin-top: 19px;
  font-size: 10px;
}

.models-section {
  margin-top: 64px;
}

.models-section h2 {
  margin-bottom: 27px;
}

.panel p {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.95;
}

.storage-options {
  display: grid;
  gap: 17px;
}

.storage-option-card h3 {
  margin-top: 12px;
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
