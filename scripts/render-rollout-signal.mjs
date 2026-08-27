export class RolloutActiveRequestState {
  constructor() {
    this.activeController = null
    this.allowAfterInterrupt = false
  }

  enter(controller, options = {}) {
    const previousController = this.activeController
    const previousAllowance = this.allowAfterInterrupt
    this.activeController = controller
    this.allowAfterInterrupt = options.allowAfterInterrupt === true
    let restored = false

    return () => {
      if (restored) return
      restored = true
      if (this.activeController === controller) {
        this.activeController = previousController
        this.allowAfterInterrupt = previousAllowance
      }
    }
  }

  abortUnlessProtected(reason) {
    if (!this.activeController || this.allowAfterInterrupt) return false
    this.activeController.abort(reason)
    return true
  }
}
