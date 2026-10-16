import { homeBrandFrame } from './home-brand-geometry';
import type { HomeBrandGeometry } from './home-brand-geometry';

export function startHomeBrandMotion({ document, window }: { document: Document; window: Window }): void {
  const startup = document.documentElement.dataset.docsHomeBrandStartup;
  if (startup !== 'pending' && startup !== 'ready') return;
  const hero = document.querySelector<HTMLElement>('[data-docs-hero-brand]');
  const slot = document.querySelector<HTMLElement>('[data-docs-brand-slot]');
  const link = document.querySelector<HTMLAnchorElement>('[data-docs-brand-link]');
  const spacer = document.querySelector<HTMLElement>('[data-docs-brand-spacer]');
  const header = slot?.closest<HTMLElement>('.topbar');
  const headerInner = header?.querySelector<HTMLElement>('.topbar-inner');
  const guideTrigger = header?.querySelector<HTMLElement>('.docs-guide-trigger');
  const heroMark = hero?.querySelector<HTMLImageElement>('img');
  const heroWordmark = hero?.querySelector<HTMLElement>('.brand-wordmark');
  const mark = link?.querySelector<HTMLImageElement>('img');
  const wordmark = link?.querySelector<HTMLElement>('.brand-wordmark');
  const pause = document.querySelector<HTMLInputElement>('#docs-pause-motion');
  if (!hero || !slot || !link || !spacer || !heroMark || !heroWordmark || !mark || !wordmark || !pause) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const narrow = window.matchMedia('(max-width: 480px)');
  let geometry: HomeBrandGeometry | undefined;
  let leadingOffset = 0;
  let frame = 0;
  let needsMeasure = true;

  function restore(): void {
    if (!slot || !link || !spacer || !mark || !wordmark) return;
    if (document.documentElement.dataset.docsHomeBrandStartup === 'pending') document.documentElement.dataset.docsHomeBrandStartup = 'ready';
    document.documentElement.removeAttribute('data-docs-home-brand-motion');
    document.documentElement.removeAttribute('data-docs-home-brand-resting');
    link.style.removeProperty('left');
    link.style.removeProperty('top');
    link.style.removeProperty('gap');
    mark.style.removeProperty('width');
    mark.style.removeProperty('height');
    wordmark.style.removeProperty('font-size');
    spacer.style.removeProperty('width');
    spacer.style.removeProperty('height');
    slot.style.removeProperty('--docs-brand-progress');
    header?.style.removeProperty('--docs-home-leading-shift');
  }

  function measure(): HomeBrandGeometry | undefined {
    if (!hero || !link || !heroMark || !heroWordmark || !mark || !wordmark) return undefined;
    const source = hero.getBoundingClientRect();
    const target = link.getBoundingClientRect();
    const sourceMark = heroMark.getBoundingClientRect();
    const targetMark = mark.getBoundingClientRect();
    const sourceFontSize = Number.parseFloat(window.getComputedStyle(heroWordmark).fontSize);
    const targetFontSize = Number.parseFloat(window.getComputedStyle(wordmark).fontSize);
    const sourceGap = Number.parseFloat(window.getComputedStyle(hero).columnGap);
    const targetGap = Number.parseFloat(window.getComputedStyle(link).columnGap);
    if (source.width <= 0 || target.width <= 0 || target.height <= 0
      || sourceMark.width <= 0 || sourceMark.height <= 0 || targetMark.width <= 0 || targetMark.height <= 0
      || ![sourceFontSize, targetFontSize, sourceGap, targetGap].every(Number.isFinite)) return undefined;
    return {
      sourceLeft: source.left,
      sourceTop: source.top + window.scrollY,
      targetLeft: target.left,
      targetTop: target.top,
      targetWidth: target.width,
      targetHeight: target.height,
      sourceMarkWidth: sourceMark.width,
      sourceMarkHeight: sourceMark.height,
      sourceFontSize,
      sourceGap,
      targetMarkWidth: targetMark.width,
      targetMarkHeight: targetMark.height,
      targetFontSize,
      targetGap,
    };
  }

  function render(): void {
    frame = 0;
    if (document.documentElement.dataset.docsHomeBrandStartup === 'aborted') return;
    if (!link || !slot || !spacer || !mark || !wordmark || !pause) return;
    if (reduced.matches || narrow.matches || pause.checked) {
      restore();
      geometry = undefined;
      needsMeasure = true;
      return;
    }
    if (needsMeasure) {
      restore();
      geometry = measure();
      const headerPadding = headerInner ? Number.parseFloat(window.getComputedStyle(headerInner).paddingLeft) : NaN;
      leadingOffset = headerInner && guideTrigger && Number.isFinite(headerPadding)
        ? Math.max(0, guideTrigger.getBoundingClientRect().left - headerInner.getBoundingClientRect().left - headerPadding)
        : 0;
      needsMeasure = !geometry;
    }
    if (!geometry) return;
    const { x, y, markWidth, markHeight, fontSize, gap, progress } = homeBrandFrame({ geometry, scrollY: window.scrollY });
    spacer.style.width = `${geometry.targetWidth}px`;
    spacer.style.height = `${geometry.targetHeight}px`;
    // Avoid magnifying the header's small painted surface with scale() in WebKit.
    link.style.left = `${x}px`;
    link.style.top = `${y}px`;
    link.style.gap = `${gap}px`;
    mark.style.width = `${markWidth}px`;
    mark.style.height = `${markHeight}px`;
    wordmark.style.fontSize = `${fontSize}px`;
    slot.style.setProperty('--docs-brand-progress', String(progress));
    header?.style.setProperty('--docs-home-leading-shift', `${-leadingOffset * (1 - progress)}px`);
    document.documentElement.toggleAttribute('data-docs-home-brand-resting', progress === 0);
    document.documentElement.setAttribute('data-docs-home-brand-motion', '');
  }

  function schedule({ remeasure }: { remeasure: boolean }): void {
    needsMeasure ||= remeasure;
    if (frame) return;
    frame = window.requestAnimationFrame(render);
  }

  window.addEventListener('scroll', () => schedule({ remeasure: false }), { passive: true });
  window.addEventListener('resize', () => schedule({ remeasure: true }));
  pause.addEventListener('change', () => schedule({ remeasure: false }));
  reduced.addEventListener('change', () => schedule({ remeasure: false }));
  narrow.addEventListener('change', () => schedule({ remeasure: true }));
  render();
}
