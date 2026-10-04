export class StoreError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'StoreError'
    this.code = code
  }
}
