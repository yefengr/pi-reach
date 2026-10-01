# Pi Reach Protocol v2

本文件是 Relay、Pi Extension 与 Browser/PWA 的当前跨端协议真源。实现必须以 strict schema 拒绝未知字段、错误方向和错误版本；不存在 v1 fallback、双读、自动降级或旧 room/mesh 路由。

新 Extension 只发送 `metadata.kind = interactive`。Relay 与 PWA decoder 暂时接受旧 `daemon` metadata，仅用于滚动读取；它不是 daemon 生命周期、后台进程或稳定 endpoint 的承诺。决策与退出条件见[纯 Extension ADR](../../adr/20260914-pure-extension-runtime.md)。

共享 machine-readable 样例位于 `fixtures/v2/manifest.json`。产品和安全说明见[协议与安全总览](README.md)，pairing 外层控制与 inner frame 见[pairing contract](pairing.md)。

## 身份与生命周期

```text
device_id
  └─ endpoint_id
       ├─ runtime_instance_id
       └─ session_id + leaf_id
```

| 字段 | 语义 | 生命周期 |
| --- | --- | --- |
| `owner_id` | Browser/PWA Owner 的 canonical Ed25519 公钥（Base64 STANDARD） | PWA 本地 identity 存在期间稳定 |
| `device_id` | Host 电脑的 canonical Ed25519 公钥（Base64 STANDARD） | device identity 存在期间稳定 |
| `endpoint_id` | opaque UUID；一个当前可路由 Pi 入口 | 每个普通 Pi 进程启动时生成；同一进程 reload 保持 |
| `runtime_instance_id` | opaque UUID；endpoint 当前 Pi runtime | 与普通 Pi 进程一起生成；同一进程 reload 保持 |
| `session_id` | Pi `SessionManager` 当前会话 | `/new` 或打开其他 Pi session 时变化 |
| `leaf_id` | Pi 当前 branch 的移动 tip，可为 `null` | 普通追加和 branch 变化时推进；空/root session 可为 `null` |
| `channel_id` | 一个 Owner 进入 endpoint 后的临时响应通道 | 当前实时连接/绑定 |

`cwd`、名称、PID、model、thinking、working 仅为 metadata。`/new` 保持 endpoint/runtime，只替换 session；普通追加只推进 `leaf_id`。Pi Reach 不远程维护完整 Pi session tree，只有 `reset(reason=branch_changed)` 建立当前 session 投影的 branch replacement 边界。正式 timeline key 是：

```text
device_id + endpoint_id + session_id
```

`leaf_id` 是当前 branch tip 元数据，不进入持久主键；`runtime_instance_id` 只用于实时 stale gate。

## Relay 认证与 endpoint metadata

所有 WebSocket 客户端先发送 role-aware `hello`，然后完成 Ed25519 challenge-response。

### Host hello

```json
{
  "type": "hello",
  "protocol_version": 2,
  "role": "host",
  "pubkey": "<device_id>",
  "endpoint_id": "<UUID>",
  "runtime_instance_id": "<UUID>",
  "metadata": {
    "kind": "interactive",
    "name": "project",
    "cwd": "/absolute/path",
    "pid": 123,
    "started_at": 1788010000000,
    "model": "provider/model",
    "thinking": "high",
    "working": false
  },
  "authorized_owner_ids": ["<owner_id>"]
}
```

`metadata.kind` 的当前写入值只能是 `interactive`。在兼容窗口内，Relay/PWA strict decoder 仍接受 `daemon | interactive`；其他 metadata 字段可省略。Host `pubkey` 必须等于 challenge-response 实际认证身份。

`metadata.working` 按整次运行计算：Pi `agent_start` 时为 `true`，`agent_end` 时为 `false`，一次运行内多次模型调用之间不变（[ADR-20260927](../../adr/20260927-run-end-event.md)）。

### Owner hello

```json
{
  "type": "hello",
  "protocol_version": 2,
  "role": "owner",
  "pubkey": "<owner_id>"
}
```

Owner hello 不得携带 endpoint、runtime、metadata 或授权列表。

### Challenge-response

```json
{ "type": "challenge", "nonce": "<Base64 STANDARD random bytes>" }
{ "type": "auth", "sig": "<Base64 STANDARD Ed25519 signature>" }
```

认证失败、身份与 hello 不一致、未知字段或 `protocol_version != 2` 都关闭连接。

## Relay control frames

### Owner -> Relay

```json
{ "type": "subscribe_endpoints", "device_ids": ["<device_id>"] }
```

订阅会替换该 Owner connection 的当前 device 集合。Relay 只返回 Host ACL 中包含该 Owner 的当前在线 endpoint。

配对码解析使用：

```json
{ "type": "resolve_pairing_code", "request_id": "<id>", "code": "K7MP4Q2D" }
```

