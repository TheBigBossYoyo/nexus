import { describe, expect, it } from 'vitest'
import { FakeAgentRuntime, type FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { DirectorVoice, figuresNotGiven, splitSentences, type DirectorVoiceOptions } from '@main/modules/director-line/director-voice'

// 0.9.1: the Director's voice on a live call, against scripted sessions only. No model is asked anything here.
const FACTS = 'RaceDeck: 73%, verifying.\n25–40 min of active work remain.\nTasks: 16 done, 2 running.'

/** A session that stays open: each message is answered with the pieces `write` returns, streamed one by one. */
const talk = (write: (prompt: string, turn: number) => string[], prompts: string[] = []): FakeScript => async (spec, ctx) => {
  let prompt: string | null = spec.prompt
  let turn = 0
  while (prompt !== null) {
    prompts.push(prompt)
    const pieces = write(prompt, turn++)
    for (const piece of pieces) await ctx.emitEvent({ type: 'text.delta', text: piece })
    await ctx.completeTurn({ text: pieces.join('') })
    prompt = await ctx.nextMessage()
  }
}

function voice(script: FakeScript, over: Partial<DirectorVoiceOptions> = {}) {
  const runtime = new FakeAgentRuntime({ script })
  const turns: { outcome: string; firstWordMs: number | null }[] = []
  const v = new DirectorVoice({ runtime, cwd: process.cwd(), model: 'fast-model', subscriptionMode: true, firstWordTimeoutMs: 200, turnTimeoutMs: 400, settleTimeoutMs: 100, onTurn: (t) => turns.push(t), ...over })
  const ask = async (said: string, facts = FACTS) => {
    const heard: string[] = []
    const answer = await v.answer({ said, facts }, (s) => heard.push(s))
    return { answer, heard }
  }
  return { v, runtime, turns, ask }
}

describe('sentences and figures', () => {
  it('hands on whole sentences only, and the remainder at the end', () => {
    expect(splitSentences('It is at 73%. About 25', false)).toEqual({ ready: ['It is at 73%.'], rest: 'About 25' })
    expect(splitSentences('It is at 73.', false)).toEqual({ ready: [], rest: 'It is at 73.' })
    expect(splitSentences('It is at 73.5 percent', true)).toEqual({ ready: ['It is at 73.5 percent'], rest: '' })
    expect(splitSentences('One.\nTwo! Three', true).ready).toEqual(['One.', 'Two!', 'Three'])
    expect(splitSentences('word '.repeat(80), false).ready.every((s) => s.length <= 240)).toBe(true)
  })

  it('finds the figures that were not given', () => {
    expect(figuresNotGiven('RaceDeck is at 73%, with 16 done.', FACTS)).toEqual([])
    expect(figuresNotGiven('About 30 minutes are left.', FACTS)).toEqual(['30'])
    expect(figuresNotGiven('5,182 tests passed.', 'unit: 5182 passed')).toEqual([])
    expect(figuresNotGiven('It is at 73.5%.', FACTS)).toEqual(['73.5'])
  })
})

describe('the Director voice', () => {
  it('asks a session with no tools and no authority, on the fast model, and speaks sentence by sentence', async () => {
    const prompts: string[] = []
    const w = voice(talk(() => ['RaceDeck is at 73%', ' and verifying. ', 'Between 25', ' and 40 minutes remain.'], prompts))
    const { answer, heard } = await w.ask('How is RaceDeck going?')
    expect(heard).toEqual(['RaceDeck is at 73% and verifying.', 'Between 25 and 40 minutes remain.'])
    expect(answer).toEqual({ text: heard.join(' '), by: 'MODEL', interrupted: false })
    const spec = w.runtime.sessions[0]!
    expect(spec.tools).toEqual([])
    expect(spec.model).toBe('fast-model')
    expect(spec.loadProjectSettings).toBe(false)
    expect(spec.nexusTools).toBeUndefined()
    expect(spec.mcpServers).toBeUndefined()
    expect(await spec.requestApproval({ agentId: spec.agentId, toolName: 'Bash', input: {}, toolUseId: 't' }, 'test', 'high')).toBe(false)
    expect((await spec.authorize({ agentId: spec.agentId, toolName: 'Bash', input: {}, toolUseId: 't' })).behavior).toBe('deny')
    expect(spec.systemPromptAppend).toContain('No execution authority')
    expect(prompts[0]).toContain('FACTS\nRaceDeck: 73%, verifying.')
    expect(prompts[0]).toContain('THE OPERATOR SAID\nHow is RaceDeck going?')
    expect(w.turns).toHaveLength(1)
    expect(w.turns[0]?.firstWordMs).not.toBeNull()
    await w.v.close()
  })

  it('keeps one session for the call: the second question is a turn of the same session', async () => {
    const prompts: string[] = []
    const w = voice(talk((_p, turn) => [turn === 0 ? 'It is at 73%.' : 'There are 2 running.'], prompts))
    await w.ask('status')
    expect((await w.ask('how many are running')).heard).toEqual(['There are 2 running.'])
    expect(w.runtime.sessions).toHaveLength(1)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).not.toContain('EARLIER IN THIS CALL')
    await w.v.close()
    expect(w.runtime.handles[0]?.stopConfirmed?.()).toBe(true)
  })

  it('warmed before the first question, the session is already there', async () => {
    const prompts: string[] = []
    const w = voice(talk((p) => [p.includes('connecting') ? 'ready' : 'It is at 73%.'], prompts))
    w.v.warm()
    w.v.warm()
    const { heard } = await w.ask('status')
    expect(heard).toEqual(['It is at 73%.'])
    expect(w.runtime.sessions).toHaveLength(1)
    expect(prompts[0]).toContain('The call is connecting')
    await w.v.close()
  })

  it('a figure NEXUS did not give is not spoken: the facts are said instead', async () => {
    const w = voice(talk(() => ['It is going well. ', 'About 30 minutes are left. ', 'Then it is done.']))
    const { answer, heard } = await w.ask('how long is left')
    expect(heard[0]).toBe('It is going well.')
    expect(heard.join(' ')).not.toContain('30')
    expect(heard.join(' ')).toContain('The exact figures. RaceDeck: 73%, verifying. 25–40 min of active work remain.')
    expect(answer.by).toBe('FACTS')
    await w.v.close()
  })

  it('a figure the operator said may be said back', async () => {
    const w = voice(talk(() => ['I have nothing about 4K in what I was given.']))
    expect((await w.ask('did the 4K test pass')).answer.by).toBe('MODEL')
    await w.v.close()
  })

  it('markup and links the facts did not carry do not reach the voice', async () => {
    const w = voice(talk(() => ['**RaceDeck** is at 73%, see https://example.test/x for more.']))
    const { heard } = await w.ask('status')
    expect(heard).toEqual(['RaceDeck is at 73%, see [link removed] for more.'])
    await w.v.close()
  })

  it('no first word in time: the facts are said, and the next question still works', async () => {
    let slow = true
    const w = voice(async (spec, ctx) => {
      let prompt: string | null = spec.prompt
      while (prompt !== null) {
        if (slow) {
          await ctx.sleep(5000)
          await ctx.completeTurn({ text: '', outcome: 'aborted' })
        } else {
          await ctx.emitEvent({ type: 'text.delta', text: 'It is at 73%.' })
          await ctx.completeTurn({ text: 'It is at 73%.' })
        }
        prompt = await ctx.nextMessage()
      }
    }, { firstWordTimeoutMs: 40 })
    const first = await w.ask('status')
    expect(first.answer.by).toBe('FACTS')
    expect(first.heard[0]).toBe('RaceDeck: 73%, verifying.')
    slow = false
    const second = await w.ask('status')
    expect(second.answer).toEqual({ text: 'It is at 73%.', by: 'MODEL', interrupted: false })
    expect(w.runtime.sessions).toHaveLength(1)
    await w.v.close()
  })

  it('a turn that was cut off and never ends costs the session, not the call', async () => {
    let stuck = true
    const prompts: string[] = []
    const w = voice(async (spec, ctx) => {
      prompts.push(spec.prompt)
      if (stuck) {
        await ctx.emitEvent({ type: 'text.delta', text: 'RaceDeck is at 73%. ' })
        await new Promise((r) => setTimeout(r, 3000))
        return
      }
      await ctx.emitEvent({ type: 'text.delta', text: 'There are 2 running.' })
      await ctx.completeTurn({ text: 'There are 2 running.' })
      await ctx.nextMessage()
    }, { turnTimeoutMs: 60, settleTimeoutMs: 30 })
    const first = await w.ask('status')
    expect(first.heard[0]).toBe('RaceDeck is at 73%.')
    expect(first.answer.by).toBe('FACTS')
    stuck = false
    const second = await w.ask('how many are running')
    expect(second.heard).toEqual(['There are 2 running.'])
    expect(w.runtime.sessions).toHaveLength(2)
    // The new session is told what was said so far in the call.
    expect(prompts[1]).toContain('EARLIER IN THIS CALL\nOperator: status')
    await w.v.close()
  })

  it('spoken over, it stops: nothing more is handed on, and the next thing said is answered', async () => {
    const w = voice(async (spec, ctx) => {
      let prompt: string | null = spec.prompt
      while (prompt !== null) {
        if (prompt.includes('status')) {
          await ctx.emitEvent({ type: 'text.delta', text: 'RaceDeck is at 73%. ' })
          await ctx.sleep(5000)
          await ctx.emitEvent({ type: 'text.delta', text: 'There are 16 done. ' })
          await ctx.completeTurn({ text: '', outcome: 'aborted' })
        } else {
          await ctx.emitEvent({ type: 'text.delta', text: 'There are 2 running.' })
          await ctx.completeTurn({ text: 'There are 2 running.' })
        }
        prompt = await ctx.nextMessage()
      }
    }, { firstWordTimeoutMs: 1000, turnTimeoutMs: 2000 })
    const heard: string[] = []
    const pending = w.v.answer({ said: 'status', facts: FACTS }, (s) => heard.push(s))
    await expect.poll(() => heard.length).toBe(1)
    w.v.interrupt()
    expect(await pending).toEqual({ text: 'RaceDeck is at 73%.', by: 'MODEL', interrupted: true })
    const next = await w.ask('how many are running')
    expect(next.heard).toEqual(['There are 2 running.'])
    expect(heard).toEqual(['RaceDeck is at 73%.'])
    expect(w.runtime.sessions).toHaveLength(1)
    await w.v.close()
  })

  it('not admitted, failed or crashed: the facts are said and no error leaves', async () => {
    const closedDoor = voice(talk(() => ['x']), { admitted: () => false })
    expect((await closedDoor.ask('status')).answer.by).toBe('FACTS')
    expect(closedDoor.runtime.sessions).toHaveLength(0)

    const failing = voice(async (_spec, ctx) => {
      await ctx.completeTurn({ text: 'limit', outcome: 'quota' })
    })
    expect((await failing.ask('status')).answer.by).toBe('FACTS')

    const crashing = voice(async (_spec, ctx) => ctx.fail('gone'))
    const crashed = await crashing.ask('status')
    expect(crashed.answer.by).toBe('FACTS')
    expect(crashed.heard.join(' ')).toContain('Tasks: 16 done, 2 running.')

    const throwing = new DirectorVoice({ runtime: { startSession: () => { throw new Error('no runtime') } }, cwd: process.cwd(), subscriptionMode: true })
    expect((await throwing.answer({ said: 'status', facts: FACTS }, () => undefined)).by).toBe('FACTS')
  })

  it('a session that reaches for a tool is dropped', async () => {
    const w = voice(async (_spec, ctx) => {
      await ctx.useTool('Bash', { command: 'whoami' })
      await ctx.completeTurn({ text: 'It is at 73%.' })
    })
    const { answer } = await w.ask('status')
    expect(answer.by).toBe('FACTS')
    await w.v.close()
  })

  it('an answer that runs on is cut at six sentences', async () => {
    const w = voice(talk(() => ['One. Two. Three. Four. Five. Six. Seven. Eight. ']))
    const { heard } = await w.ask('status')
    expect(heard.slice(0, 6)).toEqual(['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.'])
    expect(heard).not.toContain('Seven.')
    await w.v.close()
  })

  it('after the call is over nothing is asked of the model', async () => {
    const w = voice(talk(() => ['It is at 73%.']))
    await w.ask('status')
    await w.v.close()
    expect((await w.ask('status')).answer.by).toBe('FACTS')
    expect(w.runtime.sessions).toHaveLength(1)
  })
})
