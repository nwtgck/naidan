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

// Wait for DOM and Router to be ready
window.addEventListener('DOMContentLoaded', async () => {
  console.log('DOM Content Loaded')
  const appElement = document.querySelector('#app')
  if (!appElement) {
    console.error('Target element #app not found!')
    return
  }

  await router.isReady()
  console.log('Router is ready at:', window.location.hash || '/')

  app.mount('#app')
  console.log('App mounted.')
})