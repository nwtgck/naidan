/** Image dialogs have editable controls as well as buttons. Keep focus inside
 * the visible dialog without stealing keys from another (teleported) dialog. */
export function trapImageDialogFocus({ root, event }: { root: HTMLElement | undefined, event: KeyboardEvent }): void {
  if (!root || event.key !== 'Tab' || event.defaultPrevented) return;
  const controls = Array.from(root.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex], [contenteditable]'))
    .filter(control => {
      if (control.tabIndex < 0 || control.matches(':disabled') || control.closest('[inert]')) return false;
      for (let current: HTMLElement | undefined = control; current && current !== root; current = current.parentElement ?? undefined) {
        if (current.hidden || getComputedStyle(current).display === 'none' || getComputedStyle(current).visibility === 'hidden') return false;
        if (current.parentElement instanceof HTMLDetailsElement && !current.parentElement.open && current.tagName !== 'SUMMARY') return false;
      }
      return true;
    });
  const first = controls[0], last = controls.at(-1);
  if (!first || !last) {
    event.preventDefault(); root.focus(); return;
  }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root)) {
    event.preventDefault(); first.focus();
  }
}
export const TEST_ONLY = {
};
