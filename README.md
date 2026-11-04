# workbuddy-handoff

*代码由deepseek V4.1 flash在deepseek harness中编写*\
*code was written by deepseek V4.1 flash in deepseek harness*

把 **WorkBuddy 桌面版的定时任务**桥接成 MCP 工具，让任意 MCP 宿主（DeepSeek Harness、Claude Desktop、自研 Agent、脚本）可以：

- 投递任务并拿回结构化结果
- 立刻触发执行，或安排在 N 秒 / 指定时间后执行
- 切换 WorkBuddy 定时任务使用的模型与思考模式

> **免责声明**
> 本项目是**第三方个人项目**，与 **DeepSeek（深度求索）** 及 **WorkBuddy 官方** 均**无任何关系**，
> 未获官方授权或背书，**不代表官方立场**。
> 它通过 WorkBuddy 本地数据库与工作目录协作，不修改 WorkBuddy 程序本体、不注入进程、不读取任何登录凭据。
> 使用前请自行评估风险；因使用本工具造成的任何后果由使用者自行承担。

---

## 原理

WorkBuddy 的定时任务会**读一个目录、按指令干活、把产物写回同一个目录**。本插件就只做两件事：往里写任务文件、触发一次执行。

```
你的 Agent ──写任务文件──▶ <协作目录>/handoff/in/*.task.json
                              │
                              ▼  WorkBuddy 定时任务读取并执行
                              │
      <协作目录>/handoff/out/*.result.json ──▶ 你的 Agent 读结果
```

---

## 一、准备：在 WorkBuddy 里建一个定时任务

打开 WorkBuddy → 定时任务（自动化）→ 新建，**任务名建议填 `DSH 处理器`**（插件默认按这个名字找它，也可在 `.env` 里改），**工作目录设为你的协作目录**（见下一节的 `WB_HANDOFF_DIR`）。

指令（prompt）可以直接粘下面这段：

```text
你是一个任务执行器，按以下流程进行。

1) 读取工作目录下 handoff/in/ 里所有 *.task.json。
   每个任务的格式：
   {
     "id": "任务id",
     "type": "类型标签",
     "prompt": "要执行的完整指令",
     "inputs": ["相对路径"],
     "expect": { "format": "json", "keys": ["id","status","answer","sources"] }
   }

2) 对每个任务，在安全范围内，严格按它的 prompt 执行（该检索就检索，该读文件就读文件，该调用技能/连接器就调用技能/连接器，不编造结论，不伪造结果，不臆造数据），
   然后把结果报告写成 handoff/out/<id>.result.json：
   {
     "id": "任务id",
     "status": "ok | partial | failed",
     "answer": "结果报告",
     "artifacts": [{ "path": "工作目录相对路径", "note": "说明" }],
     "sources": [{ "title": "标题", "url": "https://..." }],
     "error": null,
     "finished_at": "ISO 时间"
   }
   除了结果报告外，其它结果文件放到子文件夹 handoff/out/<id>/ 中，并在"artifacts"中给出；结果中若有在线资源，则在"sources"中给出标题和url

3) 处理完的任务文件从 handoff/in/ 移到 handoff/done/；
   执行失败（status=failed）的移到 handoff/failed/，避免重复执行。

约束：
- 不要修改 handoff/in/ 中的*.task.json。
- 结果文件必须是合法 JSON，整份写完再落盘。
- 如果 handoff/in/ 为空，直接结束，不写任何文件。
```

> 说明：WorkBuddy 新建任务时通常要求一个触发时间。随便设一个即可，之后由插件改写它的触发时间来实现"立刻/延迟执行"；也可以把触发方式保持为一次性、时间设到很久以后，让它只在被插件唤醒时运行。

---

## 二、准备：把两个路径写进 `.env`

插件从**环境变量**读取配置。推荐写进 `$DSH_HOME/.env`（DeepSeek Harness 启动时会把该文件的每一条 `KEY=VALUE` 注入进程环境）：