成功时 Relay 返回 `pairing_target`，失败时返回 `pairing_code_error`。完整 flow 和失败原因由[pairing contract](pairing.md)定义。

### Host -> Relay

```json
{
  "type": "endpoint_update",
  "metadata": { "kind": "interactive", "working": true },
  "authorized_owner_ids": ["<owner_id>"]
}
```

Host 在 `/pi-reach pair` 后发布短期 target：

```json
{
  "type": "pairing_offer",
  "code": "K7MP4Q2D",
  "endpoint_id": "<UUID>",
  "runtime_instance_id": "<UUID>",
  "expires_at": 1788010000000
}
```

`metadata` 与 `authorized_owner_ids` 至少存在一个。Host 只能更新当前权威 endpoint connection；旧 runtime 的 update 或 pairing offer 被拒绝。

### Relay -> Owner

Owner 认证并注册成功后，Relay 通过当前连接发送一次自身版本；Host 不接收该帧：

```json
{ "type": "relay_info", "version": "<Relay package version>" }
```

`version` 为 1–256 字符的非空字符串，只允许上述两个字段。版本在 Relay 进程加载时固定，不改变 challenge-response、订阅或路由流程。

Snapshot：

```json
{
  "type": "endpoints",
  "device_id": "<device_id>",
  "endpoints": [
    {
      "endpoint_id": "<UUID>",
      "runtime_instance_id": "<UUID>",
      "metadata": { "kind": "interactive", "cwd": "/repo", "working": false }
    }
  ]
}
```

增量事件：

```json
{ "type": "endpoint_announced", "device_id": "<device_id>", "endpoint_id": "<UUID>", "runtime_instance_id": "<UUID>", "metadata": { "kind": "interactive" } }
{ "type": "endpoint_updated",   "device_id": "<device_id>", "endpoint_id": "<UUID>", "runtime_instance_id": "<UUID>", "metadata": { "kind": "interactive" } }
{ "type": "endpoint_ended",     "device_id": "<device_id>", "endpoint_id": "<UUID>", "runtime_instance_id": "<UUID>" }
```

ACL 从无权变为有权时发 `endpoint_announced`，持续有权时发 `endpoint_updated`，被撤销或 endpoint 下线时发 `endpoint_ended`。

## Relay route frame

所有业务 payload 使用统一 outer frame：

```json
{
  "type": "route",
  "purpose": "session",
  "device_id": "<device_id>",
  "endpoint_id": "<UUID>",
  "runtime_instance_id": "<UUID>",
  "target_owner_id": "<owner_id>",
  "source_owner_id": "<owner_id>",
  "ct": "<opaque string>"
}
```

`ct` 对 Relay 始终 opaque；当前客户端使用 Protocol v2 JSON UTF-8 bytes 的 Base64 STANDARD 表示。Relay 不解析、解码或记录 `ct`。

| 方向 | 必须 | 禁止 | Relay 动作 |
| --- | --- | --- | --- |
| Owner -> Host | device/endpoint/runtime、`ct` | `target_owner_id`、`source_owner_id` | 鉴权后注入 canonical `source_owner_id` |
| Host -> Owner | `target_owner_id`、device/endpoint/runtime、`ct` | `source_owner_id` | 只发给目标 Owner 的活动连接 |

`purpose=pairing` 仅用于配对请求与结果，Owner 尚未进入 ACL 时仍可路由。`purpose=session` 必须命中当前 Host ACL。相同 `(device_id, endpoint_id)` 只有一个权威 runtime；新 Host runtime 原子接管后，旧连接、旧 route 与迟到 frame 全部 stale。

## Protocol v2 inner frame

所有 inner frame 都是 strict JSON object，必须携带：

```json
{ "protocol_version": 2, "type": "..." }
```

### 尺寸与数据边界

- 单 frame JSON UTF-8：最大 `2 MiB`。
- 单 history chunk：最大 `512 KiB`。
- 单 fragment 解码后：最大 `50 KiB`。
- 一个未完成逻辑窗口：最大 `32 MiB`。
- ID：1-256 字符。
- 普通字符串：最大 `1 MiB`。
- 数组：最大 4096 项。
- 时间戳：非负有限数。
- `event_seq`：正式时间线事件使用从 1 开始的连续安全整数；它用于历史范围与缓存缺口判断，`event_id` 仍用于事件去重。
- `JsonValue`：只能是递归 JSON 值。

### 路由字段类别

| 类别 | 字段 |
| --- | --- |
| pairing | `pair_request` / `pair_ok` / `pair_error`，不要求 session channel |
| PWA direct request | `channel_id` + `session_id` + `leaf_id` |
| Extension direct response | `target_channel_id`；ready 后业务响应再带 `session_id + leaf_id` |
| Owner broadcast | `session_id` + `leaf_id`，不得带 `target_channel_id` |

