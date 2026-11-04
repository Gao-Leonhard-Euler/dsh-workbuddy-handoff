#!/usr/bin/env node
/**
 * WorkBuddy 定时任务桥接（MCP server，stdio / newline-delimited JSON-RPC 2.0）
 *
 * 把 WorkBuddy 桌面版的「定时任务」封装成外部可调用的能力：
 *   Tier 0  投任务文件 + 读结果     纯文件系统
 *   Tier 1  立刻触发 / 延迟触发     写 automations.next_run_at 一列
 *   Tier 2  切换模型与思考模式      写 model_id / model_is_thinking 两列
 *   Tier 3  （条件编译，默认不参与构建）
 *
 * 零第三方依赖，只用 Node 内置模块。
 *
 * 配置全部来自环境变量（建议写进 $DSH_HOME/.env，见 README）：
 *   WB_APP_DIR          WorkBuddy 安装目录（可选，用于便携布局探测）
 *   WB_DATA_DIR         WorkBuddy 数据目录（默认 ~/.workbuddy）
 *   WB_HANDOFF_DIR      协作目录（默认 <工作区>/workbuddy，自动创建）
 *   WB_AUTOMATION_ID    目标定时任务 id（优先）
 *   WB_AUTOMATION_NAME  目标定时任务名（默认 "DSH 处理器"，按名解析 id）
 *   WB_DB / WB_LOG / WB_CACHE_DIR  单项覆盖
 *   DSH_WORKSPACE       宿主工作区（用于推导默认协作目录）
 */

import { DatabaseSync } from 'node:sqlite'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync,
  renameSync, unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { PROTOCOL_VERSION, SERVER_INFO, setupStdio } from './mcp.mjs'

/* #if TIER3 */
import { tier3Tools, createTier3Handlers } from './tier3.mjs'
const TIER3_ENABLED = true
/* #else */
const TIER3_ENABLED = false
const tier3Tools = () => []
const createTier3Handlers = () => ({})
/* #endif */

// ---------------------------------------------------------------- config
const APP_DIR = process.env.WB_APP_DIR || ''

function resolveDataDir() {
  if (process.env.WB_DATA_DIR) return process.env.WB_DATA_DIR
  if (APP_DIR && existsSync(join(APP_DIR, '.workbuddy'))) return join(APP_DIR, '.workbuddy')
  return join(homedir(), '.workbuddy')
}

function resolveHandoffDir() {
  if (process.env.WB_HANDOFF_DIR) return process.env.WB_HANDOFF_DIR
  if (process.env.DSH_WORKSPACE) return join(process.env.DSH_WORKSPACE, 'workbuddy')
  return join(homedir(), 'Documents', 'deepseek-harness', 'default-workspace', 'workbuddy')
}

const DATA_DIR = resolveDataDir()
const DB_PATH = process.env.WB_DB || join(DATA_DIR, 'workbuddy.db')
const AUTOMATION_LOG = process.env.WB_LOG || join(DATA_DIR, 'logs', 'automation.log')
const CACHE_DIR = process.env.WB_CACHE_DIR || join(DATA_DIR, 'cache')
const HANDOFF_ROOT = resolveHandoffDir()

const AUTOMATION_ID_ENV = process.env.WB_AUTOMATION_ID || ''
const AUTOMATION_NAME = process.env.WB_AUTOMATION_NAME || 'DSH 处理器'

// 收发区固定在协作目录下的 handoff/ 子目录内，与 WorkBuddy 侧任务指令里的
// 「读取 handoff\in、结果写到 handoff\out」保持一致。
const HANDOFF_SUBDIR = 'handoff'
const DIRS = {
  in: join(HANDOFF_ROOT, HANDOFF_SUBDIR, 'in'),
  out: join(HANDOFF_ROOT, HANDOFF_SUBDIR, 'out'),
  done: join(HANDOFF_ROOT, HANDOFF_SUBDIR, 'done'),
  failed: join(HANDOFF_ROOT, HANDOFF_SUBDIR, 'failed'),
}

// ---------------------------------------------------------------- fs helpers
function ensureDirs() {
  for (const d of Object.values(DIRS)) if (!existsSync(d)) mkdirSync(d, { recursive: true })
}

