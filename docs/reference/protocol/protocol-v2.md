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
- 一个未完成 timeline/history 逻辑窗口：最大 `32 MiB`；文件获取与工具详情分别使用独立的有界缓冲。
- ID：1-256 个 UTF-16 code unit。
- 普通 string/text：最多 1,048,576 个 UTF-16 code unit，不是编码后的字节上限；frame 的 UTF-8 字节限制仍单独生效。工具详情允许较长字符串，但整份 JSON 受下文 8 MiB 预算约束。
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
| 附件上传请求（能力查询除外） | `channel_id` + `session_id` + `upload_scope`，不携带 `leaf_id` |
| 附件定向响应 | `target_channel_id` + `in_reply_to` + `session_id` + `upload_scope`，不携带 `leaf_id` |
| 文件获取请求 | `channel_id` + `session_id`，不携带 `leaf_id` 或 `upload_scope` |
| 文件获取定向响应 | `target_channel_id` + `in_reply_to` + `session_id`，不携带 `leaf_id` 或 `upload_scope` |

配对完成后，PWA 必须先发送 `session_hello`；收到 `session_ready` 前不得发送 ready-only 业务 frame。

普通业务请求的 `leaf_id` 可以引用当前 channel 最近一次 hello 时的 tip，或该 tip 之后、当前分支上的祖先。模型、思考级别和消息的正常追加不触发 branch replacement；未知叶、其他分支或 hello 之前的叶仍被拒绝。显式分支／会话切换使旧 channel 的业务请求失效，须重新 hello，即使切走后又回到同一 tip。历史分页快照仍严格匹配请求叶；停止请求还必须匹配当前运行的 `group_id`。

### PWA -> Extension

- `pair_request`
- `session_hello`
- `user_message`
- `user_message_status_request`
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
- `attachment_capabilities_request`
- `attachment_begin`
- `attachment_chunk`
- `attachment_finish`
- `attachment_status_request`
- `attachment_cancel`
- `attachment_discard`
- `file_open`
- `file_attachment_open`
- `file_read`
- `file_close`
- `tool_details_open`
- `tool_details_close`

`session_sync.before` 是排他的正式事件序号上界：`null` 表示从当前末尾开始，数字表示只返回序号小于该值的事件；`limit` 为 1 到 80 的整数，省略时默认 80。历史响应的最后一个 chunk 在仍有更早事件时携带数字 `next_before`，没有更早事件时携带 `eos=true`。

### Extension -> PWA

- `pair_ok`
- `pair_error`
- `session_ready`
- `extension_info`
- `attachment_capabilities`
- `attachment_state`
- `attachment_discarded`
- `attachment_error`
- `file_opened`
- `file_chunk`
- `file_closed`
- `file_error`
- `tool_details_chunk`
- `tool_details_error`
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
- `compaction_activity`
- `queued_message_state`
- `bye`

扩展版本通过独立诊断请求获取；该诊断功能本身不增加 `session_hello` / `session_ready` 字段。PWA 收到匹配的 `session_ready` 后，发送一次 `extension_info_request`，携带 `id`、`channel_id`、当前 `session_id` 和 `leaf_id`；扩展按既有 ready、channel 和会话边界校验后，返回定向 `extension_info`，携带 `target_channel_id`、`in_reply_to` 和 `version`（1–256 字符的非空字符串）。版本在扩展模块加载时固定，表示 Pi Reach 扩展版本，而非 Pi coding agent 的版本。

PWA 只接受当前有效连接、channel、runtime 和匹配请求的结果，断开或切换后清除，不读取配对缓存兜底。匹配版本查询的 `protocol_error` 只影响版本展示；旧扩展不支持查询或查询失败时显示「版本不可用」，不阻断聊天或触发重连。不轮询、不重试，也不主动推送新 inner frame 给未查询的页面。先部署 PWA 再发布扩展的顺序保持不变；工具摘要模式另有下文的能力协商，不因诊断请求独立而省略。同一 Owner 的回复会到达其所有连接；旧页面若与新页面同时在线，可能因不认识新诊断响应而显示协议提示，但不改变握手或连接状态。

## 操作反馈

操作请求沿用 ready-only 的 channel、session 和 leaf 校验，定向回执以 `target_channel_id` 与 `in_reply_to` 关联原请求。发送成功和受理都不代表业务完成。

