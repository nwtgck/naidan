import { z } from 'zod/mini';

const STORAGE_KEY = 'naidan_docs:settings';
const preferencesSchema = z.object({
  theme: z.enum(['dark', 'light']),
  motion: z.enum(['auto', 'paused']),
});
type Preferences = z.infer<typeof preferencesSchema>;

const defaults: Preferences = { theme: 'dark', motion: 'auto' };

function readPreferences({ window }: { window: Window }): Preferences | undefined {
  try {
    // eslint-disable-next-line no-restricted-syntax -- This typed theme/motion module is Docs' only browser persistence owner.
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === null) return undefined;
    const result = preferencesSchema.safeParse(JSON.parse(stored) as unknown);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function writePreferences({ window, preferences }: { window: Window; preferences: Preferences }): 'saved' | 'failed' {
  try {
    // eslint-disable-next-line no-restricted-syntax -- This typed theme/motion module is Docs' only browser persistence owner.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferencesSchema.parse(preferences)));
    return 'saved';
  } catch {
    // Storage can be disabled; the native controls still work for this page.
    return 'failed';
  }
}

export function startDocsPreferences({ document, window }: { document: Document; window: Window }): Preferences['motion'] {
  const initial = readPreferences({ window }) ?? defaults;
  const html = document.documentElement;
  let restoring = false;
  let hasUnsavedChange = false;
  function apply({ preferences, notification }: { preferences: Preferences; notification: 'silent' | 'changed' }): void {
    html.dataset.theme = preferences.theme;
    const theme = document.querySelector<HTMLInputElement>('#docs-light-theme');
    const motion = document.querySelector<HTMLInputElement>('#docs-pause-motion');
    const themeChanged = theme !== null && theme.checked !== (preferences.theme === 'light');
    const motionChanged = motion !== null && motion.checked !== (preferences.motion === 'paused');
    if (theme) theme.checked = preferences.theme === 'light';
    if (motion) motion.checked = preferences.motion === 'paused';
    switch (notification) {
    case 'silent': return;
    case 'changed': {
      restoring = true;
      try {
        if (themeChanged) theme?.dispatchEvent(new Event('change', { bubbles: true }));
        if (motionChanged) motion?.dispatchEvent(new Event('change', { bubbles: true }));
      } finally {
        restoring = false;
      }
      return;
    }
    default: { const unreachable: never = notification; throw new Error(`Unknown notification mode: ${unreachable}`); }
    }
  }
  apply({ preferences: initial, notification: 'silent' });

  let installed = false;
  const observer = new MutationObserver(() => install());
  function install(): void {
    if (installed) return;
    const theme = document.querySelector<HTMLInputElement>('#docs-light-theme');
    const motion = document.querySelector<HTMLInputElement>('#docs-pause-motion');
    if (!theme || !motion) return;
    installed = true;
    observer.disconnect();
    apply({ preferences: initial, notification: 'silent' });
    const save = (): void => {
      if (restoring) return;
      const preferences: Preferences = {
        theme: theme.checked ? 'light' : 'dark',
        motion: motion.checked ? 'paused' : 'auto',
      };
      html.dataset.theme = preferences.theme;
      hasUnsavedChange = writePreferences({ window, preferences }) === 'failed';
    };
    theme.addEventListener('change', save);
    motion.addEventListener('change', save);
  }
  observer.observe(html, { childList: true, subtree: true });
  install();
  window.addEventListener('pageshow', event => {
    if (!event.persisted || hasUnsavedChange) return;
    const stored = readPreferences({ window });
    if (stored) apply({ preferences: stored, notification: 'changed' });
  });
  window.addEventListener('load', () => observer.disconnect(), { once: true });
  return initial.motion;
}
