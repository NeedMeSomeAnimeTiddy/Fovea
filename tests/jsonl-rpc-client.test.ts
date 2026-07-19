import { describe, expect, it, vi } from 'vitest'
import { JsonlRpcClient } from '../src/main/providers/codex-app-server/jsonl-rpc-client'

describe('JsonlRpcClient', () => {
  it('correlates out-of-order responses by request id', async () => {
    const lines: string[] = []
    const client = new JsonlRpcClient((line) => lines.push(line))
    const first = client.request<{ value: string }>('first')
    const second = client.request<{ value: string }>('second')
    const firstId = JSON.parse(lines[0]!).id
    const secondId = JSON.parse(lines[1]!).id
    client.acceptLine(JSON.stringify({ id: secondId, result: { value: 'two' } }))
    client.acceptLine(JSON.stringify({ id: firstId, result: { value: 'one' } }))
    await expect(first).resolves.toEqual({ value: 'one' })
    await expect(second).resolves.toEqual({ value: 'two' })
  })

  it('routes notifications and survives malformed JSON', () => {
    const client = new JsonlRpcClient(() => undefined)
    const notification = vi.fn()
    const protocolError = vi.fn()
    client.on('notification', notification)
    client.on('protocolError', protocolError)
    client.acceptLine('{not json')
    client.acceptLine(JSON.stringify({ method: 'turn/started', params: { threadId: 'a' } }))
    expect(protocolError).toHaveBeenCalledOnce()
    expect(notification).toHaveBeenCalledWith({ method: 'turn/started', params: { threadId: 'a' } })
  })

  it('rejects every pending request when the sidecar terminates', async () => {
    const client = new JsonlRpcClient(() => undefined)
    const pending = client.request('model/list')
    client.terminate(new Error('sidecar exited'))
    await expect(pending).rejects.toThrow('sidecar exited')
    expect(client.pendingCount).toBe(0)
  })
})
