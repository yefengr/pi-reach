# Pi Reach Docker E2E

这套基础设施提供两个彼此独立的入口：

- `docker/e2e/runner.mjs` 继续验证 **Relay-only Protocol v2**，不启动 PWA，也不使用浏览器 profile、宿主 `~/.pi`、宿主 `node_modules` 或模型凭据。
- `pwa/playwright.remote.config.ts` 运行真实浏览器回归，只启动 Relay、interactive Pi Extension、生产构建 PWA 和两个隔离的 Chromium context。默认 `pwa test:e2e` 明确排除 `e2e/real/`，不会误启动 Docker 场景。

两个入口都不调用真实模型，不需要模型凭据，也不连接物理设备。

## 固定资源与隔离

Compose project 固定为 `pi-reach-e2e`，所有容器、网络和命名卷均带 `pi-reach-e2e-` 前缀：

- `pi-reach-e2e-relay`：使用仓库根上下文和 `relay/Dockerfile` 构建 Node.js + ws Relay；仅向宿主 loopback 发布 `127.0.0.1:18786`，供本机真实浏览器连接。
- `pi-reach-e2e-interactive`：Linux Node 24，容器内安装 `@earendil-works/pi-coding-agent@0.84.4`，构建并加载当前 `pi-extension`；只运行用户当前打开的 Pi，持久化 HOME、Pi config/session、workspace。
- `pi-reach-e2e-owner-b` 与 `pi-reach-e2e-owner-c`：仅供协议 runner 使用的独立、常驻 Protocol Owner；各自拥有持久 identity/state volume。真实浏览器入口不启动也不依赖它们。

三张 `internal` 数据面网络分别为 `pi-reach-e2e-relay-host`、`pi-reach-e2e-relay-owner-b`、`pi-reach-e2e-relay-owner-c`。interactive 与两个协议 Owner 各自只接入一张数据面网络，Relay 是唯一同时接入三张网络的 Pi Reach 路由节点。

Docker runtime 不允许只连接 `internal` 网络的容器实际发布宿主端口，因此另设彼此独立、非 `internal` 的 host-control plumbing 网络。每张控制网络只连接对应服务，不连接其他节点；所有容器间 Pi Reach route 仍只能经过 `internal` Relay 数据面网络。

| 端口 | 服务 | 独立控制网络 |
| --- | --- | --- |
| `127.0.0.1:18786` | Relay，仅供本机浏览器 | `pi-reach-e2e-control-relay` |
| `127.0.0.1:18787` | interactive control API | `pi-reach-e2e-control-interactive` |
| `127.0.0.1:18788` | owner-b control API | `pi-reach-e2e-control-owner-b` |
| `127.0.0.1:18789` | owner-c control API | `pi-reach-e2e-control-owner-c` |

所有发布端口都显式绑定 `127.0.0.1`，不得改成所有网卡或公网地址。

## 协议入口生命周期

```sh
./docker/e2e/scripts/up.sh              # 幂等构建并启动，保留已有 volumes
./docker/e2e/scripts/verify.sh          # 启动（如必要）并运行协议矩阵，不销毁状态
./docker/e2e/scripts/status.sh          # 输出脱敏状态
./docker/e2e/scripts/stop.sh            # 停止容器，保留全部 volumes
./docker/e2e/scripts/reset.sh           # 明确删除仅此 project 的容器/网络/volumes
```

`runner.mjs` 本身也会按基础 Compose 执行构建与强制重建；调用方先启动的临时 override 不会自动传入。验证不同 Relay 产物时，先确认基础构建入口，再核对运行容器的 image ID 与命令，避免实际仍在验证旧镜像。

脚本对 Docker CLI 与 Compose v2 缺失 fail fast。`up.sh` 与 `verify.sh` 会清除固定 `pi-reach-e2e` project 中已不属于当前 Compose 拓扑的旧 orphan 容器，但保留命名卷；`reset.sh` 从不调用 `docker system prune` 或任何宽泛清理。

## 真实浏览器入口

外部依赖：

- 可用的 Docker CLI、Docker Compose v2 和 Docker daemon；
- 根 workspace 依赖已安装；
- Playwright 桌面 Chromium 已安装；
- loopback 端口 `18786`、`18787` 和 PWA 默认端口 `3102` 未被其他进程占用；
- 固定 `pi-reach-e2e` project 处于停止状态，确保 Playwright 独占前台 Compose 生命周期。

从仓库根运行：

```sh
pnpm --filter pwa test:e2e:remote:list
pnpm --filter pwa test:e2e:remote
```

`docker/e2e/scripts/browser-up.sh` 以前台 `docker compose up relay interactive` 供 Playwright `webServer` 管理，只请求 Relay 和 interactive 服务。Playwright 同时构建 PWA 并通过本地生产预览服务器运行 `/app`。正常结束时 Compose 停止容器，但不执行 `down --volumes`，因此 interactive identity、Pi session 和 workspace 命名卷会保留。异常终止后可运行 `./docker/e2e/scripts/stop.sh`，同样不会删除 volumes。

真实浏览器场景执行以下矩阵：

- 两个真实、相互隔离的 Chromium context 分别通过 Settings UI 保存 loopback Relay URL；
- interactive capability 仅在测试 Node 进程内读取，触发两次新短码；两个 Owner 都通过 PWA `Pairing code` 手工输入和真实 Relay 短码解析完成配对；
- Owner A 通过 `Session actions` 的 `New session` 和确认框发起无需模型的控制动作，并核对 interactive `/state` 的 session ID 已变化；
- 限定执行 `docker compose ... restart relay`，观察 Host 和两个页面断连后自动恢复为 Connected；
- 刷新两个页面，使用摘要核对各自 IndexedDB `identities` 的 Owner public key 与 `devices` 记录未变化，并再次恢复 Connected；
- 配对完成后为两个 context 启动失败保留 trace；失败截图会遮罩 Pairing code 输入框，测试输出不打印短码、Owner secret 或 control capability。

## 协议自动化矩阵

`verify.sh` 使用容器内当前仓库构建产物，且在没有模型凭据时运行。它只打印短指纹、计数、布尔断言和非敏感 ID，绝不输出 URI、配对 token、私钥、完整 public key、`ct` 或消息正文。

- Relay `/health`、Pi RPC `get_state`、Extension `runtime-ready`、relay connection；
- owner-b 仅凭短码通过 Relay 解析目标，再完成 pairing、`session_ready`、`ping`/`pong`；
- owner-c 对新邀请重新解析短码，完成第二 pairing 和独立 session channel；解析不通过时直接失败，不从 Host 控制面注入 endpoint 绕过；
- `/new` 产生 `action_ok` 的 session replacement invariant；
- revoke 对在线目标 Owner 先发送带 binding session/generation 的 `bye(peer_stop)`，再产生 `endpoint_ended` 并拒绝其路由，存活 Owner 继续响应 ping；
- endpoint `peer_stop` bye；
- 普通 Pi 重启后生成新的 endpoint/runtime，并由已配对 Owner 自动发现；
- Extension 公告始终使用 `kind=interactive`，测试拓扑不包含 supervisor、Cron 或后台 Pi。

## 未覆盖范围

真实浏览器入口只使用桌面 Chromium，不代表 Safari、Firefox、移动 viewport 或物理设备验收；它不发送用户 prompt，不验证模型推理、tool execution、thinking、图片、离线 Service Worker 或真实移动网络切换。协议 runner 的 revoke、peer stop 和 Pi 进程重启矩阵也保持在原入口，不在浏览器场景重复执行。
