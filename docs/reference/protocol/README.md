# Pi Reach 协议与安全

本文描述当前生产协议、身份模型和信任边界。Protocol v2 是 Relay、Pi Extension 与 Browser/PWA 的当前协议。没有 v1 fallback、room 路由、Agent Mesh、Pi-to-Pi 转发、membership storage 或旧本地数据迁移。

新 Extension 只写入 `metadata.kind = interactive`。为滚动兼容，Relay、Protocol v2 和 PWA decoder 暂时仍接受旧 `daemon` metadata；它只可被读取和显示，不恢复 daemon、supervisor 或任何后台生命周期。退出条件见[纯 Extension ADR](../../adr/20260914-pure-extension-runtime.md)。

当前协议语义及跨端 strict schema 真源：

- [`protocol-v2.md`](protocol-v2.md)
- [`pairing.md`](pairing.md)
- [`fixtures/v2/manifest.json`](fixtures/v2/manifest.json)

文档真源之外，跨端可复用实现入口是 [`packages/protocol/`](../../../packages/protocol/)：私有 workspace 包 `@pi-reach/protocol` 只导出 `outer` 与 `session`。PWA 保留的 `pi-reach/protocol` 和 `protocol-v2` 入口只作薄适配；Extension 的 marker、Pi SDK 绑定和 session state 保持本地。工程与分发边界见 [ARCHITECTURE](../../ARCHITECTURE.md#工程与构建边界)。

早期旧协议与方案未随本仓库保留，也不是当前协议真源。

## 系统边界

```text
Browser/PWA Owner <-> WebSocket/TLS <-> Relay <-> WebSocket/TLS <-> 当前 Pi Extension endpoint
                                                                    |
                                                               当前 Pi runtime/session
```

- **Browser/PWA** 保存 Owner identity、每台电脑的 pairing、endpoint metadata 和正式 timeline。
- **Relay** 验证连接身份，在内存中维护实时 endpoint registry、当前 ACL、subscriptions 和短期 pairing offer，并转发 opaque `ct`。
- **Pi Extension** 保存 device identity 与本机 Owner ACL，向当前打开的 Pi 绑定 Protocol v2 session channel。

PWA、Relay 和 Extension 都不会启动或唤醒 Pi。一个 Owner 可以独立配对多台电脑，并在同一 PWA 中选择每台电脑当前的多个 endpoint。

## 身份与生命周期

```text
device_id
  └─ endpoint_id
       ├─ runtime_instance_id
       └─ session_id + leaf_id
```

| 字段 | 含义 | 生命周期 |
| --- | --- | --- |
| `owner_id` | PWA Owner 的 canonical Ed25519 公钥 | 当前浏览器 identity 存在期间稳定 |
| `device_id` | Host 电脑的 canonical Ed25519 公钥 | device identity 存在期间稳定 |
| `endpoint_id` | 当前可路由 Pi 入口的 opaque UUID | 每个普通 Pi 进程生成新的值；同一进程 reload 保持 |
| `runtime_instance_id` | endpoint 的当前 Pi runtime UUID | 与当前普通 Pi 进程一起生成；同一进程 reload 保持 |
| `session_id` | Pi `SessionManager` 当前会话 | `/new` 或打开其他 Pi session 时变化 |
| `leaf_id` | Pi 当前 branch 的移动 tip，可为 `null` | 普通追加和 branch 变化时推进；空/root session 可为 `null` |
| `channel_id` | Owner 进入 endpoint 后的临时响应通道 | 当前实时 binding |

`cwd`、名称、PID、model、thinking 和 working 是 metadata，不是 identity。同一 cwd 可以有多个 endpoint。`/new` 不创建新 endpoint/runtime，只更换 session；普通追加只推进当前 `leaf_id`。Pi Reach 不复制或远程维护完整 Pi session tree，只有 `reset(reason=branch_changed)` 建立当前 session 投影的 branch replacement 边界。

正式 timeline 的 PWA 持久 key 是：

```text
device_id + endpoint_id + session_id
```

`leaf_id` 是当前 branch tip 元数据，不进入持久主键；`runtime_instance_id` 只用于实时 stale gate。PWA 不提供远程 Pi 历史 session 列表、resume 或历史会话切换。

## Relay outer protocol

所有连接先发送 role-aware `hello`，再完成 Ed25519 challenge-response。Host hello 包含 device、endpoint、runtime、metadata 和 `authorized_owner_ids`；Owner hello 只包含 Owner 公钥。认证身份必须等于 hello 中的 canonical 公钥。

业务 outer frame：

```jsonc
{
  "type": "route",
  "purpose": "pairing | session",
  "device_id": "<device_id>",
  "endpoint_id": "<UUID>",
  "runtime_instance_id": "<UUID>",
  "target_owner_id": "<Host->Owner 必填>",
  "source_owner_id": "<Relay 注入到 Owner->Host>",
  "ct": "<opaque string>"
}
```

方向规则：

- Owner->Host 禁止携带 `target_owner_id` 或 `source_owner_id`；Relay 鉴权后注入可信 `source_owner_id`。
- Host->Owner 必须携带 `target_owner_id`，禁止携带 `source_owner_id`。
- `purpose=pairing` 仅允许 `pair_request/pair_ok/pair_error`。
- 其他 Protocol v2 frame 只能使用 `purpose=session`，并且必须命中 Host 当前 ACL。
- Relay 不解析、解码、记录或持久化 `ct`。
- 相同 `(device_id, endpoint_id)` 只有一个权威 runtime；新 runtime 原子接管后，旧连接和迟到 route 都 stale。

Owner 使用 `subscribe_endpoints` 订阅已配对 device。Relay 以 `endpoints`、`endpoint_announced`、`endpoint_updated`、`endpoint_ended` 返回当前可见 endpoint。Host 用 `endpoint_update` 更新 metadata 与 `authorized_owner_ids`。

## 配对与撤销

在当前 Pi 执行 `/pi-reach pair` 会生成一个短期八位 Crockford Base32 配对码，并显示为二维码和文字。Extension 向 Relay 发布只存在内存中的 `pairing_offer`；PWA 扫描或输入配对码后发送 `resolve_pairing_code`，Relay 返回当前 device/endpoint/runtime target。PWA 再以 `purpose=pairing` route 发送 `pair_request`。

成功后 Extension：

1. 将 Owner 写入设备本地 `~/.pi/pi-reach/peers.json`；
2. 发送 `endpoint_update.authorized_owner_ids`；
3. 返回 `pair_ok`；
4. PWA 保存 device-scoped pairing，再订阅该 device 的 endpoint。

每台电脑独立 pairing 和 revoke。撤销一个 device 上的 Owner 后，Extension 删除本地 ACL、关闭对应 binding、更新 Relay ACL；其他电脑上的 pairing 不受影响。完整字段、TTL、重试和失败处理见[pairing contract](pairing.md)。

## Protocol v2 inner frames

所有 inner frame 都是 strict JSON object，必须携带：

```json
{ "protocol_version": 2, "type": "..." }
```

缺少版本、未知版本、未知字段、错误方向、错误 route purpose 或 ready 前发送业务 frame 都 fail closed。配对后，PWA 必须先发送 `session_hello`；收到 `session_ready` 后才能发送 ready-only 业务 frame。

主要边界：

- 单 frame JSON UTF-8 最大 `2 MiB`；单 history chunk 最大 `512 KiB`。
- 单 fragment 解码后最大 `50 KiB`；未完成逻辑窗口最大 `32 MiB`。
- ID 最大 256 字符；普通字符串最大 `1 MiB`；数组最大 4096 项。
- `TimelineEvent` 同时用于实时正式事件与历史事件。
- `timeline_partial` 只用于实时可变状态，不进入 marker、SessionManager 或 IndexedDB。
- `runtime_instance_id` 只参与实时 route stale gate；timeline frame 由 `session_id + leaf_id` 绑定，PWA 按稳定 session key 持久化。

PWA->Extension frame 包括 pairing、session hello/sync、prompt、queue、cancel、typed actions、model/thinking 和 ping。Extension->PWA frame 包括 pairing result、session ready、timeline/history、queue state、typed action result、model list、pong、reset、protocol error 和 bye。精确字段及错误码以 strict contract/fixtures 为准。

### Timeline 与图片

- 正式 user event 满足 `event_id === message_id`。
- tool 的 `complete/error/interrupted` 状态互斥。
- image 的 inline `data` 与 `omitted=true` 互斥。
- 图片作为受尺寸限制的 Base64 inline block 进入 Protocol v2 frame；没有独立对象存储或 binary upload channel。
- PWA-owned follow-up queue 位于当前 Pi Extension 进程内存；Relay 不提供 offline queue，Pi 进程结束会丢失未发送 queue state。

### Typed actions

PWA 只调用冻结的 typed action：`session_new`、`session_compact`、`model_set`、`thinking_set`、`list_models` 和 `cancel`。它不是任意 slash-command 执行器。Action response 只确认 dispatch；正式可见结果继续通过 timeline/session frame 同步。

## 存储与隐私

### Pi Extension / Host

- Host Ed25519 key 优先存入平台 keyring。
- Headless/degraded fallback 是 `~/.pi/pi-reach/identity.json`，目录权限 `0700`、文件权限 `0600`。
- 如果已有 pairing 但原 identity 不可读，Extension 不得静默生成新 identity；应进入确定性 failure。
- 并发初始化互斥、已有文件身份优先级及异常锁恢复见[Host identity 存储规则](pairing.md#host)。
- `peers.json` 保存当前设备的 Owner public key、显示名和 paired time。
- Relay 配置和 Pi session 均是本机状态。

### Browser/PWA

IndexedDB 保存 Owner private identity、device pairing、endpoint metadata 和正式 timeline。清理浏览器站点数据会删除 Owner identity 和本地 timeline，需要重新 pairing。PWA 不持久化 runtime presence，runtime 只来自当前 Relay session。

### Relay

Relay 没有数据库或持久 volume。registry、连接、ACL、subscription 和 pairing offer 全在内存中；Relay 重启后 Host/Owner 自动重连并重建在线状态。Relay 不保存 pairing history、endpoint inventory、message queue 或 traffic payload。

## Trust model

### 已提供的保护

- TLS 保护浏览器、Relay 与 Host 之间的传输。
- Ed25519 challenge-response 证明连接持有对应 Owner/Host private key。
- Relay 根据连接角色、endpoint/runtime 和 Host ACL 强制 route 方向。
- Owner->Host 的 `source_owner_id` 由 Relay 注入，Owner 不能自报可信 sender。
- Runtime gate 阻止旧进程污染新 runtime。
- Pairing code 短期有效，且 pairing route 不能承载 session frame。
- Host/Owner private key 不进入 route metadata、日志或 pairing code。

### 不提供的保护

- 当前没有应用层端到端加密。`ct` 是 Base64 编码的 Protocol v2 JSON，不是 ciphertext。
- 控制 Relay executable 或 TLS endpoint 的运营方能够读取全部会话内容。Owner->Host 的发送者身份只由 Relay 注入的 `source_owner_id` 证明，inner frame 没有端到端签名，因此该运营方还可以冒充已授权的 Owner 向 Host 发送 prompt 等 session frame，而 Pi 可以在 Host 上执行命令。敏感工作应 self-host Relay。
- Relay 可观察连接 IP、public identifiers、endpoint/runtime metadata、timing 和 transport sizes。
- 获得浏览器 profile/IndexedDB、Host keyring/file identity 或进程权限的攻击者可能冒充对应身份。
- root、进程注入、已解锁用户会话和被攻陷的终端不在防护范围内。
- Relay 是实时路由可用性的单点；其宕机不会停止本地 Pi，但会中断远程控制。

## Failure behavior

| 故障 | 行为 |
| --- | --- |
| Relay 断线 | Extension/PWA 后台重连；当前 Pi 继续本地运行，PWA 显示离线或重连中。 |
| Relay 重启 | 内存 registry 清空；连接重建后 Host 重新 announce，Owner 重新 subscribe。 |
| Pi 退出 | endpoint 从 Relay registry 消失；PWA 不启动或恢复 Pi。 |
| 新 Pi 进程 | 新 endpoint/runtime 出现；旧 route 和旧 pairing target stale。 |
| pairing code 过期或 target stale | PWA 提示生成新码，不能猜测 endpoint/runtime。 |
| Owner 未授权 session route | Relay 拒绝转发，不泄露 endpoint snapshot。 |
| 浏览器打开本地历史 | 仅读取 IndexedDB 正式 timeline，不建立远程 resume 或发送路径。 |

## 参考

- Relay：[`relay/src/`](../../../relay/src/)
- Pi Extension：[`pi-extension/src/`](../../../pi-extension/src/)
- Browser/PWA：[`pwa/src/`](../../../pwa/src/)
- [会话协议](protocol-v2.md)、[配对协议](pairing.md)

安全问题请按 [SECURITY.md](../../../SECURITY.md) 通过 GitHub 私密漏洞报告提交，不要在公开 issue 中披露漏洞细节，也不要附带 secret、private key、配对码、Cookie 或可利用 payload。