## 消息投递确认

`user_message` 的定向回执为 `user_message_status`。`in_reply_to` 指向触发本次回复的请求 `id`，`client_request_id` 关联逻辑消息。状态包括 `received`、`accepted`（可带 `message_id` / `group_id`）、`committed`、`rejected`（带受控 `code` 与 `retryable`）、`cancelled`、`unknown_delivery`，以及仅用于查询答复的 `not_found`。

PWA 可在重新握手或确认超时后发送只读 `user_message_status_request`，携带 `id`、`channel_id`、`session_id`、`leaf_id` 与 `client_request_id`。Extension 按当前 Owner、channel、session 和 leaf 校验，读取会话投递记录、真实队列、附件投递保护和当前正式投影，返回定向 `user_message_status`；不创建幂等记录、不重新入队，也不调用 Pi 投递。查不到只表示当前证据不足，不能作为重发依据。旧扩展不识别查询时返回 `protocol_error` 和 `protocol_upgrade_required`。

Relay 不缓存定向帧，PWA 断线期间发出的 `user_message_started` 与 `user_message_status` 会丢失。同一 channel 重新发送 `session_hello` 时，Extension 在 `session_ready` 之后、队列快照之前，为该 Owner 在此 channel 上已有 `message_id`、尚未收到 `user_message_observed` 的记录补发定向 `user_message_status`：`status` 一律为 `accepted`（committed 也按 accepted 补发，最终以正式事件为准），`in_reply_to` 为原发送尝试 `id`，单次握手最多 32 条，优先最近的消息。补发不创建记录、不调用 Pi 投递；未补到的消息仍由状态查询恢复，附件消息的投递保护同样只走查询。

可重试的 `rejected` 允许同一 `client_request_id`、相同内容以未处理过的请求 `id` 重新提交；相同请求 `id` 的重复帧只重放结果，包括中间经过其他尝试后再次收到的旧帧。每条有效幂等记录最多记住 128 个尝试（含首试）；达到上限后，新尝试不能重新准入，仍为可重试拒绝的记录转为 `rejected`／`unavailable`／`retryable: false`，不通过淘汰旧尝试换取准入。该保护仍受现有记录 TTL、容量回收和进程生命周期限制。

PWA 的查询等待为 10 秒，关联自查询发出起最多保留 60 秒、最多 128 条；等待超时不立即丢弃关联。迟到回执仍需匹配本消息、发送尝试、队列操作、最新查询和当前目标／连接；弱状态与否定结果不能覆盖查询后取得的新证据，带 `message_id` 的肯定回执可与正式记录原位合并。查询关联到期或被回收后不再消费该查询结果，不因此补发消息。查询等待超时且未收到任何答复时，PWA 对同一发送尝试与队列操作在超时后 15 秒、45 秒各自动重查一次，之后只保留手动核对；收到任何答复（含弱状态、`not_found` 与查询错误）、重新握手或改用新发送尝试都会结束这一轮重查。

队列快照是 Owner 广播的实时状态，`leaf_id` 取 Extension 当前 tip；Pi 输出期间 Extension 在消息开始时就写入 marker，快照的 `leaf_id` 会领先于 PWA 只随正式事件推进的 tip，因此 PWA 只按 `session_id` 接收快照，分支切换由 `reset` 处理。

`queued_message_clear` 移除本端排队消息时，先回复定向 `user_message_status`（`status: "cancelled"`，`in_reply_to` 为撤回请求），再发队列快照。排队插入调用 SDK 后的同步异常按可能已投递处理，不重新入队、不允许再次插入或取消；有界迟到关联仍可接收启动／正式事件，已经取得的肯定证据不回退。

