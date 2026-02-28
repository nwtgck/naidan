/**
 * Test utilities for Block Markdown Renderer
 */

/**
 * Normalizes a DOM element's structure into a clean string for robust testing.
 *
 * DESIGN PRINCIPLE: Implicit behavior is evil. All normalization behaviors (like trimming)
 * are explicitly defined in the function signature as default arguments.
 * This ensures the caller can see exactly what the default behavior is and override it as needed.
 */
export function normalizeDom({
  element,
  preserveAttributes = ['src', 'href', 'checked', 'type', 'disabled'],
  preserveClasses = [],
  trimWhitespaceNodes = false,
  whitespaceSensitiveTags = ['pre', 'code'],
}: {
  element: Element;
  preserveAttributes?: string[];
  preserveClasses?: string[];
  trimWhitespaceNodes?: boolean;
  whitespaceSensitiveTags?: string[];
}): string {
  function createCleanNode({ source, parentIsSensitive }: { source: Node, parentIsSensitive: boolean }): Node | null {
    if (source.nodeType === Node.TEXT_NODE) {
      const text = source.textContent || '';
      if (parentIsSensitive) return document.createTextNode(text);
      if (trimWhitespaceNodes && text.trim() === '') return null;
      return document.createTextNode(text);
    }

    if (source.nodeType === Node.ELEMENT_NODE) {
      const el = source as Element;
      const tagName = el.tagName.toLowerCase();
      const cleanEl = document.createElement(tagName);

      const currentIsSensitive = parentIsSensitive || whitespaceSensitiveTags.includes(tagName);

      for (const attrName of preserveAttributes) {
        const val = el.getAttribute(attrName);
        if (val !== null) cleanEl.setAttribute(attrName, val);
      }

      const classesToKeep = Array.from(el.classList).filter(c => preserveClasses.includes(c));
      if (classesToKeep.length > 0) {
        cleanEl.className = classesToKeep.join(' ');
      }

      for (const child of Array.from(source.childNodes)) {
        const cleanChild = createCleanNode({
          source: child,
          parentIsSensitive: currentIsSensitive
        });
        if (cleanChild) cleanEl.appendChild(cleanChild);
      }

      return cleanEl;
    }

    return null;
  }

  const result = createCleanNode({
    source: element,
    parentIsSensitive: false
  });

  return (result as Element)?.outerHTML || '';
}
