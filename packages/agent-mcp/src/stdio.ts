import type { Notification, Response } from './jsonRpc.js'
import { type Handler, type HandlerOptions, handler } from './handler.js'

export interface StdioOptions {
  readonly input?: NodeJS.ReadableStream | undefined
  readonly output?: NodeJS.WritableStream | undefined
}

/**
 * Serves a contract as newline-delimited JSON-RPC over stdin and stdout.
 *
 * `stdout` carries MCP messages and nothing else -- a stray `console.log`
 * corrupts the stream, which is why diagnostics belong on `stderr`.
 */
export const stdio = <Model, Context_, Principal, ByName, ByTag>(
  options: Omit<HandlerOptions<Model, Context_, Principal, ByName, ByTag>, 'onNotification'> &
    StdioOptions,
): Handler => {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout

  const write = (message: Response | Notification): void => {
    // Messages are newline-delimited and must not contain embedded newlines.
    output.write(`${JSON.stringify(message)}\n`)
  }

  const served = handler({ ...options, onNotification: write })

  let buffer = ''
  input.on('data', (chunk: Buffer | string) => {
    buffer += String(chunk)

    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')

      if (line.length === 0) continue
      void (async () => {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          write({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          } as never)
          return
        }
        const response = await served.handle(parsed)
        if (response !== undefined) write(response)
      })()
    }
  })

  input.on('end', () => served.close())

  return served
}
