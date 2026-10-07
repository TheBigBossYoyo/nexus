import type { FakeScript, FakeSessionContext } from '@main/modules/agent-runtime/fake-runtime'

/**
 * A scripted session whose prompt says what it does, one directive per line. It exists so that tests of the
 * worker manager can make a real worker process do exactly one thing: speak, call a tool, wait, die.
 *
 *   text:<words>            emit a text block
 *   tool:<name>:<json>      ask to use a tool with that input (goes through the runtime's policy)
 *   message:<subject>       call the NEXUS tool `send_message`
 *   sleep:<ms>              wait
 *   crash                   end the session as crashed
 *   exit:<code>             end the worker process at once, as a crash of the process would
 *   hang                    block the worker's event loop for good (its heartbeat stops)
 *
 * After the directives the turn completes with "done"; every later message is read the same way.
 */
async function perform(text: string, ctx: FakeSessionContext): Promise<void> {
  for (const line of text.split('\n').map((l) => l.trim())) {
    if (line.startsWith('text:')) await ctx.emitText(line.slice(5))
    else if (line.startsWith('tool:')) {
      const rest = line.slice(5)
      const at = rest.indexOf(':')
      const name = at < 0 ? rest : rest.slice(0, at)
      const input = at < 0 ? {} : (JSON.parse(rest.slice(at + 1)) as Record<string, unknown>)
      const allowed = await ctx.useTool(name, input, async () => 'ok')
      await ctx.emitText(allowed ? `allowed ${name}` : `denied ${name}`)
    } else if (line.startsWith('message:')) {
      const answer = await ctx.nexusTools?.sendMessage({ type: 'status', subject: line.slice(8), body: line.slice(8), toTask: null, toRole: null, severity: null } as never)
      await ctx.emitText(`message ${answer ?? 'unavailable'}`)
    } else if (line.startsWith('sleep:')) await ctx.sleep(Number(line.slice(6)))
    else if (line === 'crash') ctx.fail('scripted crash')
    else if (line.startsWith('exit:')) process.exit(Number(line.slice(5)) || 1)
    else if (line === 'hang') {
      for (;;) {
        // Deliberately never yields: this is what a worker that stopped responding looks like.
      }
    }
  }
}

export function createProbeScript(): FakeScript {
  return async (spec, ctx) => {
    let text: string | null = spec.prompt
    while (text !== null) {
      await perform(text, ctx)
      await ctx.completeTurn({ text: 'done' })
      text = await ctx.nextMessage()
    }
  }
}
