/**
 * Safely scrolls an element into view within a specific container without triggering
 * browser-level window scrolling. This prevents layout shifts like "black bars"
 * that can occur when using the native element.scrollIntoView().
 */
export function scrollIntoViewSafe({
  container,
  element,
  block = 'start',
  behavior = 'smooth',
  offset = 0
}: {
  container: HTMLElement;
  element: HTMLElement;
  block?: 'start' | 'center' | 'end' | 'nearest';
  behavior?: 'smooth' | 'auto' | 'instant';
  offset?: number;
}) {
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();

  let targetScrollTop = container.scrollTop;

  switch (block) {
  case 'start':
    targetScrollTop += (elementRect.top - containerRect.top) - offset;
    break;
  case 'center':
    targetScrollTop += (elementRect.top - containerRect.top) - (containerRect.height / 2) + (elementRect.height / 2);
    break;
  case 'end':
    targetScrollTop += (elementRect.bottom - containerRect.bottom);
    break;
  case 'nearest':
    if (elementRect.top < containerRect.top) {
      targetScrollTop += (elementRect.top - containerRect.top);
    } else if (elementRect.bottom > containerRect.bottom) {
      targetScrollTop += (elementRect.bottom - containerRect.bottom);
    }
    break;
  default: {
    const _ex: never = block;
    return _ex;
  }
  }

  container.scrollTo({
    top: targetScrollTop,
    behavior: (() => {
      switch (behavior) {
      case 'smooth': return 'smooth';
      case 'auto': return 'auto';
      case 'instant': return 'auto';
      default: {
        const _ex: never = behavior;
        return _ex;
      }
      }
    })()
  });
}
