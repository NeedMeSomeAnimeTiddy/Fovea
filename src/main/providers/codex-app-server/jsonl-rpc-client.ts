import { EventEmitter } from 'node:events'
import type { JsonRpcError, JsonRpcNotification, JsonRpcRequest } from './protocol'

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
}

export class JsonlRpcClient extends EventEmitter {
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()

  constructor(private readonly writeLine: (line: string) => void) {
    super()
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++
    const message: JsonRpcRequest = { method, id }
    if (params !== undefined) message.params = params

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
      try {
        this.writeLine(JSON.stringify(message))
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    const message: Record<string, unknown> = { method }
    if (params !== undefined) message.params = params
    this.writeLine(JSON.stringify(message))
  }

  respond(id: number | string, result: unknown): void {
    this.writeLine(JSON.stringify({ id, result }))
  }

  respondError(id: number | string, error: JsonRpcError): void {
    this.writeLine(JSON.stringify({ id, error }))
  }

  acceptLine(line: string): void {
    let message: any
    try {
      message = JSON.parse(line)
    } catch {
      this.emit('protocolError', new Error('App-server emitted malformed JSON'))
      return
    }

    if (!message || typeof message !== 'object') {
      this.emit('protocolError', new Error('App-server emitted a non-object message'))
      return
    }

    if ('id' in message && !('method' in message)) {
      const id = typeof message.id === 'number' ? message.id : Number(message.id)
      const pending = this.pending.get(id)
      if (!pending) {
        this.emit('protocolError', new Error(`Unmatched app-server response id ${String(message.id)}`))
        return
      }
      this.pending.delete(id)
      if (message.error) {
        pending.reject(new Error(String(message.error.message ?? 'App-server request failed')))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (typeof message.method === 'string' && 'id' in message) {
      this.emit('request', message as JsonRpcRequest)
      return
    }

    if (typeof message.method === 'string') {
      this.emit('notification', message as JsonRpcNotification)
      return
    }

    this.emit('protocolError', new Error('App-server emitted an unknown message shape'))
  }

  terminate(reason: Error): void {
    for (const pending of this.pending.values()) pending.reject(reason)
    this.pending.clear()
    this.emit('terminated', reason)
  }

  get pendingCount(): number {
    return this.pending.size
  }
}