function listJson(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const p = join(dir, f)
      const st = statSync(p)
      return { file: f, path: p, size: st.size, mtime: isoLocal(st.mtime.getTime()) }
    })
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch (e) {
    return { _parse_error: String(e.message), _raw: readFileSync(p, 'utf8').slice(0, 500) }
  }
}

// ---------------------------------------------------------------- time helpers
/**
 * 本地时区的 ISO 8601（带偏移，如 2026-11-04T13:37:09+08:00）。
 *
 * 统一用它，而不是 `toISOString()`：WorkBuddy 写回的结果里 `finished_at` 用本地偏移，
 * 我们若在 task.json / schedule 响应里写 UTC（...Z），同一个协作目录里就混着两种时区，
 * 人和脚本都得自己做二次换算。epoch 毫秒字段（*_ms / next_run_at）保持原样不动。
 */
function isoLocal(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  const offMin = -d.getTimezoneOffset()
  const sign = offMin >= 0 ? '+' : '-'
  const abs = Math.abs(offMin)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
}

/** 文件名安全的时间戳：20261104-133709。 */
function stampLocal(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 单次工具调用最多等多久：受 dsh-mcp-client 的 toolCallTimeoutMs（默认 60s）约束。 */
const WAIT_MAX_SECONDS = 240

function waitSeconds(value, fallback) {
  const raw = value === undefined || value === null ? fallback : Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(Math.floor(raw), WAIT_MAX_SECONDS)
}

/** 把文件挪进目录；目标已存在时退化为「写入再删除」，避免 rename 在 Windows 上失败。 */
function moveInto(path, dir) {
  mkdirSync(dir, { recursive: true })
  const target = join(dir, basenameOf(path))
  try {
    if (existsSync(target)) {
      writeFileSync(target, readFileSync(path))
      unlinkSync(path)
    } else {
      renameSync(path, target)
    }
    return target
  } catch {
    return null
  }
}

function basenameOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? p : p.slice(i + 1)
}

// ---------------------------------------------------------------- db helpers
function withDb(fn) {
  const db = new DatabaseSync(DB_PATH)
  try { return fn(db) } finally { db.close() }
}

let cachedId = AUTOMATION_ID_ENV || null
let idResolveError = null

/** 目标定时任务 id：显式配置优先，否则按名字解析并缓存。 */
function automationId() {
  if (cachedId) return cachedId
  try {
    const row = withDb((db) => {
      try {
        return db.prepare(
          'select id from automations where name=? and deleted_at is null order by rowid desc limit 1',
        ).get(AUTOMATION_NAME)
      } catch {
        return db.prepare(
          'select id from automations where name=? order by rowid desc limit 1',
        ).get(AUTOMATION_NAME)
      }
    })
    if (row?.id) { cachedId = row.id; return cachedId }
    idResolveError = `未找到名为 "${AUTOMATION_NAME}" 的定时任务；请在 WorkBuddy 里创建，或设置 WB_AUTOMATION_ID`
  } catch (e) {
    idResolveError = `解析任务 id 失败: ${String(e.message)}`
  }
  return null
}

function getAutomation() {
  const id = automationId()
  if (!id) return null
  return withDb((db) => db.prepare(`select id,name,status,schedule_type,next_run_at,last_run_at,
    scheduled_at,rrule,cwds,model_id,model_is_thinking,permission_mode,workspace_scope,
    reasoning_effort,connector_ids_json,skills_json,updated_at
    from automations where id=?`).get(id)) || null
}

function getRuntime() {
  const id = automationId()
  if (!id) return null
  return withDb((db) => db.prepare(
    'select * from automation_runtime_state where automation_id=?',
  ).get(id)) || null
}

function recentRuns(limit = 5) {
  const id = automationId()
  if (!id) return []
  return withDb((db) => db.prepare(`select automation_id,status,failure_code,reason_code,
    thread_title,created_at,updated_at from automation_runs
    where automation_id=? order by rowid desc limit ?`).all(id, limit))
}

