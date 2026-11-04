/**
 * 极简 MCP stdio 框架（newline-delimited JSON-RPC 2.0）。
 * 抽出这一层，让 server.mjs 只关心工具，不关心协议。
 */

export const PROTOCOL_VERSION = '2024-11-05'
export const SERVER_INFO = { name: 'workbuddy-handoff', version: '1.0.0' }

export function setupStdio({ tools, handlers, serverInfo, protocolVersion, capabilities, name, version, tier3 }) {
  const info = { ...(serverInfo || {}), ...(name ? { name } : {}), ...(version ? { version } : {}) }

  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

  async function handle(msg) {
    const { id, method, params } = msg
    const respond = (result) => send({ jsonrpc: '2.0', id, result })
    const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

    try {
      switch (method) {
        case 'initialize':
          return respond({
            protocolVersion: protocolVersion || PROTOCOL_VERSION,
            capabilities: capabilities || { tools: { listChanged: false } },
            serverInfo: info,
          })
        case 'notifications/initialized':
        case 'initialized':
          return
        case 'ping':
          return respond({})
        case 'tools/list':
          return respond({ tools })
        case 'tools/call': {
          const toolName = params?.name
          const fn = handlers[toolName]
          if (!fn) return fail(-32601, `unknown tool: ${toolName}`)
          return respond(await fn(params?.arguments || {}))
        }
        default:
          if (id === undefined) return
          return fail(-32601, `unknown method: ${method}`)
      }
    } catch (e) {
      if (id === undefined) return
      return fail(-32000, String(e?.message || e))
    }
  }

  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      handle(msg)
    }
  })
  process.stdin.on('end', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))

  if (tier3 !== undefined) process.stderr.write(`[workbuddy-handoff] ready (tier3=${tier3})\n`)
}
