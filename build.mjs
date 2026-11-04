#!/usr/bin/env node
/**
 * 构建脚本。
 *
 *   node build.mjs            默认构建（不含 Tier 3）
 *   node build.mjs --full     全量构建（含 Tier 3）
 *
 * 预处理指令（行级，支持嵌套）：
 *   /* #if TIER3 *\/
 *   ...
 *   /* #else *\/
 *   ...
 *   /* #endif *\/
 *
 * 默认构建会把 #if TIER3 分支整段删掉，走 #else 分支（那里只有空实现），
 * 产物里不出现任何 Tier 3 的代码与工具名。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, 'src')

const args = new Set(process.argv.slice(2))
const FULL = args.has('--full') || process.env.WB_TIER3 === '1'

const FLAGS = { TIER3: FULL }

const OPEN_IF = /^\s*\/\*\s*#if\s+([A-Z0-9_]+)\s*\*\/\s*$/
const ELSE = /^\s*\/\*\s*#else\s*\*\/\s*$/
const ENDIF = /^\s*\/\*\s*#endif\s*\*\/\s*$/

export function preprocess(source, flags) {
  const lines = source.split(/\r?\n/)
  const out = []
  // 栈帧：[{ flag, taking, seenElse }]
  const stack = []

  const active = () => stack.every((f) => f.taking)

  for (const line of lines) {
    let m
    if ((m = line.match(OPEN_IF))) {
      const flag = flags[m[1]]
      if (flag === undefined) throw new Error(`unknown build flag: ${m[1]}`)
      stack.push({ flag: Boolean(flag), taking: Boolean(flag), seenElse: false })
      continue
    }
    if (ELSE.test(line)) {
      const top = stack[stack.length - 1]
      if (!top) throw new Error('#else without #if')
      top.seenElse = true
      top.taking = !top.flag
      continue
    }
    if (ENDIF.test(line)) {
      if (!stack.length) throw new Error('#endif without #if')
      stack.pop()
      continue
    }
    if (active()) out.push(line)
  }
  if (stack.length) throw new Error('unterminated #if block')
  return out.join('\n')
}

function emit(targetDir, { withTier3 }) {
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })

  const serverSrc = readFileSync(join(SRC, 'server.mjs'), 'utf8')
  const built = preprocess(serverSrc, FLAGS)
  writeFileSync(join(targetDir, 'server.mjs'), built, 'utf8')

  copyFileSync(join(SRC, 'mcp.mjs'), join(targetDir, 'mcp.mjs'))
  if (withTier3) copyFileSync(join(SRC, 'tier3.mjs'), join(targetDir, 'tier3.mjs'))

  // 公开构建的产物自检：不允许出现 Tier 3 的痕迹
  if (!withTier3) {
    const forbidden = ['wb_create_task', 'wb_ensure_task', 'wb_records', 'wb_probe', 'tier3.mjs', 'TIER3_ENABLED = true']
    const leaked = forbidden.filter((f) => built.includes(f))
    if (leaked.length) throw new Error(`public build leaked tier3 tokens: ${leaked.join(', ')}`)
  }

  const readmeSrc = withTier3 ? join(here, 'README.internal.md') : join(here, 'README.md')
  if (existsSync(readmeSrc)) copyFileSync(readmeSrc, join(targetDir, 'README.md'))

  const lines = built.split('\n').length
  console.log(`✔ ${targetDir}`)
  console.log(`  tier3  : ${withTier3 ? 'ENABLED' : 'disabled'}`)
  console.log(`  server : ${lines} 行, ${Buffer.byteLength(built)} 字节`)
  console.log(`  files  : ${withTier3 ? 'server.mjs mcp.mjs tier3.mjs README.md' : 'server.mjs mcp.mjs README.md'}`)
}

emit(join(here, FULL ? 'dist/full' : 'dist/public'), { withTier3: FULL })

if (!FULL) {
  console.log('\n提示：发布物是 dist/public/ 整个目录。全量构建用 `node build.mjs --full`。')
}
