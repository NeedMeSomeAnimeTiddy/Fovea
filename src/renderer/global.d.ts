import type { SnipChatApi } from '@shared/contracts/ipc'

declare global {
  interface Window {
    snipchat: SnipChatApi
  }
}

export {}
