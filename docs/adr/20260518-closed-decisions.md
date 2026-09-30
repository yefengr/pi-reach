# 已关闭决策

本文件是已关闭的产品与架构决策记录，不是可执行方案。没有充分证据证明某项决策有误时，不重新讨论；需要改变方向时，作为明确任务提出，不在实现中静默推翻。

## 当前覆盖 — ADR-20260914

自 2026-09-14 起，[纯 Extension 运行时 ADR](20260914-pure-extension-runtime.md) 覆盖下方记录中关于常驻 daemon/supervisor、RPC child、Cron、独立 CLI、PWA 启动或唤醒 Pi 的当前性表述。现行链路是 `PWA ↔ Relay ↔ 用户当前打开且加载 Extension 的 Pi`：Extension 在 `session_start` 自动连接，device pairing/ACL 持久，普通 Pi 进程生成新的 endpoint/runtime，Relay 只维护实时 registry，PWA 本地保存正式 timeline。新发送端只写 `kind=interactive`；旧 `daemon` 仅为 Relay/Protocol/PWA decoder 的滚动读取兼容，不代表产品模式。

## 当前覆盖 — ADR-20260927

自 2026-09-27 起，[本轮结束事件 ADR](20260927-run-end-event.md) 修订下方「Protocol v2 inner schema」的冻结范围：TimelineEvent 新增 `kind: "run_end"`，endpoint metadata 的 `working` 改为按整次运行（`agent_start`／`agent_end`）计算；`protocol_version` 仍为 2，发布须先部署 PWA 再发布 Extension。

## 当前覆盖 — ADR-20260930

[严格运行结束 ADR](20260930-strict-run-completion.md) 覆盖 ADR-20260927 中缺少 `run_end` 时的降级规则：实时与历史只以正式 `run_end` 确认该轮结束，不再根据 Pi 空闲或下一轮开始推断；事件 shape 与协议版本不变。

本块是当前决策入口；下方各节记录仍然有效的已关闭决策。

---

## 定位

| 决策 | 原因 / 说明 |
|---|---|
| **只面向 Pi coding agent** | Pi 提供公开的 Extension API 与 SDK。Pi Reach 专注 Pi，不做多 harness 适配。 |
| **Extension 而非 wrapper** | Pi Reach 以 TypeScript 运行时 Extension 的形式运行在 Pi 进程内，不包装或替换 Pi 的 CLI。 |

## 架构

| 决策 | 原因 / 说明 |
|---|---|
| **不提供常驻 daemon** | 只有当前打开并加载 Extension 的 Pi 可以被远程控制；Pi 退出后 PWA 显示离线。详见 ADR-20260914。 |
| **Relay 无持久化** | Relay 只在内存中维护实时连接、endpoint、ACL 与短期 pairing offer，不保存会话内容。 |
| **Relay 开源且可自托管** | 用户可以部署自己的 Relay；公共 Relay 不是唯一选择，也不是必须信任的单点。 |

## 配对与身份

| 决策 | 原因 / 说明 |
|---|---|
| **持久配对** | 配对一次，之后自动重连。电脑端保存在 `~/.pi/pi-reach`（身份优先存入系统钥匙串），浏览器端保存在 IndexedDB。不做按会话或一次性配对。 |
| **不设账号** | 配对只依赖二维码或配对码。账号、多设备同步和身份恢复留待真实需求出现后评估，见「待定」。 |
| **配对码短期有效、只能使用一次** | 缩短截图或拍照泄露的风险窗口。 |
| **身份即公钥** | 不使用用户名；连接 Relay 时通过 Ed25519 challenge-response 证明持有私钥。 |
| **配对持续到撤销** | 在 Pi 中用 `/pi-reach revoke <shortid>`（Owner 公钥前 8 位）撤销；浏览器端可删除本地配对。 |
| **只在本地重命名配对** | 配对名称只保存在当前浏览器，不同步到电脑或其他浏览器。 |

## 多实例

| 决策 | 原因 / 说明 |
|---|---|
| **一个浏览器可配对多台电脑** | 每台电脑独立配对，互不影响。 |
| **同一 Owner 可多端同时在线** | 同一 Owner 的多个连接可以并存，并都能收到电脑端的回复。 |
| **同一目录的多个 Pi 相互独立** | 每个 Pi 进程是独立的 endpoint，不按 cwd 合并。 |

## 安全与运维

| 决策 | 原因 / 说明 |
|---|---|
| **不做推送通知** | 当前不承诺 Web Push；打开 PWA 时按需重连。 |
| **不做工具调用审批** | 工具调用由 Pi 直接执行。Pi SDK 没有按工具声明审批需求的原生字段，硬编码的审批规则会误伤自定义工具；Pi 生态统一权限模型后再评估。协议保留 `approve_tool` frame，Extension 目前返回 `unsupported_type`。 |
| **不做应用层端到端加密** | 当前只依赖 TLS 与 Ed25519 身份认证，Relay 运营方可以看到消息内容。需要保护内容的用户应自托管 Relay。 |
| **Relay 不解析 `ct`** | `ct` 是 Protocol v2 JSON 的 Base64，Relay 不解码、不记录、不持久化。外层信封保持不变，将来只需替换 `ct` 的生成与解析即可启用加密。 |
| **TLS 必需** | 在端到端加密恢复前，TLS 是防御外部中间人攻击的唯一一层。 |

## 威胁模型：不防护的范围

- **电脑被攻陷**：攻击者等同于 Pi 本身。
- **浏览器或手机被攻陷**：攻击者可以取得 Owner 身份。
- **通过 PWA 发出的恶意指令**：Pi 会照常执行。
- **流量分析与 Relay 运营方**：Relay 可以看到连接时间、消息大小以及全部消息内容。缓解方式是自托管 Relay。

## 协议

| 决策 | 原因 / 说明 |
|---|---|
| **Protocol v2 inner schema**（2026-08-25） | 所有 PWA↔Extension inner frame 必须携带 `protocol_version: 2`，不提供 v1 回退、双读双写或降级。strict runtime schema、direct/broadcast routing、临时 `channel_id` 与正式 TimelineEvent 由 v2 schema 冻结；Relay 不解析 inner payload。 |

## 待定

以下事项有意推迟。需要决定时，作为明确讨论提出。

| 事项 | 何时决定 |
|---|---|
| 可选的用户账号 | 出现多设备痛点时 |
| 推送通知 | 核心体验验证之后 |
| 多 Relay / 联邦 | 大概率不做；只有公共 Relay 成为瓶颈时再考虑 |
| 恢复应用层端到端加密 | 先具备回环测试与线上抓包等调试工具 |

## 如何更新本文件

- **新关闭的决策**：在对应小节追加一行。
- **推翻的决策**：不直接删除原行；用删除线（`~~文本~~`）标记，并在下方追加新决策、日期与原因。
- **推迟的决策**：放入「待定」。
- 不在实现过程中静默修改本文件；决策应来自明确的讨论。
