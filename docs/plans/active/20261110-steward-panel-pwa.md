# 管家面板 PWA（独立项目预研）

> 状态：候选，未确定开发。本文是预研方案，不代表已排期、已建仓库或获准实施。相关入口见 [BACKLOG](../../BACKLOG.md)。

## 1. 定位

一个独立部署的 PWA：手机上打开（或安装到主屏），通过现有 Relay 连到管家所在电脑，看任务队列、批审批、新建任务。

它**不是 Pi Reach 的功能**。复用的是 Pi Reach 的协议外层与连接实现，不是它的产品边界：Pi Reach 继续只负责「看一个 Pi 会话」。

明确不做：推送通知、面板内查看会话、显示工具调用与日志、离线缓存队列数据、多用户与团队共享。

## 2. 为什么独立成项目

| 理由 | 说明 |
| --- | --- |
| 产品语义不同 | 一边是单个会话的时间线，一边是跨机器的任务队列与审批。同一套界面装不下两种信息结构。 |
| 连接层与业务无关 | 协议外层只处理握手、身份证明与按 device/endpoint 路由，不关心帧里装的是会话还是队列。 |
| 发布节奏不同 | 面板会频繁改；Pi Reach 有 Docker、staging、浏览器 E2E 一整套流程。耦合进同一 CI，改个列表样式要跑全量回归。 |

## 3. 架构

```
面板 PWA（静态托管，owner 身份）
   │  WSS
Relay（现有实例，零改动）
   │  WSS
steward-extension（管家 Pi 进程内，device 身份）
   │  本地文件与子进程
~/.steward/queue/*.yml + runner + 任务子进程
```

三条连接：

1. PWA → Relay：owner 身份，Ed25519 challenge-response，配对后自动重连。
2. steward-extension → Relay：device 身份，主动连出。管家电脑与手机都不需要公网 IP。
3. extension → 队列：本机文件读取与 CLI 调用，不出本机。

**两套设备互不可见。** steward-extension 用独立 device 身份注册，不借用 Pi Reach Extension 的连接；因此 Pi Reach 的 PWA 里不会出现这个端点，两套配对互不影响。代价是管家电脑上有两条 Relay 连接。

## 4. 可复用清单

已实现且稳定，整块搬用，只改 import 与移除无关依赖。

| 能力 | 来源 |
| --- | --- |
| 握手、认证、路由编解码、常量 | `packages/protocol/outer`（作为包依赖） |
| owner 客户端：crypto、encoding、pairing、peer-channel、relay-client | `pwa/src/lib/pi-reach/` |
| 配对流程与本地存储：pairing-device、use-device-pairing、db、qr-camera、qr-decoder | `pwa/src/lib/pwa/` |
| device 客户端：连接、重连、存活检测、peer channel | `pi-extension/src/transport/` |
| 身份、钥匙串、配对码、二维码 | `pi-extension/src/pairing/` |
| PWA 壳：Service Worker 配置、安装引导、更新提示 | `pwa/src/app/sw.ts`、vite serwist 配置、`install-guide`、`service-worker-update` |

不需要重写的难点：Ed25519 挑战应答、配对码短期有效与一次性消费、钥匙串存取、断线重连与存活判定、ACL 持久化。

不搬：时间线相关目录、附件上传与预览、文件传输、会话动作（新建会话、切模型、压缩）、工具详情与阅读器、消息队列。

**取用方式为复制，不从 Pi Reach 抽取共享包。** 连接层已稳定，抽取需要改动 Pi Reach 的 import 与验证流程，成本高于复制；两边各自演化也不会互相拖累。出现「两边都要改进连接层」的真实需求时再回头抽取。

## 5. 需新写

- inner 帧定义（见 §6）。
- 设备端队列逻辑：读队列文件、字段校验、调 CLI、回写审批结果，不含界面。
- 面板页面：列表与详情；新建与设置用底部弹层。

配对逻辑本身复用，但「何时提示配对、配对完成后如何进入列表」需要自己接。

## 6. inner 帧

沿用现有请求响应模式（`id` + `in_reply_to`），事件走广播，全部严格校验。

```
面板 → 设备端
{ type: "steward_tasks_request", id, channel_id }
{ type: "steward_task_request",  id, channel_id, task_id }
{ type: "steward_new",           id, channel_id, title, desc, repo, machine, priority, approval }
{ type: "steward_act",           id, channel_id, task_id, action: "approve"|"deny"|"stop"|"retry"|"archive" }
{ type: "steward_subscribe",     id, channel_id, since_rev }

设备端 → 面板
{ type: "steward_tasks",  in_reply_to, rev, tasks: [...], usage: { spent, limit, running, parallel_max } }
{ type: "steward_task",   in_reply_to, task: { ...含 report 原文 } }
{ type: "steward_ack",    in_reply_to, task_id, status }
{ type: "steward_event",  rev, event: "status_changed"|"report_updated"|"approval_pending", task_id }
{ type: "steward_error",  in_reply_to, code, message }
```

三条约定：

1. **服务端权威**：`rev` 单调递增；面板收到事件后用 `since_rev` 拉增量，不做本地推断。
2. **状态是枚举，汇报是文本**：两者分开传，不把描述塞进状态字段。
3. **写操作幂等**：审批与新建带 `id`，设备端按 id 去重，手机重发不会重复执行。

帧内不传事件流、日志或 diff。面板本就不显示这些，传了只会放大帧体积与 Relay 可见面。

## 7. 设备端

作为 Pi 扩展加载在管家那个长期会话里，跟随其生命周期。

