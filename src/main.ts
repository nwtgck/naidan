import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import { routes } from 'vue-router/auto-routes'
import { useSettings } from './composables/useSettings'
import { useChat } from './composables/useChat'

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

const app = createApp(App)

/**
 * Global Vue error handler.
 * This is essential for catching and logging rendering errors that might otherwise
 * fail silently, particularly in the restrictive 'file:///' environment.
 * It helps identify which component and lifecycle hook caused the issue.
 */
app.config.errorHandler = (err, instance, info) => {
  console.error('Vue Error:', err)
  console.error('Vue Instance:', instance)
  console.error('Error Info:', info)
}

app.use(router)

/**
 * IMPORTANT FOR file:/// PROTOCOL:
 * We must wait for both the DOM to be fully loaded and the Router to be ready.
 * In a local file environment (especially with IIFE builds), mounting the app
 * prematurely can lead to silent failures or white screens.
 */
window.addEventListener('DOMContentLoaded', async () => {
  const appElement = document.querySelector('#app')
  if (!appElement) return

  // Initialize global state (storage, settings, chat list)
  // BEFORE the router processes the initial URL.
  // This prevents race conditions where a child component (like a chat page)
  // tries to load data before the storage provider is correctly initialized.
  const settingsStore = useSettings()
  const chatStore = useChat()

  // Wait for the router to be ready before accessing query parameters.
  // This ensures that the initial URL (even on root path '/') is correctly parsed.
  await router.isReady()

  const storageTypeQuery = router.currentRoute.value.query['storage-type'];
  const storageTypeOverride = Array.isArray(storageTypeQuery) ? storageTypeQuery[0] : storageTypeQuery;

  // Use a block scope to ensure dataZipBase64 can be GC'd as soon as init is done
  {
    const dataZipQuery = router.currentRoute.value.query['data-zip'];
    const dataZipBase64 = Array.isArray(dataZipQuery) ? dataZipQuery[0] : dataZipQuery;

    // Clear the large data-zip parameter from the URL after extraction to keep it clean and help with GC.
    // We preserve 'storage-type' as it might be useful for the user to see/bookmark.
    if (dataZipBase64) {
      const newQuery = { ...router.currentRoute.value.query };
      delete newQuery['data-zip'];
      router.replace({ query: newQuery });
    }

    await settingsStore.init({
      storageTypeOverride: storageTypeOverride || undefined,
      dataZipBase64: dataZipBase64 || undefined
    })
  }

  await chatStore.loadChats()

  app.mount('#app')
})