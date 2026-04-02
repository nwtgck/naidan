import type { EmptyArgs } from '@/models/types'
import { highlightCodeInWorker } from './core'
import {
  highlightRequestSchema,
  highlightResponseSchema,
  type IHighlightWorker,
} from './types'

export function createHighlightWorker(_args: EmptyArgs): IHighlightWorker {
  return {
    async highlight({ request }) {
      const validated = highlightRequestSchema.parse(request)
      return highlightResponseSchema.parse(highlightCodeInWorker({
        code: validated.code,
        language: validated.language,
        mode: validated.mode,
      }))
    },
  }
}
