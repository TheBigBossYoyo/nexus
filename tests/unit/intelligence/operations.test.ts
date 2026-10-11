import { expect, it } from 'vitest'
import { IntelligenceOperations } from '@main/modules/intelligence/operations'

it('waits for the complete durable outcome after a provider settles and closes further admission', async () => {
  const operations = new IntelligenceOperations()
  let finishProvider!: () => void, finishWrite!: () => void
  const provider = new Promise<void>((resolve) => {
    finishProvider = resolve
  })
  const write = new Promise<void>((resolve) => {
    finishWrite = resolve
  })
  let persisted = false,
    stopped = false
  const work = operations.run(async () => {
    await provider
    await write
    persisted = true
  })
  operations.closeAdmission()
  await expect(operations.run(() => 'should never run')).rejects.toThrow('admission is closed')
  const idle = operations.idle().then(() => {
    stopped = true
  })
  finishProvider()
  await Promise.resolve()
  expect(stopped).toBe(false)
  finishWrite()
  await Promise.all([work, idle])
  expect(persisted).toBe(true)
  expect(stopped).toBe(true)
})

it('settles a failed operation without leaving shutdown waiting forever', async () => {
  const operations = new IntelligenceOperations()
  await expect(
    operations.run(() => {
      throw new Error('safe failure')
    }),
  ).rejects.toThrow('safe failure')
  operations.closeAdmission()
  await operations.idle()
})
