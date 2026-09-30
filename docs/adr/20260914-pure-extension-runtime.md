# ADR-20260914: 纯 Extension 运行时

- 状态：已接受
- 日期：2026-09-14

## 背景

Pi Reach 需要远程控制用户当前打开的 Pi，而不是维持另一套可独立启动、恢复或调度 Pi 的宿主服务。旧 supervisor/daemon 路径引入了额外进程、常驻服务、生命周期门禁和误导性的在线预期，且与普通 Pi Extension 的运行时边界重复。

PWA 仍需要把活动会话和已保存的历史严格区分：Relay 的 registry 只能说明此刻在线，浏览器本地已收到的正式 timeline 则应在离线后继续可读。

## 决策

采用以下当前产品拓扑：

```text
PWA <-> Relay <-> 用户当前打开且已加载 Pi Reach Extension 的 Pi
```

- 不提供 daemon、supervisor、Cron、独立 CLI、后台 Pi，或由 PWA 启动/唤醒 Pi 的能力。
- Extension 在 Pi `session_start` 自动连接 Relay；不再存在 `auto_start_relay` 开关。用户自行决定 Extension 的安装范围，产品不强制项目级或全局安装。
- Host 的电脑 device identity、Owner pairing 和本机 ACL 持久保存。每个普通 Pi 进程生成新的 `endpoint_id` 和 runtime；同一进程中的 Extension reload 保持该身份，不能按 `cwd` 固定 endpoint。
- Relay registry 只保存实时 endpoint、ACL、订阅和短期 pairing offer，不是电脑、会话或历史 inventory。
- PWA 对活动电脑按 0/1/N 在线 Pi 处理选择。正式 timeline 以 `device_id + endpoint_id + session_id + history_generation` 持久写入 IndexedDB；下线不删除，只有用户移除配对或清除本地数据才删除。历史只读，阅读历史不得被实时自动选择抢走。
- 新 Extension 仅发送 `metadata.kind = interactive`。Relay、Protocol v2 和 PWA decoder 在滚动兼容窗口内仍接受旧 `daemon`，但该值不表示现行产品模式，也不恢复旧生命周期。

Relay 的 WebSocket 认证、ACL 路由和内存 registry 职责不变，不为本决策新增 Relay 架构层。

## 后果

- 用户必须先在目标电脑打开 Pi；电脑休眠、Pi 退出或 Extension 未加载时，PWA 只能显示离线，不能远程恢复该进程。
- 一个电脑可同时有多个当前 Pi endpoint；`cwd`、PID、名称、model 和 thinking 只是展示 metadata。
- PWA 需要明确展示活动 Pi 和本地历史，且在移动端通过导航 Drawer 提供同等选择能力。
- 兼容窗口结束前，消费者必须把旧 `daemon` 当作可显示的旧 metadata，而不是可启动、可调度或稳定 endpoint 的信号。

## 备选方案

- **保留 supervisor 作为可选常驻模式**：拒绝。它继续扩大安装、运维与生命周期表面，并使“在线”被误解为可从 PWA 启动。
- **PWA 通过 Relay 唤醒后台 Pi**：拒绝。Relay 不是设备唤醒服务，也不运行 Pi。
- **按 cwd 复用 endpoint**：拒绝。同一目录可以同时有多个 Pi，cwd 不是 runtime identity。
- **下线时删除浏览器 timeline**：拒绝。在线状态与已保存的正式历史属于不同所有权和生命周期。

## 非目标

本决策不引入远程 Host 历史索引、账号、云同步、E2EE、离线发送、后台浏览器执行、远程 Pi session resume、Pi-to-Pi 路由或 Relay 持久数据库。

## 兼容窗口

兼容仅限 Protocol/Relay/PWA decoder 对旧 `metadata.kind = daemon` 的读取。新 Extension 不再发送该值，产品文档不再提供 daemon 安装、管理或调度入口。移除兼容读取前，需要单独确认已不再有需要展示的旧 endpoint metadata，并记录替代 ADR 或版本说明。
