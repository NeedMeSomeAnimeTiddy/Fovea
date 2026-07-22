import type { FoveaApi } from '@shared/contracts/ipc'

declare global {
  interface Window {
    fovea: FoveaApi
  }
}

export {}
