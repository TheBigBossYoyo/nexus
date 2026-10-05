export class CronError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CronError'
  }
}