- `cancel` 必须携带目标 `group_id`；Extension 仅在其等于当前运行轮次时调用停止。`cancelled` 只确认受理，PWA 等待该轮正式 `run_end`；匹配的 `protocol_error` 解除等待。晚到请求不得停止下一轮。
- `action_ok` 按 `action` 严格区分字段：`model_set` 返回实际 `model` 与 `thinking_level`；`thinking_set` 返回实际 `thinking_level`；`session_new` 返回新目标 `session_id`；`session_compact` 返回 `phase=accepted/completed/cancelled`。`action_error` 保留原关联字段。配置失败后可重新 `list_models` 核实实际值，不假定回滚。
- `models_list` 必须携带实际 `thinking_level`，可选 `current` 为实际当前模型。思考级别包括 `off/minimal/low/medium/high/xhigh/max`，实际值由 Pi 的模型能力限制决定。
- `session_new` 成功回执先于旧 Owner 分离。PWA 汇合目标 ID、匹配目标的 `session_ready` 和必要首屏数据后切换展示；等待时保留旧内容，断线或超时不自动重发。
- `compaction_activity` 为非持久化会话广播，包含 `session_id`、`leaf_id`、`status=running/completed/failed/cancelled` 和 `reason=manual/threshold/overflow`。它反映公开 hooks 可观察到的活动，不携带摘要或请求 ID，也不确认某个远程请求。摘要继续使用正式 timeline；远程结果由其调用回调关联。

这些字段使用严格 schema，PWA 与 Extension 需要配套升级；发布顺序仍为先 PWA 后 Extension。旧端缺少字段或不认识广播时可能拒绝帧，不能将原有握手格式未变视为业务兼容保证。不增加旧端能力探测或降级协议。

## 会话附件

能力查询独立于 `session_hello/session_ready`。握手成功后，PWA 以既有 direct request scope 发送 `attachment_capabilities_request`；支持端返回定向 `attachment_capabilities`，携带本次 `upload_scope` 和以下固定上限。不支持或查询失败时附件入口不可用，但同版本契约中的普通文字和历史不受影响。

| 项目 | 限制 |
| --- | --- |
| 原件 | 50 MiB/文件、100 MiB/消息、最多 10 件，允许零字节 |
| 分片 | 解码后 1–64 KiB，最多 2 个在途 |
| 展示预览 | JPEG，最大 32 KiB、宽高各不超过 320px；失败不影响原件 |

`MiB` 为 `1024 × 1024` 字节。机器可读字段、strict 校验及固定错误码以[共享附件 schema](../../../packages/protocol/src/session/attachments.ts)为准；原有 2 MiB frame 上限不变。

上传请求由已认证 Owner、当前 runtime/session 和服务端租约共同授权。租约不依赖临时 channel 或普通追加的 `leaf_id`；channel 重建须重新查询能力，真正 session/branch/runtime 变化会使旧租约失效，不能把旧附件交给新目标。

- `attachment_begin`：提供客户端 `upload_id`、文件名、MIME、原件字节数和小写 SHA-256，可附预览；幂等重放不能改变这些参数。
- `attachment_chunk`：提供精确 offset 和 canonical Base64；服务端核对已接收位置和原件上限，拒绝缺口或不一致重放。
- `attachment_finish`、`attachment_status_request`、`attachment_cancel`：按租约和 upload ID 完成、查询或取消；零字节原件不发空分片。
- `attachment_state`：返回 `receiving/complete/cancelled` 和已收字节数；只有 complete 带服务端附件描述，且字节数与描述一致。
- `attachment_discard`：提供 `protocol_version=2`、`id`、`channel_id`、`session_id`、`upload_scope` 和服务端 `attachment_id`，用于清理恢复的描述符原件；不接受 `upload_id`，两种身份不能混用。
- `attachment_discarded`：以 `in_reply_to`、`target_channel_id`、`session_id`、`upload_scope` 和 `attachment_id` 严格关联该清理请求，返回 `cancelled/retained`，不携带原件或路径。服务端校验已认证 Owner、session 和租约后复用取消清理；重复清理可回执 cancelled，已 retain 的原件必须保护并回执 retained。客户端仅在重新握手核验同目标和同租约后发送离线清理意图，不能转投其他 Owner/runtime/session/lease；此回执不能结清 upload ID 请求。
- `attachment_error`：只携带固定 code、retryable 和关联字段，不携带系统错误正文或本地路径。可选 `upload_id` 与可选 `attachment_id` 互斥；两者均省略的既有错误形状仍合法。

上传完成后，`user_message` 以 `attachment_ids` 提交，最多 10 个且不可重复，与旧 `images` 互斥。可以只有附件、没有文字；附件与直接 `streaming_behavior=steer` 的组合被拒绝，普通附件消息仍走既有队列。Extension 按 Owner 和租约解析 ID，可能投递后保留幂等保护；相同请求不能重复送给 Pi，投递未知不能假定原件尚未被读取。

