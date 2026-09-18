# /goal: RCC Internal Hooks Sidecar

目标：在 RCC 内部实现一个可选独立 hooks sidecar daemon binary，替代把外部 `codex-hooks` 当作生产框架的方案。外部 `codex-hooks` 只作为参考原型。

执行依据：

- 先读 `/Users/fanzhang/Documents/github/codex-hooks/playground/main-integrate-0912/docs/design/rcc-internal-hooks-sidecar-plan.md`
- 先读 `/Users/fanzhang/Documents/github/codex-hooks/playground/main-integrate-0912/docs/design/lifecycle-flowchart.md`

完成条件（done iff）：

1. RCC 主服务启动时尝试启动 sidecar；sidecar missing/timeout/crash 时记录 `hooks_unavailable`，主服务 health 不受影响。
2. sidecar ready 后只通过 Codex 默认 TUI/Desktop App Server 通信，不自建 App Server。
3. 支持 message forward：session A -> sidecar -> session B，保留 native receipt/execution/reply/read 证据。
4. 支持 timer：注册后到期发回注册者 target，支持 `idle_only` / `working_allowed`。
5. 支持 hook registry：hook event/state -> handler -> result；无 handler fail closed；handler error 不吞。
6. Stopless 不作为内置业务；要恢复时作为 mounted hook handler 注册。
7. queue acceptance 不等于 delivered/replied/ACK。
8. 通过验收矩阵和失败注入测试。

禁止：

- 不把外部 codex-hooks daemon 直接搬进 RCC 生产。
- 不改 RouteCodex dirty root；必须在独立 clean worktree 开发。
- 不恢复旧 Stopless business runtime。
- 不 merge/push/restart production，除非用户明确授权。
- 不伪造 live evidence；纯 unit/contract/test 不升级成 live 证据。

执行顺序：

1. 在 RCC 独立 clean worktree 建 contract/interface 和失败注入测试。
2. 实现 optional startup + `hooks_unavailable`。
3. 实现 native transport adapter。
4. 实现 message forward。
5. 实现 hook registry。
6. 实现 timer。
7. 示例 Stopless mounted hook。
8. 跑 unit/contract/gate + TUI/Desktop same-entry live replay。
9. 给出 commit、测试、live evidence 和下一步 merge/push/restart 授权边界。

验收证据：

- `routecodex` 主服务 health ok，sidecar missing 时 `hooks_unavailable: missing`。
- sidecar crash 后主服务仍 health ok。
- TUI/Desktop same-entry live replay 有 `hook -> sidecar -> hook handler -> send -> read` 证据。
- forward 和 timer 的 native receipt/execution/reply/read 记录与 message_id/intent_id 一致。
- 失败路径包含：App Server socket 缺失、session unknown/disconnected、working + `idle_only`、send timeout/uncertain、duplicate event、sidecar restart。

最终交付信号：

- 所有上述验收证据落盘。
- candidate commit 已创建。
- 未 push、未 merge、未重启生产，除非用户随后明确授权。

