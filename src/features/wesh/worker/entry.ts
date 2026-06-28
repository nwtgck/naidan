import * as Comlink from 'comlink';
import { createWeshWorker } from './impl';

Comlink.expose(createWeshWorker());