配对完成后，PWA 必须先发送 `session_hello`；收到 `session_ready` 前不得发送 ready-only 业务 frame。

### PWA -> Extension

- `pair_request`
- `session_hello`
- `user_message`
- `user_message_observed`
- `session_sync`
- `queued_message_set`
- `queued_message_clear`
- `cancel`
- `ping`
- `session_new`
- `session_compact`
- `model_set`
- `thinking_set`
- `list_models`
- `extension_info_request`

`session_sync.before` 是排他的正式事件序号上界：`null` 表示从当前末尾开始，数字表示只返回序号小于该值的事件；`limit` 为 1 到 80 的整数，省略时默认 80。历史响应的最后一个 chunk 在仍有更早事件时携带数字 `next_before`，没有更早事件时携带 `eos=true`。

### Extension -> PWA

- `pair_ok`
- `pair_error`
- `session_ready`
- `extension_info`
- `user_message_started`
- `user_message_status`
- `timeline_event`
- `timeline_partial`
- `timeline_event_fragment`
- `session_history_chunk`
- `protocol_error`
- `reset`
- `pong`
- `cancelled`
- `action_ok`
- `action_error`
- `models_list`
- `queued_message_state`
- `bye`

扩展版本通过独立诊断请求获取，不改变 `session_hello` / `session_ready` 的握手格式。PWA 收到匹配的 `session_ready` 后，发送一次 `extension_info_request`，携带 `id`、`channel_id`、当前 `session_id` 和 `leaf_id`；扩展按既有 ready、channel 和会话边界校验后，返回定向 `extension_info`，携带 `target_channel_id`、`in_reply_to` 和 `version`（1–256 字符的非空字符串）。版本在扩展模块加载时固定，表示 Pi Reach 扩展版本，而非 Pi coding agent 的版本。

PWA 只接受当前有效连接、channel、runtime 和匹配请求的结果，断开或切换后清除，不读取配对缓存兜底。匹配版本查询的 `protocol_error` 只影响版本展示；旧扩展不支持查询或查询失败时显示「版本不可用」，不阻断聊天或触发重连。不轮询、不重试，也不主动推送新 inner frame 给未查询的页面。先部署 PWA 再发布扩展的顺序保持不变，新旧页面与扩展仍可使用原有握手建立会话。同一 Owner 的回复会到达其所有连接；旧页面若与新页面同时在线，可能因不认识新诊断响应而显示协议提示，但不改变握手或连接状态。

## Timeline 不变量

- `TimelineEvent` 是实时正式事件与历史事件的唯一 shape；正式事件携带连续的正整数 `event_seq`。
- `session_ready.head_seq` 是该连接建立时 Extension 当前正式事件的最大序号；PWA 只显示连接后收到且 `event_seq > head_seq` 的实时事件，历史事件通过 `session_sync` 显式加载。
- `timeline_partial` 只表示实时可变状态，不进入 marker、SessionManager 或 IndexedDB。
- 正式 user event 满足 `event_id === message_id`。
- `origin=pwa` 必须携带 `sender_ref`；非 PWA origin 禁止携带。
- tool event 的 `complete | error | interrupted` 字段组合互斥。
- `run_end` 表示 Pi 一次运行（`agent_start` 至 `agent_end`）结束，携带所结束一轮的 `group_id` 与 `status`（`complete | interrupted | error`，取本次运行最后一条 assistant 消息的结果，没有 assistant 输出时为 `interrupted`）。它与其他正式事件一样持久化、占用 `event_seq`，并在该轮正式消息之后发布。PWA 只以对应组的正式 `run_end` 确认运行结束；没有该事件时不根据 `working`、后续组或工具状态推断，也不补造结束事件，见 [ADR-20260930](../../adr/20260930-strict-run-completion.md)。
- image block 的 inline `data` 与 `omitted=true` 互斥。
- history chunk 中同一 event 不得同时出现在 `events` 和 `fragments`；一个 chunk 内 fragment event ID 不得重复。
- Extension 返回的正式历史事件序号必须从 1 开始连续递增；PWA 在缓存存在缺口时按数字范围补齐，完成去重、排序和持久化后再显示整页。

## 错误与兼容策略

`protocol_error.code` 当前集合：

```text
protocol_upgrade_required
invalid_message
unsupported_type
invalid_channel
invalid_leaf
invalid_cursor
reset_required
too_large
internal_error
```

PWA 与 Pi Extension 必须同步升级到相互匹配的版本，两端不得与旧版本混用；v2 timeline 不读取旧 cursor、旧 wire shape 或历史 timeline 数据，也不提供双栈或 fallback。

未知 frame、未知字段、方向错误、缺少版本、v1 或未知版本都必须 fail closed。任何一端不得根据旧字段猜测 endpoint、runtime、channel 或 session。兼容读取旧 `daemon` metadata 不构成这一规则的例外。
