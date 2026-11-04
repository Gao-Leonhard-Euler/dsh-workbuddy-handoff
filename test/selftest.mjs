#!/usr/bin/env node
/**
 * 自测：对任意构建产物跑一遍 MCP 握手 + 工具清单 + 只读调用。
 *
 *   node test/selftest.mjs                       # 测 dist/public
 *   node test/selftest.mjs dist/full/server.mjs  # 测全量构建
 */

import { spawn } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const target = process.argv[2] ? resolve(process.argv[2]) : join(root, 'dist', 'public', 'server.mjs')

if (!existsSync(target)) {
  console.error(`missing build output: ${target}\n先跑 node build.mjs${target.includes('full') ? ' --full' : ''}`)
  process.exit(2)
}

const child = spawn(process.execPath, [target], { stdio: ['pipe', 'pipe', 'inherit'] })
let seq = 0
const pending = new Map()
let buf = ''

child.stdout.setEncoding('utf8')
child.stdout.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
})

function rpc(method, params) {
  const id = ++seq
  return new Promise((resolve_, reject) => {
    pending.set(id, resolve_)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)) } }, 20000)
  })
}

const call = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args })
  if (r.error) return { error: r.error }
  const t = r.result?.content?.[0]?.text
  try { return JSON.parse(t) } catch { return t }
}

const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } })
console.log(`server   : ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`)
console.log(`protocol : ${init.result?.protocolVersion}`)

const list = await rpc('tools/list', {})
const names = list.result.tools.map((t) => t.name)
console.log(`tools(${names.length}) : ${names.join(', ')}`)

const tier3 = ['wb_create_task', 'wb_ensure_task', 'wb_records', 'wb_probe']
const present = tier3.filter((n) => names.includes(n))
console.log(`tier3    : ${present.length ? `PRESENT (${present.join(', ')})` : 'absent'}`)

const status = await call('wb_status')
console.log('\nwb_status:')
console.log('  automation:', JSON.stringify({
  name: status.automation?.name,
  model: status.automation?.model_id,
  next_run_at: status.automation?.next_run_at,
  schedule_type: status.automation?.schedule_type,
}))
console.log('  pending:', status.pending_tasks?.length ?? 0, '| results:', status.results?.length ?? 0)

const models = await call('wb_list_models')
console.log(`\nwb_list_models: current=${models.current} count=${models.models?.length ?? 0}`)

const read = await call('wb_read_result')
console.log(`wb_read_result: ${read.note || read.latest || '(ok)'}`)

// 只读探测（若构建里含 Tier 3）
if (present.includes('wb_probe')) {
  const probe = await call('wb_probe')
  console.log(`wb_probe: mode=${probe.mode} migration=${probe.migration_max} missing=${JSON.stringify(probe.missing)}`)
}

const failed = names.length === 0
child.stdin.end()
setTimeout(() => process.exit(failed ? 1 : 0), 200)
