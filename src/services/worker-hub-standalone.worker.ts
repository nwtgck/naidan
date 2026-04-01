import * as Comlink from 'comlink'
import { createStandaloneWorkerHub } from './worker-hub-standalone'

Comlink.expose(createStandaloneWorkerHub({}))
