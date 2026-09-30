# 产品背景与术语

## 产品与使用场景

Pi Reach 让用户从浏览器连接自己电脑上当前打开、且已加载 Pi Reach Extension 的 Pi。PWA 是控制和阅读入口，实际会话始终由该 Pi runtime 执行，Relay 只负责两端的实时注册、ACL 和路由。

产品路由均位于 `/app` 下（入口 `/app`，设置页 `/app/settings`），根路径 `/` 在服务端重定向到 `/app`。PWA 由 Vite 构建为静态应用并以 Service Worker 提供离线启动，不是账号系统或业务 API 后台。

常见使用过程是：

1. 用户在目标电脑正常打开 Pi；加载后的 Extension 在 `session_start` 自动连接 Relay。
2. 在浏览器中与该电脑配对。每台电脑独立保存 pairing 和 ACL。
3. PWA 按该电脑当前 0、1 或多个在线 Pi 显示空态、自动选择或明确选择。
4. 用户向选中的在线 Pi 发送输入并查看流式输出与正式输出；也可以打开浏览器已保存的正式 timeline，只读查看历史。

PWA 不会启动、唤醒或恢复 Pi。没有当前在线 Pi 时，Relay 和浏览器都不能把电脑变成可控制状态。Extension 的安装范围由用户选择，产品不强制项目级或全局安装；`auto_start_relay` 已不存在。

## 核心概念

| 术语 | 含义与边界 |
| --- | --- |
| Owner | 当前 browser profile 的控制方身份，不是云账号。 |
| device | Host 电脑的稳定身份，也是 pairing 与 ACL 的范围。 |
| endpoint | 一个可路由的当前 Pi 入口。每个普通 Pi 进程生成新的 endpoint，不能由 cwd 推导。 |
| runtime | endpoint 对应的当前 Pi 进程实例。一个进程中的 Extension reload 保持 endpoint/runtime；新进程生成新的身份。 |
| session / history generation | Pi 的当前会话与权威时间线代次。`/new` 只替换 session/generation。 |
| pairing / ACL | Owner 与单台 device 的本地授权关系；不跨电脑传播。 |
| 正式 timeline | PWA 已收到并按 scope 保存的正式事件；它不是 Relay inventory 或远程 Pi 历史列表。 |

`cwd`、名称、PID、model 和 thinking 都是 metadata，不替代 identity。一个 cwd 可以同时有多个 endpoint。详细生命周期见[架构说明](ARCHITECTURE.md#身份与在线状态)。

## 本地数据与信任边界

浏览器、Host 和 Relay 各自拥有不同状态：

- 浏览器 IndexedDB 保存 Owner identity、device pairing、最近 endpoint metadata、设置和正式 timeline。timeline key 是 `device_id + endpoint_id + session_id + history_generation`；下线不删除。
- Host 保存 device identity、Owner pairing/ACL、Relay 配置和 Pi 自己的 session 状态。
- Relay registry 只保存实时连接、endpoint、ACL、订阅及短期 pairing offer；重启或下线后不会保留电脑或历史 inventory。

用户主动移除 pairing 或清除浏览器本地数据时，相关 PWA 数据才删除。PWA local cache 不是云备份，也不是在线证明；发送输入需要实时链路，产品不提供离线发送队列。历史视图只读，不远程 resume 旧 Pi session。

TLS 不等于应用层端到端加密（E2E）。Relay 运营方具有观察流量的能力；配对资料与密钥属于各端本地状态。普通 Pi 会话还会涉及模型调用，不能据此宣称消息绝不离开电脑、不会经过第三方或 Relay 绝不可能看到明文。具体信任边界以[协议入口](reference/protocol/README.md)为准。

## 非目标

当前产品不提供：

- daemon、supervisor、Cron、独立 CLI、后台 Pi，或 PWA 启动/唤醒 Pi；
- 云账号、身份云恢复、多端身份同步或会话历史云同步；
- 远程 Pi 历史 session 浏览、resume 或 Host 历史索引；
- Mesh、Pi-to-Pi 路由、离线发送、浏览器后台可靠执行、锁屏持续连接或 Web Push 保证；
- 应用层 E2EE。

## 继续阅读

- [架构说明](ARCHITECTURE.md)：三端职责、状态所有权、活动选择和本地历史边界。
- [当前设计规则](DESIGN.md)：桌面/移动导航、Drawer、token 和实时/历史视觉规则。
- [协议入口](reference/protocol/README.md)：身份、配对码、消息与信任边界；详细定义见[会话协议](reference/protocol/protocol-v2.md)和[配对协议](reference/protocol/pairing.md)。
- [纯 Extension ADR](adr/20260914-pure-extension-runtime.md)：当前决策、兼容窗口和非目标。
- [路线图](ROADMAP.md)：已确定事项及唯一项目级状态。
