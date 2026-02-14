/**
 * Transformers.js Worker Loader (NO-OP)
 *
 * This file is used in standalone mode to ensure that the worker
 * and its dependencies are NOT bundled.
 */

export function createTransformersWorker(): Worker | null {
  return null;
}
