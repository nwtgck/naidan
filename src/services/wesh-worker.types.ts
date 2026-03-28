import { z } from 'zod'
import type { EmptyArgs } from '@/models/types'
import type { WeshMount } from '@/services/wesh/types'

export const weshWorkerMountSchema = z.object({
  path: z.string().min(1),
  handle: z.custom<FileSystemDirectoryHandle>(),
  readOnly: z.boolean(),
})

export const weshWorkerInitRequestSchema = z.object({
  rootHandle: z.custom<FileSystemDirectoryHandle | 'readonly'>(),
  mounts: z.array(weshWorkerMountSchema),
  user: z.string().min(1),
  initialEnv: z.record(z.string(), z.string()),
  initialCwd: z.union([z.string().min(1), z.undefined()]),
})

export const weshWorkerExecuteRequestSchema = z.object({
  script: z.string(),
  stdoutLimit: z.number().int().min(0),
  stderrLimit: z.number().int().min(0),
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
  stdout: z.string(),
  stderr: z.string(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
})

export type WeshWorkerInitRequest = z.infer<typeof weshWorkerInitRequestSchema>
export type WeshWorkerExecuteRequest = z.infer<typeof weshWorkerExecuteRequestSchema>
export type WeshWorkerStartExecutionResponse = z.infer<typeof weshWorkerStartExecutionResponseSchema>
export type WeshWorkerAwaitExecutionRequest = z.infer<typeof weshWorkerAwaitExecutionRequestSchema>
export type WeshWorkerInterruptExecutionRequest = z.infer<typeof weshWorkerInterruptExecutionRequestSchema>
export type WeshWorkerDisposeExecutionRequest = z.infer<typeof weshWorkerDisposeExecutionRequestSchema>
export type WeshWorkerExecutionSummary = z.infer<typeof weshWorkerExecutionSummarySchema>
export type WeshWorkerMount = z.infer<typeof weshWorkerMountSchema>

export type WeshWorkerExecutionEvent =
  | { type: 'started' }
  | { type: 'stdout'; text: string }
  | { type: 'stderr'; text: string }
  | { type: 'stdout_truncated' }
  | { type: 'stderr_truncated' }
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; message: string }

export interface IWeshWorker {
  init({ request }: { request: WeshWorkerInitRequest }): Promise<void>
  startExecution(
    request: WeshWorkerExecuteRequest,
    onEvent?: (event: WeshWorkerExecutionEvent) => void | Promise<void>
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
  disposeExecution({ request }: { request: WeshWorkerDisposeExecutionRequest }): Promise<void>
  execute({ request }: { request: WeshWorkerExecuteRequest }): Promise<WeshWorkerExecutionSummary>
  interrupt(_args: EmptyArgs): Promise<boolean>
  dispose(_args: EmptyArgs): Promise<void>
}

export function mapWeshMountsToWorkerMounts({ mounts }: {
  mounts: WeshMount[]
}): WeshWorkerMount[] {
  return mounts.map(mount => ({
    path: mount.path,
    handle: mount.handle,
    readOnly: mount.readOnly,
  }))
}
