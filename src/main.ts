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

  await settingsStore.init()
  await chatStore.loadChats()

  await router.isReady()
  app.mount('#app')
})