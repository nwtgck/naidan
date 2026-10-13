import { homeBrandTransform } from './home-brand-geometry';
import type { HomeBrandGeometry } from './home-brand-geometry';

export function startHomeBrandMotion({ document, window }: { document: Document; window: Window }): void {
  const hero = document.querySelector<HTMLElement>('[data-docs-hero-brand]');
  const slot = document.querySelector<HTMLElement>('[data-docs-brand-slot]');
  const link = document.querySelector<HTMLAnchorElement>('[data-docs-brand-link]');
  const pause = document.querySelector<HTMLInputElement>('#docs-pause-motion');
  if (!hero || !slot || !link || !pause) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const narrow = window.matchMedia('(max-width: 480px)');
  let geometry: HomeBrandGeometry | undefined;
  let frame = 0;
  let needsMeasure = true;

  function measure(): HomeBrandGeometry | undefined {
    if (!hero || !slot || !link) return undefined;
    const source = hero.getBoundingClientRect();
    const target = slot.getBoundingClientRect();
    const targetWidth = link.offsetWidth;
    if (source.width <= 0 || targetWidth <= 0) return undefined;
    return {
      sourceLeft: source.left,
      sourceTop: source.top + window.scrollY,
      sourceWidth: source.width,
      targetLeft: target.left,
      targetTop: target.top + (target.height - link.offsetHeight) / 2,
      targetWidth,
    };
  }

  function render(): void {
    frame = 0;
    if (!link || !slot || !pause) return;
    if (needsMeasure) {
      geometry = measure();
      needsMeasure = false;
    }
    if (reduced.matches || narrow.matches || pause.checked || !geometry) {
      document.documentElement.removeAttribute('data-docs-home-brand-motion');
      link.style.removeProperty('transform');
      link.style.removeProperty('transform-origin');
      slot.style.removeProperty('--docs-brand-progress');
      return;
    }
    const { x, y, scale, progress } = homeBrandTransform({ geometry, scrollY: window.scrollY });
    link.style.transformOrigin = 'top left';
    link.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    slot.style.setProperty('--docs-brand-progress', String(progress));
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
