import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  invoke: <T = any>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, cb: (payload: any) => void): (() => void) => {
    const listener = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  platform: process.platform
}

contextBridge.exposeInMainWorld('rcode', api)

export type RCodeApi = typeof api