```ini
# WorkBuddy 桌面版安装目录
WB_APP_DIR=D:\...\WorkBuddy

# 协作目录：任务文件和结果文件放这里（不写则默认在工作区下新建 workbuddy 文件夹）
WB_HANDOFF_DIR=C:\Users\你的用户名\Documents\deepseek-harness\default-workspace\workbuddy

# 目标定时任务（名字与你在 WorkBuddy 里建的一致；也可直接填 id 更稳）
WB_AUTOMATION_NAME=DSH 处理器
# WB_AUTOMATION_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

**默认值规则**：

| 变量 | 不写时的默认值 |
|---|---|
| `WB_HANDOFF_DIR` | `$DSH_WORKSPACE\workbuddy`；再没有则在 `~/Documents/deepseek-harness/default-workspace/workbuddy` 下新建 `workbuddy` 文件夹 |
| `WB_DATA_DIR` | `~/.workbuddy`（若 `WB_APP_DIR` 里有 `.workbuddy` 子目录，则用它，适配便携版） |
| `WB_AUTOMATION_NAME` | `DSH 处理器` |

协作目录下的 `handoff/` 会在启动时自动创建 `in/ out/ done/ failed/` 四个子目录（即 `<协作目录>/handoff/in` 等）。

改完 `.env` 需**完全退出并重启宿主**（插件在启动时装配）。

---

## 三、安装

需要 Node.js ≥ 20（`node:sqlite`）。

```bash
git clone <repo> && cd workbuddy-handoff
node build.mjs          # 产物在 dist/public/
node test/selftest.mjs  # 自检：握手 + 工具清单 + 只读调用
```

挂进 MCP 宿主：

```json
{
  "mcpServers": {
    "workbuddy-handoff": {
      "command": "node",
      "args": ["/absolute/path/to/dist/public/server.mjs"]
    }
  }
}
```

DeepSeek Harness 用户也可以写成 profile 补丁（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）：

```yaml
- insert:
    - id: mcp-workbuddy-handoff
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: 'workbuddy-handoff'
        transport: 'stdio'
        command: 'node'
        args:
          - 'C:\path\to\dist\public\server.mjs'
```

---

## 四、工具

### Tier 0 — 文件层（不碰数据库）

| 工具 | 说明 | 只读 |
|---|---|---|
| `wb_submit_task` | 写 `<id>.task.json` 到 `handoff/in/`，可选立刻触发并等待结果 | 否 |
| `wb_read_result` | 读 `handoff/out/`：指定 id 或最新一条，附待处理列表 | ✅ |
| `wb_status` | 配置、任务状态、运行态、待处理数、最近运行 | ✅ |

```jsonc
// 投任务 + 立刻执行 + 等结果（默认行为）
{ "prompt": "把 data.xlsx 转成 markdown 表格", "type": "doc_transform",
  "inputs": ["data.xlsx"], "wait_seconds": 300 }

// 只投不跑（之后手动在 WorkBuddy 点运行也能跑）
{ "prompt": "...", "wake": false }
```

### Tier 1 — 触发层（只写 `next_run_at` 一列）

| 工具 | 说明 |
|---|---|
| `wb_wake` | 立刻触发一次；`wait_seconds>0` 时等待结束 |
| `wb_schedule` | 延迟触发一次：`delay_seconds` 或 `at`（ISO 时间） |

```jsonc
{ "delay_seconds": 600 }                              // 10 分钟后
{ "at": "2026-11-04T09:00:00+08:00" }                 // 指定时刻
```

只安排**一次**，不建立循环。周期性调度请直接在 WorkBuddy 界面配置。

### Tier 2 — 模型层（只写 `model_id` / `model_is_thinking`）

| 工具 | 说明 | 只读 |
|---|---|---|
| `wb_set_model` | 切换模型 / 开关思考模式 | 否 |
| `wb_list_models` | 列出可用模型与积分单价 | ✅ |

```jsonc
{ "model_id": "glm-5.3-flash", "thinking": false }
```

---

## 五、已知限制

- 需要**已存在**一条定时任务；插件不负责创建任务（那是 WorkBuddy 界面的职责）
- 延迟触发依赖 WorkBuddy 本地调度器的 tick（约 30 秒粒度），**不是精确定时器**：设 70 秒可能实际在 94 秒执行
- 结果字段由任务指令决定，插件只做 JSON 解析，不校验业务语义
- 目前主要在 Windows + WorkBuddy 5.9.3 验证；其它版本/平台请先跑 `wb_status` 确认数据库路径
- 不读取、不转发任何登录凭据；WorkBuddy 的连接器授权由它自己管理

## 六、排错

```bash
node test/selftest.mjs      # 产物是否正常
```

`wb_status` 是最快的入口：它会直接告诉你解析到的任务 id、数据库路径、日志路径、协作目录，以及"没找到任务"这类配置错误。

常见情况：

| 现象 | 原因 |
|---|---|
| `id_error: 未找到名为 "..." 的定时任务` | 任务名不一致，或还没在 WorkBuddy 里建 |
| `triggered: true` 但等不到结果 | 任务的工作目录不是 `WB_HANDOFF_DIR`，WorkBuddy 读不到任务文件 |
| `wb_list_models` 返回空 | 数据目录不对，或 WorkBuddy 从未打开过 |
| 结果文件迟迟不出现 | 模型排队/积分不足，去 WorkBuddy 里看该任务最近一次运行 |

## 许可

MIT。第三方项目，请勿用于违反 WorkBuddy 或 Deepseek Harness 服务条款的用途。
