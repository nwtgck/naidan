import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import { routes } from 'vue-router/auto-routes'
import { useSettings } from './composables/useSettings'
import { useChatBootstrap } from './composables/chat/ui/useChatBootstrap'
import { warmFileProtocolCompatibleStandaloneWorkerHubAssetAtIdle } from './services/worker-hub-standalone-loader'
import {
  recordFileProtocolStandaloneStartupPhase,
  reportAppStartupFailure,
  scheduleAppStartup,
} from './services/app-startup'

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

async function bootstrapApp(): Promise<void> {
  recordFileProtocolStandaloneStartupPhase({
    phase: 'bootstrapping',
    details: undefined,
  })

  const appElement = document.querySelector('#app')
  if (appElement === null) {
    throw new Error('The #app mount element is missing.')
  }

  // Initialize global state (storage, settings, chat list) before rendering a
  // route component that may access those stores during setup.
  const settingsStore = useSettings()
  const chatBootstrap = useChatBootstrap()

  recordFileProtocolStandaloneStartupPhase({
    phase: 'waiting-router',
    details: undefined,
  })
  await router.isReady()

  const storageTypeQuery = router.currentRoute.value.query['storage-type']
  const storageTypeOverride = Array.isArray(storageTypeQuery) ? storageTypeQuery[0] : storageTypeQuery

  // Use a block scope to ensure dataZipBase64 can be GC'd as soon as init is done.
  {
    const dataZipQuery = router.currentRoute.value.query['data-zip']
    const dataZipBase64 = Array.isArray(dataZipQuery) ? dataZipQuery[0] : dataZipQuery

    // Clear the large data-zip parameter from the URL after extraction to keep
    // it clean and help with GC. Preserve storage-type because it remains useful
    // when the URL is inspected or bookmarked.
    if (dataZipBase64) {
      const newQuery = { ...router.currentRoute.value.query }
      delete newQuery['data-zip']
      void router.replace({ query: newQuery })
    }

    recordFileProtocolStandaloneStartupPhase({
      phase: 'initializing-settings',
      details: {
        hasStorageTypeOverride: storageTypeOverride !== undefined,
        hasDataZip: dataZipBase64 !== undefined,
      },
    })
    await settingsStore.init({
      storageTypeOverride: storageTypeOverride || undefined,
      dataZipBase64: dataZipBase64 || undefined,
    })
  }

  recordFileProtocolStandaloneStartupPhase({
    phase: 'loading-chats',
    details: undefined,
  })
  await chatBootstrap.loadChats()

  recordFileProtocolStandaloneStartupPhase({
    phase: 'mounting-vue',
    details: undefined,
  })
  app.mount(appElement)
  recordFileProtocolStandaloneStartupPhase({
    phase: 'mounted',
    details: undefined,
  })

  if (__BUILD_MODE_IS_STANDALONE__) {
    warmFileProtocolCompatibleStandaloneWorkerHubAssetAtIdle()
  }
}

recordFileProtocolStandaloneStartupPhase({
  phase: 'entry-evaluated',
  details: undefined,
})
scheduleAppStartup({
  document,
  bootstrap: bootstrapApp,
  onFailure: ({ error }) => {
    reportAppStartupFailure({ document, error })
  },
})
