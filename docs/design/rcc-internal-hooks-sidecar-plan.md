# RCC Internal Hooks Sidecar Work Plan

Status: draft / planning.

## 1. Target

完成 RCC 内部的可选 hooks sidecar daemon binary，替代“把外部 codex-hooks 当作生产框架”的路线。

外部 `codex-hooks` 仓库只作为参考原型，不再作为生产真源。RCC 内部独立 binary 必须实现：

1. 消息处理和转发：接收来自某个 session 的消息，转发到另一个 session。
2. 定时器：接收定时注册；谁注册，到期就发回给谁。
3. Hook 管理：可以挂 handler；收到 hook 消息/状态后调用挂载的 handler，按 handler 结果返回或发消息。
4. 状态机函数：对于 stop 这类 hook 状态机，只作为挂载 hook 被调用，不在框架里内置业务。

这个 binary 是 RCC 启动时的可选部件：

- 启动失败：记录 `hooks_unavailable`，RCC 主服务继续运行。
- 启动成功：作为独立 daemon 起本地控制端口，负责 App Server 通信、转发、timer、hook registry、delivery evidence。
- daemon 崩溃：不影响 RCC 主服务；只影响 hooks/forward/timer。

## 2. Clarified model

```text
RCC main service
  ├── 继续正常服务
  └── 可选启动 rccv3 internal hooks sidecar
        ├── missing/crash/timeout -> hooks_unavailable, 不挂死主服务
        └── ready -> 独立 daemon
              ├── 1. message forward
              │    来自 session A -> 转发到 session B
              ├── 2. timer
              │    谁注册 -> 到期发回给谁
              ├── 3. hook registry
              │    event/state -> handler -> result
              │    handler 决定 send / no-op / error
              └── 4. transport
                    只接 Codex 默认 TUI/Desktop App Server
```

## 3. Non-goals / forbidden

- 不把外部 `codex-hooks` 的 Node daemon 直接注册进 RCC 生产。
- 不自建 App Server，不使用自定义 appserver 替代 Codex 默认 TUI/Desktop App Server。
- 不在 daemon 内硬编码 Stopless 业务、long-horizon 业务、memory 业务。
- 不把 queue acceptance 当作 delivered / replied / ACK。
- 不吞错、不伪造成功、不用 fallback 掩盖 sidecar unavailable。
- 不改 RouteCodex 当前 dirty root；后续实现要使用独立 clean worktree。

## 4. Current baseline

已有参考证据：

- 外部 `codex-hooks` 已证明 TUI/Desktop same-entry hook -> daemon -> codexapp -> native receipt/reply/read 可达。
- TUI 两个 thread 双向 delivery 有 `pass-adapter` 证据，还不是最终 `pass-live` 同入口闭环。
- RouteCodex managed startup 仍是 `pending-live`。

当前判断：

- 参考原型证明基础接口可行，但生产实现必须收敛到 RCC 内部可选 sidecar。
- 当前本机 `~/.codex/routecodex-hooks` 是旧安装副本，不等同于刚 merge 的 `df7e04d`，更不能代表 RCC 内部实现。

## 5. Target component contract

内部 binary 暂定名：`rccv3-hooksd`（最终名称需由 RCC 唯一 owner 确认）。

稳定接口：

```text
register_handler({ handler_id, kind, hook })
unregister_handler({ handler_id })
dispatch_event({ event, state, source_session })
forward_message({ from_session, to_session, body, send_mode })
schedule_upsert({ id, at, target, body, send_mode })
schedule_pause/resume/remove({ id })
session_status({ target })
send_message({ target, body, intent_id })
delivery_evidence({ intent_id, message_id, desired_state })
shutdown({ drain: true })
```

内部约束：

- `session_status` / `send_message` / `delivery_evidence` 只发生在 sidecar transport owner。
- handler 只返回意图，不直接调用 App Server。
- timer 只注册 schedule + target = registrant，不假设业务语义。
- 所有控制状态和业务消息体物理分离。

## 6. Workstreams

