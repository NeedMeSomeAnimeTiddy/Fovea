import { describe, expect, it, vi } from 'vitest'
import { ApplicationLaunchQueue } from '../src/main/shell/application-launch-queue'

describe('ApplicationLaunchQueue', () => {
  it('keeps every early launch and drains them in arrival order', () => {
    const queue = new ApplicationLaunchQueue<string>()
    const dispatch = vi.fn()

    queue.enqueue('first')
    queue.enqueue('second')
    queue.enqueue('third')
    queue.connect(dispatch)

    expect(dispatch.mock.calls).toEqual([['first'], ['second'], ['third']])
  })

  it('dispatches later launches immediately after connecting', () => {
    const queue = new ApplicationLaunchQueue<string>()
    const dispatch = vi.fn()

    queue.connect(dispatch)
    queue.enqueue('settings')

    expect(dispatch).toHaveBeenCalledExactlyOnceWith('settings')
  })

  it('preserves FIFO order when dispatch causes another launch', () => {
    const queue = new ApplicationLaunchQueue<string>()
    const received: string[] = []

    queue.enqueue('first')
    queue.enqueue('second')
    queue.connect((launch) => {
      received.push(launch)
      if (launch === 'first') queue.enqueue('third')
    })

    expect(received).toEqual(['first', 'second', 'third'])
  })

  it('can discard pending launches after startup fails', () => {
    const queue = new ApplicationLaunchQueue<string>()
    const dispatch = vi.fn()

    queue.enqueue('sensitive-path')
    queue.clear()
    queue.connect(dispatch)

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects replacing the connected dispatcher', () => {
    const queue = new ApplicationLaunchQueue<string>()
    queue.connect(() => undefined)

    expect(() => queue.connect(() => undefined)).toThrow('already connected')
  })
})
