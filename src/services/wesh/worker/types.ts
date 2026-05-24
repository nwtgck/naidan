import { z } from 'zod'
import type { EmptyArgs } from '@/models/types'
import type { NaidanSysfsRemoteReader } from '@/services/wesh/naidan-sysfs/types'
import {
  NAIDAN_SYSFS_MOUNT_PATH,
  type WeshMount,
} from '@/services/wesh/types'

export const weshWorkerDirectoryMountSchema = z.object({
  type: z.literal('directory'),
  path: z.string().min(1),
  handle: z.custom<FileSystemDirectoryHandle>(),
  readOnly: z.boolean(),
})

export const weshWorkerNaidanSysfsMountSchema = z.object({
  type: z.literal('naidan_sysfs'),
  path: z.literal(NAIDAN_SYSFS_MOUNT_PATH),
  readOnly: z.literal(true),
  storageType: z.enum(['local', 'opfs', 'memory']),
  visibility: z.enum([
    'current_chat_only',
    'current_chat_with_chat_group',
    'all_chats',
  ]),
  currentChatId: z.string().min(1),
  currentChatGroupId: z.union([z.string().min(1), z.undefined()]),
})

export const weshWorkerMountSchema = z.discriminatedUnion('type', [
  weshWorkerDirectoryMountSchema,
  weshWorkerNaidanSysfsMountSchema,
])

export const weshWorkerInitRequestSchema = z.object({
  rootHandle: z.custom<FileSystemDirectoryHandle | 'readonly'>(),
  mounts: z.array(weshWorkerMountSchema),
  user: z.string().min(1),
  initialEnv: z.record(z.string(), z.string()),
  initialCwd: z.union([z.string().min(1), z.undefined()]),
  naidanSysfsRemoteReader: z.custom<NaidanSysfsRemoteReader>().optional(),
})

export const weshWorkerExecuteRequestSchema = z.object({
  script: z.string(),
})

export const weshWorkerStartExecutionResponseSchema = z.object({
  executionId: z.string().min(1),
})

export const weshWorkerAwaitExecutionRequestSchema = z.object({
  executionId: z.string().min(1),
})

export const weshWorkerInterruptExecutionRequestSchema = z.object({
  executionId: z.string().min(1),
})

export const weshWorkerDisposeExecutionRequestSchema = z.object({
  executionId: z.string().min(1),
})

export const weshWorkerExecutionSummarySchema = z.object({
  exitCode: z.number().int(),
})

export type WeshWorkerInitRequest = z.infer<typeof weshWorkerInitRequestSchema>
export type WeshWorkerExecuteRequest = z.infer<typeof weshWorkerExecuteRequestSchema>
export type WeshWorkerStartExecutionResponse = z.infer<typeof weshWorkerStartExecutionResponseSchema>
export type WeshWorkerAwaitExecutionRequest = z.infer<typeof weshWorkerAwaitExecutionRequestSchema>
export type WeshWorkerInterruptExecutionRequest = z.infer<typeof weshWorkerInterruptExecutionRequestSchema>
export type WeshWorkerDisposeExecutionRequest = z.infer<typeof weshWorkerDisposeExecutionRequestSchema>
export type WeshWorkerExecutionSummary = z.infer<typeof weshWorkerExecutionSummarySchema>
export type WeshWorkerMount = z.infer<typeof weshWorkerMountSchema>

export type WeshWorkerRemoteExecutionEvent =
  | { type: 'started' }
  | { type: 'stdout'; buffer: ArrayBuffer }
  | { type: 'stderr'; buffer: ArrayBuffer }
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; message: string }

export type WeshWorkerExecutionEvent =
  | { type: 'started' }
  | { type: 'stdout'; chunk: Uint8Array }
  | { type: 'stderr'; chunk: Uint8Array }
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; message: string }

export interface IWeshWorker {
  init({ request }: { request: WeshWorkerInitRequest }): Promise<void>
  startExecution(
    request: WeshWorkerExecuteRequest,
    onEvent?: (event: WeshWorkerRemoteExecutionEvent) => void | Promise<void>
  ): Promise<WeshWorkerStartExecutionResponse>
  awaitExecution({ request }: { request: WeshWorkerAwaitExecutionRequest }): Promise<WeshWorkerExecutionSummary>
  interruptExecution({ request }: { request: WeshWorkerInterruptExecutionRequest }): Promise<boolean>
  disposeExecution({ request }: { request: WeshWorkerDisposeExecutionRequest }): Promise<void>
  execute({ request }: { request: WeshWorkerExecuteRequest }): Promise<WeshWorkerExecutionSummary>
  interrupt(_args: EmptyArgs): Promise<boolean>
  dispose(_args: EmptyArgs): Promise<void>
}

export interface WeshWorkerClient {
  startExecution({ request, onEvent }: {
    request: WeshWorkerExecuteRequest
    onEvent?: (event: WeshWorkerExecutionEvent) => void | Promise<void>
  }): Promise<WeshWorkerStartExecutionResponse>
  awaitExecution({ request }: { request: WeshWorkerAwaitExecutionRequest }): Promise<WeshWorkerExecutionSummary>
  interruptExecution({ request }: { request: WeshWorkerInterruptExecutionRequest }): Promise<boolean>
  cancelExecution({ request }: { request: WeshWorkerInterruptExecutionRequest }): Promise<boolean>
  disposeExecution({ request }: { request: WeshWorkerDisposeExecutionRequest }): Promise<void>
  execute({ request }: { request: WeshWorkerExecuteRequest }): Promise<WeshWorkerExecutionSummary>
  interrupt(_args: EmptyArgs): Promise<boolean>
  dispose(_args: EmptyArgs): Promise<void>
}

export function mapWeshMountsToWorkerMounts({ mounts }: {
  mounts: WeshMount[]
}): WeshWorkerMount[] {
  return mounts.map(mount => {
    switch (mount.type) {
    case 'directory':
      return {
        type: 'directory',
        path: mount.path,
        handle: mount.handle,
        readOnly: mount.readOnly,
      }
    case 'naidan_sysfs':
      return {
        type: 'naidan_sysfs',
        path: mount.path,
        readOnly: true,
        storageType: mount.storageType,
        visibility: mount.visibility,
        currentChatId: mount.currentChatId,
        currentChatGroupId: mount.currentChatGroupId,
      }
    default: {
      const _ex: never = mount
      throw new Error(`Unhandled Wesh mount type: ${String(_ex)}`)
    }
    }
  })
}

export function mapRemoteWeshWorkerExecutionEventToClientEvent({ event }: {
  event: WeshWorkerRemoteExecutionEvent
}): WeshWorkerExecutionEvent {
  switch (event.type) {
  case 'started':
    return event
  case 'stdout':
    return {
      type: 'stdout',
      chunk: new Uint8Array(event.buffer),
    }
  case 'stderr':
    return {
      type: 'stderr',
      chunk: new Uint8Array(event.buffer),
    }
  case 'exit':
    return event
  case 'error':
    return event
  default: {
    const _ex: never = event
    throw new Error(`Unhandled remote wesh execution event: ${String(_ex)}`)
  }
  }
}