### W1: Optional startup lifecycle

实现 RCC 主服务启动时可选拉起 sidecar：

- 缺失 binary：记录 `hooks_unavailable: missing`。
- 启动超时：记录 `hooks_unavailable: timeout`。
- ready：登记能力、target、health。
- sidecar crash：记录 `hooks_unavailable: crashed`，不重启 RCC 主服务。
- shutdown：主服务退出时若有 sidecar，先 drain，再退出。

### W2: Native transport adapter

接入 Codex 默认 App Server：

- TUI: `/Users/fanzhang/.codex/tui-appserver-20260908/app-server-control.sock`
- Desktop: `/Users/fanzhang/.codex/app-server-control/app-server-control.sock`

实现：

- target 注册
- session status 查询
- send message
- thread/read / delivery evidence
- invariant: 不自己实现 App Server。

### W3: Message forward

- 接收 `forward_message`。
- 校验来源 session 与目标 session。
- 调用 session status + send gate。
- 发送到目标 session。
- 记录 accepted -> delivered -> executed -> replied -> read。

### W4: Hook registry

- 支持注册 hook handler。
- 收到 hook event/state：
  - 无 handler：fail closed，不静默 no-op。
  - 有 handler：调用 handler。
  - handler 返回 send intent：进入标准 send path。
  - handler 返回 no-op：普通完成。
  - handler 抛错：保留错误，不吞。

### W5: Timer

- timer 注册保存 `{ id, at, target, body, send_mode }`。
- 到期发送回注册者 target。
- 支持 idle_only / working_allowed。
- 支持 pause / resume / remove。
- timer owner 是 sidecar daemon，不做业务决策。

### W6: Stopless as mounted hook

- Stopless 不作为 daemon 内置状态机。
- stop event/state 进入 hook registry。
- 如果挂载了 Stopless handler，则执行并返回 send/no-op。
- 如果未挂载，按“未注册 handler”处理，不自动恢复旧 Stopless runtime。

### W7: Persistence and recovery

- 持久化: schedules, hook registrations, deliveries, pending intents。
- sidecar 重启：recover outbox，不把 in-flight 当成功。
- 对 unknown delivery 不盲目重试。

## 7. Acceptance gates

每个 phase 必须对应 gate：

```text
1. RCC 主服务 + sidecar missing      -> 主服务 health ok, hooks_unavailable
2. RCC 主服务 + sidecar ready        -> /health ok, sidecar capabilities ok
3. sidecar crash                     -> 主服务 health ok, hooks_unavailable
4. session A -> sidecar -> session B -> native receipt/reply/read evidence
5. timer register -> due -> send back to registrant -> evidence
6. hook handler mount -> event -> handler result -> send/no-op/error
7. working + idle_only               -> deferred
8. working + working_allowed         -> send once
9. duplicate event                   -> one send
10. unknown/disconnected session      -> fail closed
11. restart                           -> unresolved in-flight not claimed success
```

## 8. Recommended sequence

1. 先在 RCC 独立 clean worktree 建立 contract/interface 文档和失败注入测试。
2. 实现 optional startup + `hooks_unavailable`。
3. 实现 native transport adapter。
4. 实现 message forward。
5. 实现 hook registry。
6. 实现 timer。
7. 把 Stopless 作为示例 mounted hook。
8. 跑本地单测、集成测试、live TUI/Desktop replay。
9. 只有用户明确授权后才 push / merge / restart production。

## 9. Open decisions

- RCC 内部 binary 名称：`rccv3-hooksd` 暂定，待 RCC Rust owner 确认。
- sidecar 控制协议：RCC 内部 typed control resource 或 IPC，不放进业务 payload。
- hook handler 编程模型：Rust plugin / dynamic lib / subprocess；先按最小可运行方式设计。

## 10. Out of scope for this plan

- 一次性把外部 codex-hooks 所有代码搬进 RCC。
- 生产 push / merge / restart。
- 恢复旧 Stopless business runtime。
- 在 RouteCodex dirty root 上直接开发。
