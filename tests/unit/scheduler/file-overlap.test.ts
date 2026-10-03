import { describe, expect, it } from 'vitest'
import { filesOverlap, findOverlappingFiles, normalizeFilePattern } from '@main/modules/scheduler'

describe('normalizeFilePattern', () => {
  it('normalizes slashes, case, leading ./ and trailing slash', () => {
    expect(normalizeFilePattern('.\\Src\\App.TS')).toBe('src/app.ts')
    expect(normalizeFilePattern('./././src//lib/')).toBe('src/lib')
    expect(normalizeFilePattern('C:\\Repo\\a.ts')).toBe('c:/repo/a.ts')
  })
})

describe('findOverlappingFiles', () => {
  it('matches identical files regardless of notation', () => {
    expect(findOverlappingFiles(['src/a.ts'], ['.\\SRC\\a.ts'])).toEqual(['src/a.ts'])
  })

  it('does not match different files or sibling names sharing a prefix', () => {
    expect(filesOverlap(['src/a.ts'], ['src/b.ts'])).toBe(false)
    expect(filesOverlap(['src/app'], ['src/app.ts'])).toBe(false)
  })

  it('treats a directory as overlapping everything beneath it', () => {
    expect(findOverlappingFiles(['src'], ['src/deep/x.ts'])).toEqual(['src/deep/x.ts'])
    expect(filesOverlap(['src/'], ['src/x.ts'])).toBe(true)
    expect(filesOverlap(['src/x.ts'], ['src'])).toBe(true)
  })

  it('supports /** globs', () => {
    expect(filesOverlap(['src/ui/**'], ['src/ui/a/b.ts'])).toBe(true)
    expect(filesOverlap(['src/ui/**'], ['src/ui'])).toBe(true)
    expect(filesOverlap(['src/ui/**'], ['src/main/a.ts'])).toBe(false)
    expect(filesOverlap(['**'], ['anything/at/all.ts'])).toBe(true)
  })

  it('supports /* globs as direct children only', () => {
    expect(filesOverlap(['src/*'], ['src/a.ts'])).toBe(true)
    expect(filesOverlap(['src/*'], ['src/sub'])).toBe(true)
    expect(filesOverlap(['src/*'], ['src/sub/a.ts'])).toBe(false)
    expect(filesOverlap(['src/*'], ['src'])).toBe(true)
    expect(filesOverlap(['src/*'], ['lib/a.ts'])).toBe(false)
    expect(filesOverlap(['src/*'], ['src/*'])).toBe(true)
    expect(filesOverlap(['src/*'], ['src/sub/*'])).toBe(false)
    expect(filesOverlap(['src/*'], ['src/**'])).toBe(true)
  })

  it('ignores empty entries and empty lists', () => {
    expect(filesOverlap([], ['src/a.ts'])).toBe(false)
    expect(filesOverlap(['', '  ', './'], ['src/a.ts'])).toBe(false)
  })

  it('deduplicates and sorts results', () => {
    expect(findOverlappingFiles(['b.ts', 'a.ts', 'a.ts'], ['a.ts', 'b.ts'])).toEqual(['a.ts', 'b.ts'])
  })
})
