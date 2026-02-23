import { vi } from 'vitest';

/**
 * Mocks the 'scrollTo' method on HTMLElement prototype.
 * Useful for tests running in Happy DOM / jsdom environments where it's missing.
 */
export function setupScrollToMock() {
  if (typeof window !== 'undefined') {
    const mockScrollTo = function(this: HTMLElement | Element | Window, options?: number | ScrollToOptions, _left?: number) {
      if (typeof options === 'object' && options !== null) {
        const scrollToOptions = options as ScrollToOptions;
        if (this instanceof HTMLElement || this instanceof Element) {
          this.scrollTop = scrollToOptions.top || 0;
          this.scrollLeft = scrollToOptions.left || 0;
        }
      } else {
        if (this instanceof HTMLElement || this instanceof Element) {
          this.scrollTop = (options as number) || 0;
          this.scrollLeft = _left || 0;
        }
      }
    };

    if (!window.scrollTo) window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    if (!window.HTMLElement.prototype.scrollTo) {
      window.HTMLElement.prototype.scrollTo = mockScrollTo as unknown as typeof window.HTMLElement.prototype.scrollTo;
    }
    if (!Element.prototype.scrollTo) {
      Element.prototype.scrollTo = mockScrollTo as unknown as typeof Element.prototype.scrollTo;
    }
  }
}

/**
 * Mocks 'getComputedStyle' if it's missing or on a specific window-like object.
 */
export function setupGetComputedStyleMock() {
  if (typeof window !== 'undefined' && !window.getComputedStyle) {
    (window as unknown as { getComputedStyle: unknown }).getComputedStyle = vi.fn().mockReturnValue({
      paddingLeft: '0px',
      paddingRight: '0px',
      font: '14px sans-serif',
      lineHeight: '20px',
      getPropertyValue: vi.fn().mockReturnValue(''),
    });
  }
}
