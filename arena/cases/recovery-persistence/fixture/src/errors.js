/** `code` is one of 'LOCKED', 'CORRUPT', 'CLOSED'. */
export class StoreError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'StoreError'
    this.code = code
  }
}
