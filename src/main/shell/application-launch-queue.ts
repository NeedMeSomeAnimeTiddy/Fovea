/**
 * Holds launches that arrive before the application services are ready, then drains them in
 * arrival order once a dispatcher is connected. Enqueues during a drain stay ordered too.
 */
export class ApplicationLaunchQueue<T> {
  private readonly pending: T[] = []
  private dispatch: ((launch: T) => void) | null = null
  private draining = false

  enqueue(launch: T): void {
    this.pending.push(launch)
    this.drain()
  }

  connect(dispatch: (launch: T) => void): void {
    if (this.dispatch) throw new Error('The application launch queue is already connected.')
    this.dispatch = dispatch
    this.drain()
  }

  clear(): void {
    this.pending.length = 0
  }

  private drain(): void {
    if (!this.dispatch || this.draining) return
    this.draining = true
    try {
      let launch = this.pending.shift()
      while (launch !== undefined) {
        this.dispatch(launch)
        launch = this.pending.shift()
      }
    } finally {
      this.draining = false
    }
  }
}
