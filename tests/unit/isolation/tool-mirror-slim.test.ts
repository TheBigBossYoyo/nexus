import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { slimCopy } from '@main/modules/isolation/tools'

// 0.9.1: Scoop keeps npm's global tools (pnpm among them) and npm's cache in one folder of several GB. It was too large
// to copy, so pnpm never reached the sandbox and an enrolled pnpm project could neither install nor run a check.
const root = resolve('test-results', 'tool-mirror-slim')
afterAll(() => rmSync(root, { recursive: true, force: true }))

function globalTools(): string {
  rmSync(root, { recursive: true, force: true })
  const bin = join(root, 'persist', 'nodejs-lts', 'bin')
  mkdirSync(join(bin, 'node_modules', 'pnpm'), { recursive: true })
  mkdirSync(join(bin, 'node_modules', '@scope', 'other'), { recursive: true })
  mkdirSync(join(root, 'persist', 'nodejs-lts', 'cache'), { recursive: true })
  writeFileSync(join(bin, 'pnpm.cmd'), '@ECHO off\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\pnpm\\pnpm.exe"   %*\r\n')
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexec "$basedir/node_modules/pnpm/pnpm.exe" "$@"\n')
  writeFileSync(join(bin, 'node_modules', 'pnpm', 'pnpm.exe'), 'binary')
  writeFileSync(join(bin, 'node_modules', 'pnpm', 'package.json'), '{"name":"pnpm","version":"10.0.0"}')
  writeFileSync(join(bin, 'node_modules', '@scope', 'other', 'index.js'), 'not needed')
  writeFileSync(join(root, 'persist', 'nodejs-lts', 'cache', 'big'), 'cache')
  return join(bin, 'pnpm.cmd')
}

describe('slimCopy', () => {
  it('copies a global tool launcher with the one package it starts, and nothing else of the folder', () => {
    const tools = join(root, 'tools')
    mkdirSync(tools, { recursive: true })
    const target = slimCopy(globalTools(), tools)
    expect(target).not.toBeNull()
    expect(existsSync(join(target as string, 'pnpm.cmd'))).toBe(true)
    expect(existsSync(join(target as string, 'pnpm'))).toBe(true)
    expect(readFileSync(join(target as string, 'node_modules', 'pnpm', 'pnpm.exe'), 'utf8')).toBe('binary')
    expect(existsSync(join(target as string, 'node_modules', '@scope'))).toBe(false)
    expect(existsSync(join(target as string, 'cache'))).toBe(false)
    // Made once and reused.
    expect(slimCopy(join(root, 'persist', 'nodejs-lts', 'bin', 'pnpm.cmd'), tools)).toBe(target)
  })

  it('leaves a launcher of another form alone', () => {
    const tools = join(root, 'tools')
    const other = join(root, 'plain.cmd')
    mkdirSync(tools, { recursive: true })
    writeFileSync(other, '@echo off\r\nnode "%~dp0\\x.js" %*\r\n')
    expect(slimCopy(other, tools)).toBeNull()
  })
})
