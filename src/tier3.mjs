const REQUIRED_COLUMNS = [
  'id', 'name', 'prompt', 'status', 'schedule_type', 'next_run_at', 'cwds', 'rrule',
  'scheduled_at', 'model_id', 'model_is_thinking', 'skills_json', 'push_to_wechat',
  'push_to_wecom_bot', 'owner_user_id', 'owner_status', 'connector_ids_json',
  'permission_mode', 'created_at', 'updated_at', 'reasoning_effort', 'workspace_scope',
]

const MIN_MIGRATION = 16 // workspace_scope 自迁移 0016 起存在

export function tier3Tools() {
  return [
    {
      name: 'wb_create_task',
      description: '在 WorkBuddy 里新建一条定时任务（写入 automations 表）。需要完整 schema：会做列探测与迁移门槛校验。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '任务名（用于查重）' },
          prompt: { type: 'string', description: '任务执行的完整指令' },
          cwds: { type: 'array', items: { type: 'string' }, description: '工作目录，第一个作为运行 cwd' },
          model_id: { type: 'string', description: '模型 id' },
          thinking: { type: 'boolean', description: '思考模式' },
          permission_mode: { type: 'string', description: 'default 或 bypassPermissions' },
          workspace_scope: { type: 'string', description: 'workspace 等' },
          reasoning_effort: { type: 'string', description: 'high / medium / low' },
        },
        required: ['name', 'prompt'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    {
      name: 'wb_ensure_task',
      description: '按 name 查重：已存在则复用并返回现有 id，不存在才创建。幂等版本。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          prompt: { type: 'string' },
          cwds: { type: 'array', items: { type: 'string' } },
          model_id: { type: 'string' },
          permission_mode: { type: 'string' },
        },
        required: ['name', 'prompt'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'wb_records',
      description: '管理运行记录：runs 清运行记录，sessions 清后台会话，all 两者。只作用于目标定时任务。',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['runs', 'sessions', 'all'], description: '默认 runs' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    {
      name: 'wb_probe',
      description: '探测 WorkBuddy 数据库能力：迁移版本、列完整性、可写性，返回 full / unsupported。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  ]
}

export function createTier3Handlers(deps) {
  const { withDb, text } = deps

  function probe() {
    return withDb((db) => {
      const cols = db.prepare('pragma table_info(automations)').all().map((c) => c.name)
      const missing = REQUIRED_COLUMNS.filter((c) => !cols.includes(c))
      const migMax = db.prepare('select max(id) m from __workbuddy_drizzle_migrations').get()?.m ?? 0
      let writable = false
      try { db.prepare('update automations set updated_at=updated_at where 0').run(); writable = true } catch {}
      const mode = !writable || missing.length || migMax < MIN_MIGRATION ? 'unsupported' : 'full'
      return { mode, migration_max: migMax, min_required: MIN_MIGRATION, columns: cols.length, missing, writable }
    })
  }

  function ownerUserId() {
    return withDb((db) => db.prepare('select user_id from sessions order by rowid desc limit 1').get()?.user_id ?? null)
  }

  function findByName(name) {
    return withDb((db) => db.prepare(
      'select id,name,model_id,permission_mode,cwds,next_run_at from automations where name=? and deleted_at is null',
    ).all(name))
  }

  function insertTask(args) {
    const owner = ownerUserId()
    const now = Date.now()
    const id = `${(args.name || 'task').replace(/[^\w\u4e00-\u9fa5-]+/g, '-').slice(0, 24)}-${now.toString(36)}`
    const cwds = JSON.stringify(args.cwds && args.cwds.length ? args.cwds : [])
    withDb((db) => {
      db.prepare(`insert into automations
        (id,name,prompt,status,schedule_type,next_run_at,last_run_at,cwds,rrule,scheduled_at,
         model_id,model_is_thinking,skills_json,push_to_wechat,push_to_wecom_bot,
         owner_user_id,owner_status,connector_ids_json,permission_mode,
         created_at,updated_at,reasoning_effort,workspace_scope)
        values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, args.name, args.prompt, 'ACTIVE', 'once', null, null, cwds, '', null,
        args.model_id || null, args.thinking ? 1 : 0, '[]', 0, 0,
        owner, 'confirmed', '[]', args.permission_mode || 'default',
        now, now, args.reasoning_effort || 'high', args.workspace_scope || 'workspace',
      )
      return db.prepare('select id,name,status,schedule_type,cwds,model_id,permission_mode,next_run_at from automations where id=?').get(id)
    })
    return { id, name: args.name, owner_user_id: owner, cwds: JSON.parse(cwds) }
  }

  return {
    async wb_probe() {
      return text(probe())
    },

    async wb_create_task(args) {
      const p = probe()
      if (p.mode !== 'full') return text({ error: 'target db unsupported', probe: p })
      if (!args.cwds || !args.cwds.length) throw new Error('cwds required (first entry becomes the run cwd)')
      const created = insertTask(args)
      return text({ created, readback: findByName(args.name) })
    },

    async wb_ensure_task(args) {
      const p = probe()
      if (p.mode !== 'full') return text({ error: 'target db unsupported', probe: p })
      const hits = findByName(args.name)
      if (hits.length) return text({ reused: true, matches: hits })
      const created = insertTask(args)
      return text({ reused: false, created, readback: findByName(args.name) })
    },

    async wb_records(args) {
      const scope = args.scope || 'runs'
      const id = deps.automationId()
      if (!id) throw new Error('automation id unresolved')
      return text(withDb((db) => {
        const out = { scope, automation_id: id }
        if (scope === 'runs' || scope === 'all') {
          out.runs = db.prepare('delete from automation_runs where automation_id=?').run(id).changes
          out.runtime = db.prepare('delete from automation_runtime_state where automation_id=?').run(id).changes
        }
        if (scope === 'sessions' || scope === 'all') {
          const bg = db.prepare('select id from sessions where is_background_automation=1').all().map((r) => r.id)
          let n = 0
          for (const s of bg) {
            try { db.prepare('delete from session_usage where session_id=?').run(s) } catch {}
            n += db.prepare('delete from sessions where id=?').run(s).changes
          }
          out.sessions = n
        }
        return out
      }))
    },
  }
}