1. 启动读取 device 身份与 ACL；未配对则生成配对码，输出二维码与短码。
2. 连 Relay 并注册为 device/endpoint，复用搬来的 relay_client（含重连与存活检测）。
3. 收到 `steward_*` 后读取 `~/.steward/queue/*.yml`，校验字段并组装响应。
4. 写操作转成 CLI 调用（审批、终止、归档、新建），不直接改队列文件。
5. 队列变化时递增 `rev` 并推送 `steward_event`。

**写操作只走 CLI**：队列的原子性与状态校验都在 CLI 里，直写文件等于开第二个写入口，迟早出现两边各写一半的坏状态。

## 8. 面板端

移动优先，桌面可读即可。

| 页面 | 内容 |
| --- | --- |
| 列表（默认） | 顶部一行：今日花费、并行数、连接状态。分段：待处理、进行中、完成、已归档 |
| 任务详情 | 标题、状态标签、任务描述、汇报卡片、耗时与花费、操作按钮 |
| 弹层 | 新建任务、每日限额与并行数、配对 |

数据策略：

- 连接状态独占一处提示；断线时保留最后数据但明确标注可能过期。
- **不把队列写入 IndexedDB**。离线只显示连接断开，不显示过期数据——看错状态的代价高于白屏。
- 收到 `steward_event` 拉增量；页面不在前台时不做任何事，回到前台先拉全量。

已知缺口：Pi Reach 不做 Web Push，本面板也不做，「有任务等待审批」只有打开面板时可见。

## 9. 配对与身份

全部复用现有实现：owner 密钥对、短期一次性配对码、二维码与手动短码、ACL 存储、按 owner 撤销。一个设备可被多个 owner 配对（例如手机与平板）。

## 10. 部署

- 构建产物为静态文件，部署到任意 HTTPS 静态托管，不需要服务器或容器。
- PWA 安装在手机上要求安全上下文，托管平台的 HTTPS 直接满足；两端都主动连 Relay，因此不需要组网工具或公网 IP。
- standalone 模式下的安全区、软键盘、状态栏颜色照抄 Pi Reach 的做法。

## 11. 信任边界

面板数据经过 Relay，隐私面比只用 Pi Reach 时略大，性质相同。

| Relay 运营方可看到 | 看不到 |
| --- | --- |
| 任务标题、描述、汇报原文、审批请求命令、连接时间与帧大小 | 本机文件内容、事件流、代码 diff、模型凭证 |

- **任务描述中不写凭证、私有地址或客户数据**，需要这些信息让子代理自己去读文件。这条只能靠使用约定。
- 已配对的面板等于能新建任务、批准 push、终止任务，也就是能在该机器上指挥 AI。
- 撤销入口必须在设备端命令行；手机丢失时先用命令行撤销，再处理设备。面板不提供共享链接或记住登录。

## 12. 失效模式

| 故障 | 表现 | 处理 |
| --- | --- | --- |
| 管家 Pi 退出 | 面板连接断开，数据停在最后一次 | 设备端由 launchd 托管 Pi，重启后自动重连 |
| Relay 不可达 | 重连中，指数退避 | 沿用现有重连策略；长时间失败提示检查网络 |
| 手机切后台被挂起 | 回到前台需重新握手 | 回前台先拉全量，不做增量接续 |
| 队列文件被手改坏 | 返回 `steward_error` 并指出文件 | 设备端校验字段，坏文件跳过并列出 |
| 两端版本不一致 | 缺失功能置灰 | 握手时交换能力标记，不按版本号推断 |

## 13. 分阶段

| 阶段 | 做什么 | 证明什么 |
| --- | --- | --- |
| 0 连通 | 最小设备端只回一个 `steward_ping`，面板只有一个按钮 | 手机能配对、能收发帧、断开能重连。**此步不成立则方案不成立** |
| 1 只读 | 列表与详情接真实队列 | 手机上能判断「有没有事等我」，数据不落后 |
| 2 写操作 | 审批、终止、归档、新建 | 不用电脑也能推进任务；重复点击不重复执行 |
| 3 装起来 | manifest、Service Worker、安装引导、安全区 | 可安装为应用，而非网页 |
| 4 熬一周 | 不加功能，日常使用 | 真正替代「打开电脑看」，并记录缺失项 |

阶段 0 只验证一个前提：复用的连接层在新项目里能否跑通。能，后续是搬代码与写业务；不能，需要重新评估认证与配对是否要自己实现。

## 14. 未决问题

| 问题 | 选项 | 倾向 |
| --- | --- | --- |
| 设备端宿主 | Pi 扩展 / 独立 Node 守护进程 | 先做 Pi 扩展；需要「Pi 退出后面板仍可用」时再拆 |
| device 身份 | 新建 / 与 Pi Reach 共用 | 新建，两套配对互不干扰 |
| 部署位置 | 自有域子域 / 免费托管子域 | 子域，与 Pi Reach 同域不同名 |
| 代码放置 | 独立仓库 / 同 monorepo 新包 | 独立仓库，依赖发布版 `@pi-reach/protocol` |
| 桌面版 | 只做移动 / 响应式兼顾 | 移动优先；桌面继续用电脑上的面板 |

## 15. 已验证的前提

以下结论依据当前仓库实现核对，不是推测；若这些前提改变，方案需重新评估。

- Relay 不解码 `ct`，只按 outer 信封路由，因此自有 inner 帧可复用同一 Relay 实例。
- Relay 中没有 Origin 校验，任意域名的 PWA 均可连接，配对与 ACL 才是准入手段。
- 协议外层（握手、认证、路由）与会话语义解耦，`packages/protocol/outer` 可独立使用。

## 16. 与其他文档的关系

- 管家本体（队列、派发、汇报模型）另见同一轮讨论的方案页，尚未进入本仓库文档体系。
- 本方案的启动顺序建议排在管家本体可用之后：先验证队列与汇报模型够用，再投入客户端。
