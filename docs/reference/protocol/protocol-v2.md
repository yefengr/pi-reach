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
- 一个未完成 timeline/history 逻辑窗口：最大 `32 MiB`；文件获取使用独立的有界缓冲。
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
| 附件上传请求（能力查询除外） | `channel_id` + `session_id` + `upload_scope`，不携带 `leaf_id` |
| 附件定向响应 | `target_channel_id` + `in_reply_to` + `session_id` + `upload_scope`，不携带 `leaf_id` |
| 文件获取请求 | `channel_id` + `session_id`，不携带 `leaf_id` 或 `upload_scope` |
| 文件获取定向响应 | `target_channel_id` + `in_reply_to` + `session_id`，不携带 `leaf_id` 或 `upload_scope` |

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
- `attachment_capabilities_request`
- `attachment_begin`
- `attachment_chunk`
- `attachment_finish`
- `attachment_status_request`
- `attachment_cancel`
- `attachment_discard`
- `file_open`
- `file_read`
- `file_close`

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

旧页面可读取合法 custom 和规范化 user/history，但不认识新定向帧时仍会拒绝该帧；同 Owner 的旧页面可能看到协议提示，或需要刷新重新确认当前会话后才能发送文字。不能因此宣称旧缓存页面完全没有可见影响。能力不足不改变协议版本，也不提供 v1 fallback；部署顺序仍先 PWA、后 Extension。

## 会话文件发布与获取

文件发布不改变握手，也不增加能力帧、HTTP 文件服务或 Relay 存储。Pi 的 `publish_file` 工具将普通文件引用保存为原生 custom `pi-reach:published-file-v1`。该记录之后必须有同一工具调用的成功原生 `toolResult`，且两者已落盘，才取得发布资格；失败留下的内部记录不可展示或获取。文件只属于当前原生分支，普通 leaf 追加不改变资格。

正式 custom event 的 `payload` 严格为 `{custom_type: "pi-reach:published-file-v1", data: {file_name, mime_type, byte_length, tool_call_id}}`；`event_id` 即 `publication_id`，`data` 不重复保存 ID。源路径仅留在电脑的原生记录中，不进入文件 metadata、回执或错误。文件行沿用原 custom 的 ID、时间和 `group_id`，正式投影排在确认结果之后；与原件无关的工具参数仍遵循既有工具展示规则。

PWA 在完成会话握手和历史同步后获取文件。Extension 每次打开和读取都核对已认证 Owner、channel、runtime、session、branch generation 和当前发布资格；不接受客户端路径。真正切换目标或分支使旧任务失效，普通 leaf 追加不失效。

| Frame | 行为与关联 |
| --- | --- |
| `file_open` | 用 `publication_id` 请求原件；同 scope 的活跃请求 ID 可幂等重放，不能改为其他文件。 |
| `file_opened` | 返回 `publication_id`、`transfer_id`、当前 `file_name/mime_type/byte_length` 和 `preview`；旧发布 metadata 不是内容版本或快照。 |
| `file_read` | 用 `transfer_id` 和精确 `offset` 连续读取；不提供任意范围读取或断点恢复。 |
| `file_chunk` | 返回对应 `transfer_id/offset`、canonical Base64 `data_base64` 和 `final`；末片必须有 `total_bytes` 与小写 SHA-256，非末片禁止这两个字段。只有零字节文件的末片可为空。 |
| `file_close` / `file_closed` | 按 `transfer_id` 尽力释放句柄；取消、断线和失效先停止使用结果，再清理资源。无关闭回执不表示远端已释放。 |
| `file_error` | 返回固定 code，可带关联的 `transfer_id`；不含路径、异常正文或原件。身份与会话错误仍走既有 `protocol_error/reset` 恢复，不降格为文件错误。 |

原件最大 50 MiB，单片解码后最大 64 KiB。只有通过有界结构检查、确认无动画且不超过 2000 万像素的静态图片才返回 `{kind:"image", width, height}`；动画图片或无法安全确认的图片返回 `{kind:"none"}`，仅可下载原件，不自动获取或进入图片阅读器。文本为 `{kind:"text"}`，其他为 `{kind:"none"}`。机器可读约束与错误码见[共享文件 schema](../../../packages/protocol/src/session/files.ts)。Extension 同进程最多保有 8 个活文件资源，计入发布检查、打开中及关闭失败的句柄；空闲 30 秒回收。关闭失败仍占额度，不伪报释放。

读取沿用同一只读句柄，每片前后检查文件身份与属性；路径替换、读取中变化或取消后迟到结果不能完成任务。最后关闭成功后才发送完整摘要。摘要验证不承诺文件系统原子快照，也不保证硬取消已经进入内核的 I/O。

PWA 同时最多一个获取任务和一片在途，请求超时 15 秒。完成原件长度和 SHA-256 校验后才显示图片或提供保存链接；完整内容只留在 64 MiB 页面缓存，阅读器使用的内容被 pin，预算不足时拒绝准入。短断线保留完整结果，刷新、切换目标或离开页面不保证保留；不写 IndexedDB、Service Worker 或后台任务，不自动重试或续传。具体自动预览、受限文本阅读和保存手势见[当前设计](../../DESIGN.md#组件规则)。

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

PWA 与 Pi Extension 必须使用相容的 Protocol v2 契约；独立附件或诊断能力不足只使对应功能不可用，不构成协议降级。v2 timeline 不读取旧 cursor、旧 wire shape 或历史 timeline 数据，也不提供 v1 双栈或 fallback。

未知 frame、未知字段、方向错误、缺少版本、v1 或未知版本都必须 fail closed。任何一端不得根据旧字段猜测 endpoint、runtime、channel 或 session。兼容读取旧 `daemon` metadata 不构成这一规则的例外。