function setAutomation(patch) {
  const id = automationId()
  if (!id) throw new Error(idResolveError || 'automation id unresolved')
  const allowed = new Set(['model_id', 'model_is_thinking', 'next_run_at', 'updated_at'])
  const cols = Object.keys(patch).filter((k) => allowed.has(k))
  if (!cols.length) throw new Error('no writable field provided')
  const sql = `update automations set ${cols.map((c) => `${c}=?`).join(', ')}, updated_at=? where id=?`
  return withDb((db) => {
    db.prepare(sql).run(...cols.map((c) => patch[c]), Date.now(), id)
    return db.prepare(`select id,status,schedule_type,next_run_at,last_run_at,
      model_id,model_is_thinking,scheduled_at,rrule,updated_at
      from automations where id=?`).get(id)
  })
}

// ---------------------------------------------------------------- run watching
function tailFrom(offset) {
  if (!existsSync(AUTOMATION_LOG)) return { text: '', offset }
  const size = statSync(AUTOMATION_LOG).size
  const start = offset > size ? 0 : offset
  const buf = readFileSync(AUTOMATION_LOG)
  return { text: buf.slice(start).toString('utf8'), offset: size }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForRun({ timeoutSeconds = 240 } = {}) {
  const id = automationId()
  const started = Date.now()
  let offset = existsSync(AUTOMATION_LOG) ? statSync(AUTOMATION_LOG).size : 0
  const deadline = started + timeoutSeconds * 1000
  let sawStart = false
  let finished = null
  const log = []
  while (Date.now() < deadline) {
    await sleep(2000)
    const { text, offset: next } = tailFrom(offset)
    offset = next
    for (const line of text.split('\n')) {
      if (!id || !line.includes(id)) continue
      if (line.includes('run start:')) { sawStart = true; log.push(line.trim()) }
      if (line.includes('run finished:')) { finished = line.trim(); log.push(line.trim()) }
    }
    if (finished) break
    if (sawStart) {
      const rt = getRuntime()
      if (rt && rt.running === 0) { finished = 'runtime.running=0'; break }
    }
  }
  return { triggered: sawStart, finished: Boolean(finished), finishedAt: finished, waitedMs: Date.now() - started, log: log.slice(-6) }
}

// ---------------------------------------------------------------- models
function listModels() {
  if (!existsSync(CACHE_DIR)) return { models: [], note: `cache dir not found: ${CACHE_DIR}` }
  const files = readdirSync(CACHE_DIR).filter((f) => /^acc-product-config-v3-.*\.json$/.test(f))
  if (!files.length) return { models: [], note: 'no acc-product-config cache' }
  const target = files
    .map((f) => ({ f, size: statSync(join(CACHE_DIR, f)).size }))
    .sort((a, b) => b.size - a.size)[0].f
  const j = JSON.parse(readFileSync(join(CACHE_DIR, target), 'utf8'))
  const craft = new Set()
  const defs = new Map()
  const walk = (o) => {
    if (!o || typeof o !== 'object') return
    if (Array.isArray(o)) { o.forEach(walk); return }
    if (Array.isArray(o.modelTags) && Array.isArray(o.models) && o.modelTags.includes('craft')) {
      o.models.forEach((m) => craft.add(m))
    }
    if (o.id && o.name && ('credits' in o || 'maxInputTokens' in o)) {
      if (!defs.has(o.id)) {
        defs.set(o.id, { id: o.id, name: o.name, vendor: o.vendor, credits: o.credits, supports_tool_call: o.supportsToolCall })
      }
    }
    for (const v of Object.values(o)) walk(v)
  }
  walk(j)
  return { source: target, models: [...craft].map((id) => defs.get(id) || { id, name: id }) }
}

// ---------------------------------------------------------------- tools
const TOOL_STATUS = {
  name: 'wb_status',
  description: '查看 WorkBuddy 定时任务状态：配置、模型、运行态、待处理任务、最近运行记录。纯只读。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
}

const TOOL_SUBMIT = {
  name: 'wb_submit_task',
  description: '把任务写进协作目录 in/（<id>.task.json），可选立刻触发执行并等待结果。',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '交给 WorkBuddy 的完整指令（自包含，不复用上下文）' },
      id: { type: 'string', description: '任务 id，缺省按时间戳生成' },
      type: { type: 'string', description: '任务类型标签，如 doc_transform' },
      inputs: { type: 'array', items: { type: 'string' }, description: '协作目录内的相对路径' },
      expect_keys: { type: 'array', items: { type: 'string' }, description: '结果必需字段，默认 id/status/answer/sources' },
      wake: { type: 'boolean', description: '写完后是否立刻触发，默认 true' },
      wait_seconds: { type: 'number', description: 'wake=true 时最多等待秒数，默认 240；上限 240（受客户端 toolCallTimeoutMs 约束）' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}

const TOOL_READ = {
  name: 'wb_read_result',
  description: '读取 out/ 里的结果：指定 id 读单个，缺省读最新的；同时返回待处理任务列表。'
    + '指定 id 时默认把该结果归档到 done/（archive:false 可关闭），归档后仍可用同一个 id 重读。',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '任务 id（不含扩展名）' },
      archive: { type: 'boolean', description: '读完是否移动到 done/；指定 id 时默认 true，读最新时默认 false' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}

const TOOL_WAKE = {
  name: 'wb_wake',
  description: '立刻触发一次执行（不改任务内容）。可等待运行结束。',
  inputSchema: {
    type: 'object',
    properties: { wait_seconds: { type: 'number', description: '0 = 只触发不等待（默认）；>0 = 等待结束，上限 240' } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}

const TOOL_SCHEDULE = {
  name: 'wb_schedule',
  description: '安排一次延迟执行：delay_seconds（多少秒后）或 at（ISO 时间）。只安排一次，不建立循环。',
  inputSchema: {
    type: 'object',
    properties: {
      delay_seconds: { type: 'number', description: '多少秒后执行，例如 600 = 10 分钟后' },
      at: { type: 'string', description: 'ISO 时间点，例如 2026-11-03T20:00:00+08:00' },
      wait_seconds: { type: 'number', description: '>0 时在触发后等待运行结束，上限 240' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}

const TOOL_SET_MODEL = {
  name: 'wb_set_model',
  description: '修改 WorkBuddy 定时任务使用的模型与思考模式。不传 model_id 则只改思考模式。',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string', description: '模型 id，可用 wb_list_models 查询' },
      thinking: { type: 'boolean', description: '是否开启思考模式' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}

const TOOL_LIST_MODELS = {
  name: 'wb_list_models',
  description: '列出 WorkBuddy 可用模型及其积分单价（来自本地产品配置缓存）。纯只读。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
}

const TOOLS = [
  TOOL_STATUS, TOOL_SUBMIT, TOOL_READ,
  TOOL_WAKE, TOOL_SCHEDULE,
  TOOL_SET_MODEL, TOOL_LIST_MODELS,
  ...tier3Tools(),
]

function text(payload) {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] }
}

const HANDLERS = {
  // Tier 0
  async wb_status() {
    ensureDirs()
    const id = automationId()
    return text({
      config: {
        app_dir: APP_DIR || null,
        app_dir_exists: APP_DIR ? existsSync(APP_DIR) : null,
        data_dir: DATA_DIR,
        db: DB_PATH,
        log: AUTOMATION_LOG,
        handoff: HANDOFF_ROOT,
        automation_id: id,
        automation_name: AUTOMATION_NAME,
        id_error: id ? null : idResolveError,
      },
      automation: getAutomation(),
      runtime: getRuntime(),
      pending_tasks: listJson(DIRS.in).map((f) => f.file),
      results: listJson(DIRS.out).slice(0, 5).map((f) => ({ file: f.file, mtime: f.mtime })),
      recent_runs: recentRuns(5),
    })
  },

  async wb_submit_task(args) {
    ensureDirs()
    const id = args.id || `task-${stampLocal()}`
    const task = {
      id,
      type: args.type || 'question',
      prompt: args.prompt,
      inputs: args.inputs || [],
      expect: { format: 'json', keys: args.expect_keys || ['id', 'status', 'answer', 'sources'] },
      created_at: isoLocal(),
      producer: 'mcp',
    }
    const path = join(DIRS.in, `${id}.task.json`)
    writeFileSync(path, JSON.stringify(task, null, 2) + '\n', 'utf8')
    const out = { task_id: id, task_path: path, created_at: task.created_at, triggered: false }
    if (args.wake !== false) {
      const at = Date.now()
      setAutomation({ next_run_at: at })
      out.triggered = true
      out.next_run_at = at
      out.next_run_iso = isoLocal(at)
      const wait = waitSeconds(args.wait_seconds, 240)
      if (wait > 0) out.run = await waitForRun({ timeoutSeconds: wait })
      const resultPath = join(DIRS.out, `${id}.result.json`)
      if (existsSync(resultPath)) {
        out.result = readJson(resultPath)
        if (out.run?.finished) {
          const archived = moveInto(resultPath, DIRS.done)
          out.archived_to = archived
        }
      } else {
        out.result_pending = true
      }
    }
    return text(out)
  },

  async wb_read_result(args) {
    ensureDirs()
    const pending = () => listJson(DIRS.in).map((f) => f.file)
    if (args.id) {
      const name = `${args.id}.result.json`
      const inOut = join(DIRS.out, name)
      const inDone = join(DIRS.done, name)
      const fromOut = existsSync(inOut)
      const source = fromOut ? inOut : (existsSync(inDone) ? inDone : null)
      if (!source) {
        return text({
          error: `not found: ${name}`,
          searched: [DIRS.out, DIRS.done],
          available: [...listJson(DIRS.out), ...listJson(DIRS.done)].map((o) => o.file),
          pending_tasks: pending(),
        })
      }
      const result = readJson(source)
      const shouldArchive = args.archive === undefined ? true : Boolean(args.archive)
      const archivedTo = fromOut && shouldArchive ? moveInto(inOut, DIRS.done) : null
      return text({ result, file: source, archived_to: archivedTo, pending_tasks: pending() })
    }

    const outs = listJson(DIRS.out)
    if (!outs.length) {
      return text({
        results: [],
        archived: listJson(DIRS.done).map((o) => o.file),
        pending_tasks: pending(),
        note: 'out/ 为空',
      })
    }
    const latest = outs[0]
    const result = readJson(latest.path)
    const archivedTo = args.archive === true ? moveInto(latest.path, DIRS.done) : null
    return text({
      latest: latest.file,
      result,
      archived_to: archivedTo,
      all: outs.map((o) => ({ file: o.file, mtime: o.mtime, size: o.size })),
      pending_tasks: pending(),
    })
  },

  // Tier 1
  async wb_wake(args) {
    const at = Date.now()
    setAutomation({ next_run_at: at })
    const res = { next_run_at: at, next_run_iso: isoLocal(at) }
    const wait = waitSeconds(args.wait_seconds, 0)
    if (wait > 0) res.run = await waitForRun({ timeoutSeconds: wait })
    return text(res)
  },

  async wb_schedule(args) {
    let at
    if (args.at) {
      const t = new Date(args.at).getTime()
      if (Number.isNaN(t)) throw new Error(`invalid at: ${args.at}`)
      at = t
    } else if (typeof args.delay_seconds === 'number') {
      at = Date.now() + Math.max(0, args.delay_seconds) * 1000
    } else {
      throw new Error('need delay_seconds or at')
    }
    setAutomation({ next_run_at: at })
    const res = {
      scheduled_at_ms: at,
      scheduled_at_iso: isoLocal(at),
      in_seconds: Math.round((at - Date.now()) / 1000),
      note: '一次性安排；期间再次触发或改写会被覆盖',
    }
    const wait = waitSeconds(args.wait_seconds, 0)
    if (wait > 0) res.run = await waitForRun({ timeoutSeconds: wait })
    return text(res)
  },

  // Tier 2
  async wb_set_model(args) {
    const patch = {}
    if (args.model_id) patch.model_id = args.model_id
    if (args.thinking !== undefined) patch.model_is_thinking = args.thinking ? 1 : 0
    if (!Object.keys(patch).length) throw new Error('need model_id and/or thinking')
    return text({ updated: patch, automation: setAutomation(patch) })
  },

  async wb_list_models() {
    const r = listModels()
    return text({ ...r, current: getAutomation()?.model_id ?? null })
  },

  // Tier 3（条件编译）
  ...createTier3Handlers({
    withDb, getAutomation, setAutomation, automationId, listJson, readJson, ensureDirs, text,
    DB_PATH, HANDOFF_ROOT, DIRS,
  }),
}

setupStdio({
  serverInfo: SERVER_INFO,
  protocolVersion: PROTOCOL_VERSION,
  tools: TOOLS,
  handlers: HANDLERS,
  capabilities: { tools: { listChanged: false } },
  name: 'workbuddy-handoff',
  version: '1.0.0',
  tier3: TIER3_ENABLED,
})