正式事件、user blocks 与 queue item 不新增附件字段。原生 custom `pi-reach:attachments-v1` 保存 request/sender、原文、描述及预览；`pi-reach:attachment-message-v1` 将同一 request/sender 关联到正式 `message_id`。PWA 按 session、sender、request 和 message 严格关联，不要求同 leaf；冲突时撤回派生展示，不能借用其他 Owner 或会话的数据。这些 custom 参与正式 `event_seq` 与历史持久化，展示时隐藏原始 payload。

已发送附件可在线取回原件：PWA 以 `file_attachment_open` 提交 `attachment_id`，读取、关闭、错误与限额复用[会话文件发布与获取](#会话文件发布与获取)。Extension 只承认当前原生分支上已绑定正式消息的附件元数据，按存储规则在电脑端定位原件，不接受客户端路径；`file_opened` 的名称取上传时的原文件名，原件长度或 SHA-256 与元数据不一致时返回 `file_changed`，PWA 也按元数据摘要再次校验。只读历史与 pending 不取回。旧 Extension 不认识该 frame，以 `protocol_upgrade_required` 回复，PWA 只把它视为本次附件取回不可用。

旧页面可读取合法 custom 和规范化 user/history，但不认识新定向帧时仍会拒绝该帧；同 Owner 的旧页面可能看到协议提示，或需要刷新重新确认当前会话后才能发送文字。不能因此宣称旧缓存页面完全没有可见影响。能力不足不改变协议版本，也不提供 v1 fallback；部署顺序仍先 PWA、后 Extension。

## 会话文件发布与获取

文件发布不改变握手，也不增加能力帧、HTTP 文件服务或 Relay 存储。Pi 的 `publish_file` 工具将普通文件引用保存为原生 custom `pi-reach:published-file-v1`。该记录之后必须有同一工具调用的成功原生 `toolResult`，且两者已落盘，才取得发布资格；失败留下的内部记录不可展示或获取。文件只属于当前原生分支，普通 leaf 追加不改变资格。

正式 custom event 的 `payload` 严格为 `{custom_type: "pi-reach:published-file-v1", data: {file_name, mime_type, byte_length, tool_call_id}}`；`event_id` 即 `publication_id`，`data` 不重复保存 ID。源路径仅留在电脑的原生记录中，不进入文件 metadata、回执或错误。文件行沿用原 custom 的 ID、时间和 `group_id`，正式投影排在确认结果之后；与原件无关的工具参数仍遵循既有工具展示规则。

PWA 在完成会话握手和历史同步后获取文件。Extension 每次打开和读取都核对已认证 Owner、channel、runtime、session、branch generation 和当前发布资格；不接受客户端路径。真正切换目标或分支使旧任务失效，普通 leaf 追加不失效。

| Frame | 行为与关联 |
| --- | --- |
| `file_open` | 用 `publication_id` 请求原件；同 scope 的活跃请求 ID 可幂等重放，不能改为其他文件。 |
| `file_attachment_open` | 用 `attachment_id` 请求已发送附件的原件（见[会话附件](#会话附件)）；与 `file_open` 共用幂等和资源规则，同一请求 ID 不能切换来源。 |
| `file_opened` | 回显请求中的 `publication_id` 或 `attachment_id`（恰有其一），返回 `transfer_id`、当前 `file_name/mime_type/byte_length` 和 `preview`；旧发布 metadata 不是内容版本或快照。 |
| `file_read` | 用 `transfer_id` 和精确 `offset` 连续读取；不提供任意范围读取或断点恢复。 |
| `file_chunk` | 返回对应 `transfer_id/offset`、canonical Base64 `data_base64` 和 `final`；末片必须有 `total_bytes` 与小写 SHA-256，非末片禁止这两个字段。只有零字节文件的末片可为空。 |
| `file_close` / `file_closed` | 按 `transfer_id` 尽力释放句柄；取消、断线和失效先停止使用结果，再清理资源。无关闭回执不表示远端已释放。 |
| `file_error` | 返回固定 code，可带关联的 `transfer_id`；不含路径、异常正文或原件。身份与会话错误仍走既有 `protocol_error/reset` 恢复，不降格为文件错误。 |

原件最大 50 MiB，单片解码后最大 64 KiB。只有通过有界结构检查、确认无动画且不超过 2000 万像素的静态图片才返回 `{kind:"image", width, height}`；动画图片或无法安全确认的图片返回 `{kind:"none"}`，仅可下载原件，不自动获取或进入图片阅读器。文本为 `{kind:"text"}`，其他为 `{kind:"none"}`。机器可读约束与错误码见[共享文件 schema](../../../packages/protocol/src/session/files.ts)。Extension 同进程最多保有 8 个活文件资源，计入发布检查、打开中及关闭失败的句柄；空闲 30 秒回收。关闭失败仍占额度，不伪报释放。

读取沿用同一只读句柄，每片前后检查文件身份与属性；路径替换、读取中变化或取消后迟到结果不能完成任务。最后关闭成功后才发送完整摘要。摘要验证不承诺文件系统原子快照，也不保证硬取消已经进入内核的 I/O。

PWA 同时最多一个获取任务和一片在途，请求超时 15 秒。完成原件长度和 SHA-256 校验后才显示图片或提供保存链接；完整内容只留在 64 MiB 页面缓存，阅读器使用的内容被 pin，预算不足时拒绝准入。短断线保留完整结果，刷新、切换目标或离开页面不保证保留；不写 IndexedDB、Service Worker 或后台任务，不自动重试或续传。具体自动预览、受限文本阅读和保存手势见[当前设计](../../DESIGN.md#组件规则)。

## 工具摘要与按需详情

### 能力与轻量记录

`session_hello` 与 `session_ready` 可携带 `tool_details: 1`。新 PWA 首次发送不含该字段的原样 hello，以连接旧 Extension；新 Extension 对未声明能力的 hello 返回 `protocol_upgrade_required`，不登记 ready，也不发送新工具历史。新 PWA 仅对当前 hello 的该回复补发一次含能力的 hello，ready 回显能力后进入摘要模式；其他失败不无限重试或降级。

新模式的正式 tool event 和工具 partial 使用 `representation: "summary"`，携带 `summary` 与 `tool_ref`，不携带完整 `args`、`result` 或图片正文。`summary` 包含操作类型，以及必要的有界 command、path、query、offset、limit；每个字符串最多 512 个 code unit，摘要 JSON 不超过 4 KiB。`tool_ref = {call_entry_id, tool_call_id}` 以原生 assistant 调用的 marker/entry 身份和工具调用 ID 定位原件，且引用内外的 `tool_call_id` 一致；不能仅凭工具调用 ID 查询。

Extension 仅向已协商 channel 定向发送工具摘要；PWA 先过滤发给其他 channel 的定向帧，再严格解码属于自己的帧。新 PWA 仍可读取旧 Extension 的既有 v2 inline 工具事件，但该组合没有源头轻量化收益。新 Extension 不向未协商页面回退发送完整工具结果。已经加载的旧页面可能只有通用错误提示，需要刷新到新版；服务端升级错误码不保证旧 JavaScript 已有专用升级文案。

### 打开、更新与关闭

| frame | 字段与语义 |
| --- | --- |
| `tool_details_open` | ready-only direct request，继承 channel/session/leaf 作用域，另带 `group_id`、`tool_ref`；请求 `id` 同时标识本次订阅。 |
| `tool_details_close` | 相同 direct request 边界，`subscription_id` 指向要取消的 open `id`；旧关闭不得取消新的阅读选择。 |
| `tool_details_chunk` | 定向响应，以 `in_reply_to` 关联 open，携带 session/leaf/group/ref、`revision`、从 0 连续递增的 `index` 与 canonical `data_base64`。最后一片 `final=true`，另带整份 JSON 的 `total_bytes`、SHA-256；非最后片不含这些终态字段。 |
| `tool_details_error` | 相同响应身份，`code` 为 `not_found`、`unavailable`、`too_large`、`busy` 或 `cancelled`；`terminal` 表示订阅是否结束，`retryable` 表示是否允许重试。 |

每份更新是 revision 递增的完整替换快照，不是追加日志。PWA 逐片核验当前连接、阅读选择、工具引用、revision/index、Base64、UTF-8、总字节数、SHA-256 与严格内容 schema，完整校验后再替换正文。新快照可以覆盖尚未完成的旧快照；合并与节流不保证回放所有中间帧。

详情文档的 `source=preview` 对应 preparing/running，`source=session` 对应已保存的 complete/error/interrupted；`args` 必填，result/error 按实际保存内容提供。正式 complete 必须包含保存的 result，session 文档不能带 `limited=true`。原件只取自当前合法分支的 Pi 原生消息，不执行工具、不重读文件、不接受任意本机路径；`publish_file` 的源路径隐藏规则不变。

运行订阅通过现有 ping 续租。关闭意图立即取消，切选择、作用域、权限变化与断连也清理订阅；租期只兜底未被直接观察的失联，不代替主动关闭。终态保存后自动发送原生最终详情并释放订阅。详情专用请求 ID 使用独立命名空间，对应 `protocol_error` 与 pong 不进入聊天失败路径。详情失败、受限或超限不修改工具成败、正式事件、发送门禁或 `run_end`。

### 独立预算与缓存

数值定义见[共享协议常量](../../../packages/protocol/src/session/schema.ts)，JSON 预算在完整序列化前检查，不先为超大对象分配完整 JSON 副本。

| 资源 | 边界 |
| --- | --- |
| 最新运行预览 | 单调用 64 KiB；全进程合计 512 KiB、最多 8 份，不累计旧快照。 |
| 活跃订阅 | 每 channel 1 份；跨 Owner 全进程最多 16 份，10 秒续租、30 秒过期。 |
| 正式详情 | 整份 JSON UTF-8 最大 8 MiB；单片仍受 50 KiB、单 frame 仍受 2 MiB 上限约束。超限报错，不截成假的完整结果。 |
| 详情发送预算 | 16 MiB，计入 Base64、扇出与底层 WebSocket 等待发送的数据。 |
| PWA 最终缓存 | 16 MiB、最多 64 项，按使用顺序回收；仅缓存通过校验的 session 最终详情。 |

这些是内容、队列或缓存预算，不是整个进程、浏览器或图片解码的内存峰值。详情缓存按 Owner/device/endpoint/session/group/native ref 隔离，不以临时 runtime/channel/leaf 为持久身份，不回填正式工具事件；移除配对、清会话或清数据时一并清理，并以事务阻止晚到写入重建孤立缓存。已有完整 v2 inline 记录不会被摘要擦除，omitted/truncated 记录不冒充完整原件。本地只读历史与离线阅读只使用已有内容或缓存，未命中不自动建立远端连接。

## Timeline 不变量

- `TimelineEvent` 是实时正式事件与历史事件的唯一 shape；正式事件携带连续的正整数 `event_seq`。
- `session_ready.head_seq` 是该连接建立时 Extension 当前正式事件的最大序号；PWA 只显示连接后收到且 `event_seq > head_seq` 的实时事件，历史事件通过 `session_sync` 显式加载。
- `timeline_partial` 只表示实时可变状态，不进入 marker、SessionManager 或 IndexedDB。
- 工具 `timeline_partial` 的 `status` 为 `preparing`（模型仍在生成该调用，参数可能不完整，尚未执行）、`running`（已开始执行）或 `delta`（执行期间更新）；正文与思考 partial 只使用 `running`、`delta`。同一调用的准备与执行共用 `partial_id`（`tool:<tool_call_id>`）：准备阶段沿用已有节流，调用生成完成时立即发布摘要，开始执行后不再发布准备中；协商后的工具 partial 均只带有界摘要与引用，不随运行帧发送完整参数或输出。完整预览只沿已打开的定向详情订阅更新；PWA 不允许状态从执行退回准备中。运行结束时仍为准备中的调用从未执行，PWA 不再显示，与刷新后的历史一致。未协商页面按上述能力边界隔离，发布仍先 PWA、后 Extension。
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

PWA 与 Pi Extension 必须使用相容的 Protocol v2 契约；独立附件或诊断能力不足只使对应功能不可用，不构成协议降级。v2 timeline 不读取旧 cursor、旧 wire shape 或历史 timeline 数据，也不提供 v1 双栈或 fallback。既有 v2 inline 工具事件与新增 summary 变体同属当前共享 schema，不是 v1 回退；工具摘要能力未协商时按上文拒绝新模式握手。

未知 frame、未知字段、方向错误、缺少版本、v1 或未知版本都必须 fail closed。任何一端不得根据旧字段猜测 endpoint、runtime、channel 或 session。兼容读取旧 `daemon` metadata 不构成这一规则的例外。
