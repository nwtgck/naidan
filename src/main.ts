import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import { routes } from 'vue-router/auto-routes'

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

const app = createApp(App)

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

  await router.isReady()
  app.mount('#app')
})