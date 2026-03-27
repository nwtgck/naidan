import { z } from 'zod'
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

export const weshWorkerExecuteResponseSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
})

export type WeshWorkerInitRequest = z.infer<typeof weshWorkerInitRequestSchema>
export type WeshWorkerExecuteRequest = z.infer<typeof weshWorkerExecuteRequestSchema>
export type WeshWorkerExecuteResponse = z.infer<typeof weshWorkerExecuteResponseSchema>
export type WeshWorkerMount = z.infer<typeof weshWorkerMountSchema>

export interface IWeshWorker {
  init({ request }: { request: WeshWorkerInitRequest }): Promise<void>
  execute({ request }: { request: WeshWorkerExecuteRequest }): Promise<WeshWorkerExecuteResponse>
  interrupt(_args: { noop?: never }): Promise<boolean>
  dispose(_args: { noop?: never }): Promise<void>
}

export interface WeshWorkerClient {
  execute({ request }: { request: WeshWorkerExecuteRequest }): Promise<WeshWorkerExecuteResponse>
  interrupt(_args: { noop?: never }): Promise<boolean>
  dispose(_args: { noop?: never }): Promise<void>
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
