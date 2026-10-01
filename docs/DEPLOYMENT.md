# Pi Reach 自托管部署

本文记录把 Relay/PWA 发布到远程 Linux 服务器的可重复流程：常规版本由 GitHub Actions 的 Deploy 工作流构建、经审批后部署（见「自动部署」），本机脚本用于备用发布、更新 Compose 文件与首次初始化。自 2026-09-30 起只保留一个环境：原隔离测试服务（`site-test`、`relay-test`）、test/promote 状态文件和旧域名均已移除，部署直接更新线上服务。本机部署命令只选择 scope：

```text
./scripts/deploy-self-hosted.sh [pwa|relay|both]
  本机构建 -> SSH 传输 -> 更新所选服务 -> 健康检查与公网检查 -> 清理旧镜像
```

省略 scope 时默认 `both`。部署没有隔离测试阶段，发布前须完成受影响的验证（见仓库根 `AGENTS.md` 的常用验证）。本机脚本默认不推送 Docker Hub，镜像经 SSH 传输，不要求服务器从镜像仓库拉取应用镜像；自动部署则由服务器从 GHCR 按摘要拉取。本机 Buildx 构建仍需能够取得 Dockerfile 使用的基础镜像和构建依赖。Caddy 只在首次初始化或域名/端口变化时调整，普通版本部署不修改 Caddy。

Node 工程使用根 pnpm workspace；开发工具链由根 `package.json`、`.node-version` 和 `pnpm-workspace.yaml` 固定。私有共享包 `packages/protocol` 由根安装的 `prepare` 与 workspace 构建流程产出；PWA 及 E2E Host、Owner 的 Docker 构建输入均包含其源码，并通过根 workspace 安装和构建，不依赖独立发布的共享包。PWA Dockerfile 位于 `pwa/`，构建上下文必须是仓库根，由 `pwa/Dockerfile.dockerignore` 限定可复制的输入。PWA 在 Node 构建阶段生成 `pwa/dist/`，运行镜像以非 root Nginx 托管 `/usr/share/nginx/html`，不运行 Node 应用服务器。配置真源为 [`pwa/nginx.conf.template`](../pwa/nginx.conf.template)，由容器入口使用 `PORT` 渲染，默认端口仍为 3000；保留 curl 和根路径健康检查，现有 Compose 端口及外层 Caddy 反向代理不变。

PWA 根路径返回 307 到 `/app`；`/app/` 规范化到 `/app`，`/app/<子路径>`（如 `/app/settings`）返回应用入口 HTML 并由前端识别；其他缺失页面和资源返回 404，不统一回退到 HTML。HTML、`/sw.js` 和 `/manifest.webmanifest` 使用 `Cache-Control: no-cache`，存在的 `/assets/` 哈希资源使用长期 immutable 缓存。`pnpm start` 和 E2E 启动脚本仅供本地 Vite preview，生产运行方式以 Dockerfile 为准。

这是已有环境的版本发布流程，不是空服务器的一键初始化流程；首次初始化仍需按下文完成服务器准备和 Caddy 配置。系统职责和数据边界见 [ARCHITECTURE](ARCHITECTURE.md)，部署步骤以本文件及下列脚本、配置为准。

## 文件职责

| 文件 | 作用 | 是否提交 |
|---|---|---|
| `docker-compose.yml` | Relay 与 PWA 的运行编排，Compose 项目名固定为 `pi-reach` | 是 |
| `deploy.env.example` | 部署变量模板，不含真实值 | 是 |
| `deploy.env` | 本机真实 SSH/服务器配置 | 否，已加入 `.gitignore` |
| `scripts/deploy-self-hosted.sh` | 本机按 scope 部署并验收 | 是 |
| `.github/workflows/deploy.yml` | 自动部署：构建并推送 GHCR 镜像，审批后部署，创建标签与 Release | 是 |
| `scripts/deploy-from-ci.sh` | 自动部署的服务器端入口，只能由受限 SSH 密钥触发；由维护者手工安装到服务器 | 是 |
| `/etc/caddy/Caddyfile` | 服务器 HTTPS 与反向代理 | 服务器 root 配置，不由部署脚本修改 |

`deploy.env` 不得保存私钥、服务器密码或 Docker Hub Token。SSH 私钥由本机 SSH 客户端和 `~/.ssh/config` 管理；需要 Docker Hub 登录时，在交互式终端中单独执行 `docker login`。

## 一次性准备

### 本机

要求：

- Docker Engine/OrbStack/Docker Desktop；
- Docker Buildx；
- `ssh`、`scp`、`gzip`、`curl`；
- SSH 别名已经写入本机 `~/.ssh/config`；
- SSH 登录账号能够直接运行 `docker` 和 `docker-compose`。

创建本机配置：

```bash
cp deploy.env.example deploy.env
$EDITOR deploy.env
chmod 600 deploy.env
```

最小配置示例（使用占位符，不要直接照抄真实信息；版本仅为示例，发布时使用本次核验的镜像标签）：

```dotenv
DEPLOY_SSH=your-ssh-alias
DEPLOY_USER=your-deploy-user
REMOTE_DIR=/home/your-deploy-user/pi-reach
IMAGE_NAMESPACE=pi-reach-local
RELAY_VERSION=v0.0.1
SITE_VERSION=v0.0.1
PUBLISH_IMAGES=0
PWA_URL=https://pwa.example.com/app
RELAY_URL=https://relay.example.com
KEEP_IMAGE_ARCHIVE=0
KEEP_IMAGE_VERSIONS=3
```

先验证 SSH：

```bash
ssh "$DEPLOY_USER@$DEPLOY_SSH" \
  'uname -m && docker info --format "Server={{.ServerVersion}}" && docker-compose version'
```

服务器必须是 `x86_64/amd64` 或 `aarch64/arm64`。部署账号需要能够执行：

```bash
docker info
docker-compose version
docker load
docker-compose up -d
```

### 服务器

服务器部署目录可以提前创建：

```bash
mkdir -p /home/your-deploy-user/pi-reach
```

服务器使用 rootful Docker 时，部署账号通常加入 Docker 用户组。该权限接近 root，只应授予专用部署账号：

```bash
sudo groupadd --system docker  # 已存在时忽略错误
sudo usermod -aG docker your-deploy-user
```

重新登录后验证：

```bash
id
docker info
docker-compose version
```

服务器不需要安装 Caddy 才能运行容器；Caddy 是宿主机上的一次性 HTTPS 入口。

## 自动部署

常规版本由 [Deploy 工作流](../.github/workflows/deploy.yml)发布，决策见 [ADR-20261001](adr/20261001-ci-deploy-ghcr.md)：

1. 修改 `relay/package.json` 或 `pwa/package.json` 的 `version`，经 Pull Request 合并到 `main`；也可在 Actions 页面手动运行并选择组件。对应的 `relay-vX.Y.Z`／`pwa-vX.Y.Z` 标签已存在时跳过该组件。
2. 工作流在 GitHub 托管 runner 上构建服务器架构的镜像，推送到 `ghcr.io/<owner>/pi-reach-relay`／`pi-reach-site:vX.Y.Z`，并附构建来源证明。
3. 部署作业进入 `production` Environment，等待维护者批准。
4. 批准后以受限 SSH 密钥连接服务器，`deploy-from-ci.sh` 按摘要拉取镜像，只更新所选服务；健康检查失败时恢复部署前的镜像，工作流以失败结束。两者都部署时先 Relay 后 PWA。
5. 公网检查通过后，在本次提交上创建注解标签与 GitHub Release（不标记 Latest）。说明列出自上一个同组件标签以来涉及该组件的提交，必要时再手工补充。

协议有变更时，仍须在 PWA 部署完成后再批准 Extension 的 npm 待审版本（见「Extension npm 发布」）。部署 Relay 会让在线连接短暂断开，可选择合适的时机批准。

自动部署与本机脚本共用服务器上的部署锁，二者不会同时更新服务。自动部署不上传 `docker-compose.yml`，也不更新服务器上的 `deploy-from-ci.sh`；这两个文件变更后，先用本机脚本部署一次或手工复制，再依赖自动部署。

### 一次性配置

GitHub（仓库 Settings → Environments）：

- 新建 `production`：Required reviewers 选维护者，Deployment branches 限定为 `main`。
- Environment secrets：`DEPLOY_SSH_KEY`（下文专用私钥全文）、`DEPLOY_KNOWN_HOSTS`（服务器主机公钥行）、`DEPLOY_HOST`、`DEPLOY_USER`。仓库公开，Actions 日志所有人可见，主机与账号也放在 Secrets 中，由日志遮盖。
- Environment variables：`PWA_URL`、`RELAY_URL`（公网检查地址，留空则跳过）；SSH 端口不是 22 时设 `DEPLOY_PORT`。
- 服务器不是 `linux/amd64` 时，设仓库变量 `DEPLOY_PLATFORM`（如 `linux/arm64`）。

本机生成专用密钥，不复用个人密钥；私钥只放进上面的 Secret：

```bash
ssh-keygen -t ed25519 -N "" -C pi-reach-github-deploy -f ~/.ssh/pi-reach-github-deploy
ssh-keyscan -t ed25519 your-server-host   # 输出即 DEPLOY_KNOWN_HOSTS；非 22 端口加 -p，主机写作 [host]:port
```

`ssh-keyscan` 的结果须与服务器上 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 显示的指纹一致后再使用。

服务器上，把脚本复制到部署目录下（路径与 `REMOTE_DIR` 一致）：

```bash
# 本机执行
ssh your-deploy-user@your-ssh-alias 'mkdir -p /home/your-deploy-user/pi-reach/bin'
scp scripts/deploy-from-ci.sh your-deploy-user@your-ssh-alias:/home/your-deploy-user/pi-reach/bin/
ssh your-deploy-user@your-ssh-alias 'chmod 755 /home/your-deploy-user/pi-reach/bin/deploy-from-ci.sh'
```

再在部署账号的 `~/.ssh/authorized_keys` 末尾加一行（整条写在同一行，公钥取自 `pi-reach-github-deploy.pub`）：

```text
restrict,command="PI_REACH_REMOTE_DIR=/home/your-deploy-user/pi-reach PI_REACH_IMAGE_PREFIX=ghcr.io/your-github-owner /home/your-deploy-user/pi-reach/bin/deploy-from-ci.sh" ssh-ed25519 AAAA... pi-reach-github-deploy
```

`restrict` 关闭端口转发、终端与用户 rc 文件，`command=` 让这把密钥无论请求什么都只运行 `deploy-from-ci.sh`。脚本只接受 `deploy <site|relay> <前缀>/pi-reach-<site|relay>:vX.Y.Z@sha256:<摘要>`，其余请求一律拒绝，不调用 Docker。可选的 `PI_REACH_KEEP_IMAGE_VERSIONS` 控制保留的镜像数（默认 3），写在同一个 `command=` 中。

### 首次运行

GHCR 上新建的镜像包默认私有，服务器无法匿名拉取。首次运行时，在构建完成、部署作业等待审批期间，到 GitHub 个人主页的 Packages 中把 `pi-reach-relay` 与 `pi-reach-site` 的可见性改为 Public（改为公开后不能再改回私有），确认它们关联到本仓库，再批准部署。两个镜像只含开源代码与构建产物，不含配置或密钥。

### 失败处理

- 构建失败或审批前取消：线上不受影响，修复后重新运行。
- 服务器端健康检查失败：脚本已恢复原镜像，工作流失败且不打标签；排查后重新运行失败的作业，已打过标签的组件会跳过。输出提示恢复也失败时，立即按「容器不是 healthy」检查服务器。
- 公网检查失败：服务已更新但没有打标签；确认线上状态后重新运行，或按「版本标签与 GitHub Release」手工补标签。
- 部署锁冲突与遗留锁的处理同本机脚本（见「部署」）。

## 部署

本机脚本用于备用发布、更新 `docker-compose.yml` 与首次初始化。命令形式为：

```bash
./scripts/deploy-self-hosted.sh [pwa|relay|both]
```

`pwa` 只处理 PWA 镜像和 `site`，`relay` 只处理 Relay 镜像和 `relay`，`both` 处理两者；不带参数等价于 `both`。`deploy.env` 中的 `SCOPE` 不会覆盖命令行选择和默认值。已移除的 `test`、`promote` 参数按用法错误拒绝。

远端 Docker 检查通过后，脚本会在 `REMOTE_DIR` 下原子创建 `.pi-reach-deploy-lock`；同一部署目录已有运行中部署或遗留锁时，会在本机构建、镜像传输和 `docker-compose up` 前拒绝执行。正常退出及可处理的错误或中断会释放锁；`SIGKILL`、网络硬断等情况可能留下 stale lock。遇到锁冲突时，先核对本机和服务器均无部署进程，再在服务器手工执行 `rmdir /实际/REMOTE_DIR/.pi-reach-deploy-lock`。脚本不会自动抢占或删除未知锁。

脚本会：

1. 读取未提交的 `deploy.env`，检查 SSH、Docker 与 Compose；
2. 只为所选 scope 构建对应服务器架构的镜像，可选推送远程镜像；
3. 上传 `docker-compose.yml`，只压缩并传输所选镜像，并记录远端镜像 ID 摘要；
4. 使用 scope 对应的镜像插值运行远端 `docker-compose config --quiet`，解析失败时不更新任何服务；
5. 只更新所选服务，并等待每个容器变为 `healthy`；
6. 按 scope 检查 `RELAY_URL` 的 `/health` 与 `PWA_URL`，变量留空时跳过对应检查；
7. 在服务器和本机分别清理所选服务的旧镜像：每个镜像仓库保留本次部署的标签及最新的其他标签，共 `KEEP_IMAGE_VERSIONS` 个（默认 3），删除更旧的标签和带 `pi-reach.image` 标签的悬空镜像。

镜像清理只处理本次部署的 `pi-reach-relay`、`pi-reach-site` 仓库和带 `pi-reach.image` 标签的悬空镜像，跳过任何容器（包括已停止容器）正在使用的镜像；`KEEP_IMAGE_VERSIONS=0` 关闭清理。清理只在健康检查和公网检查通过后执行，失败时只输出警告，不改变部署结果。

单服务 scope 解析 Compose 时会把未选服务的镜像变量替换为固定无效占位符，未选服务不会出现在 build、transfer 或 `docker-compose up` 操作中。日志中的部署元数据只包含 scope、所选镜像引用与 ID 摘要，不打印 `deploy.env` 内容、SSH 凭据或有效配置正文。

部署后人工打开 PWA 复核，建议至少检查：

- 页面资源和静态文件正常；
- PWA 设置中的 Relay URL 正确；
- 新二维码扫描或粘贴配对流程；
- device/endpoint 列表、当前 endpoint 选择和连接状态；
- 发送消息、接收输出、刷新页面后的本地历史；
- 浏览器 Console 和 Relay 日志无异常。

脚本不执行自动回滚；若更新服务后健康检查或公网检查失败，应先核对实际容器状态并单独确认恢复方案（例如检出上一个可用提交后重新部署），不把脚本退出失败理解为线上环境已自动恢复。

## 镜像模式

### 默认：本地构建并传输

```dotenv
PUBLISH_IMAGES=0
```

镜像只在本机 Buildx 和服务器 Docker 中存在，标签由 `IMAGE_NAMESPACE`、`RELAY_VERSION` 和 `SITE_VERSION` 组成；构建时附加 `pi-reach.image=relay|site` 镜像标签，供清理步骤识别被新版本顶替后失去标签的本项目镜像。每次部署递增所选服务的版本，避免同一标签指向不同构建。服务器 Compose 使用脚本注入的 `RELAY_IMAGE`、`SITE_IMAGE`，不会把本机命名空间写入仓库文件。

如服务器是 `x86_64`，脚本相当于构建：

```bash
docker buildx build --platform linux/amd64 --load \
  --tag pi-reach-local/pi-reach-site:v0.0.1 --file pwa/Dockerfile .

docker buildx build --platform linux/amd64 --load \
  --tag pi-reach-local/pi-reach-relay:v0.0.1 --file relay/Dockerfile .
```

Relay 镜像同样以仓库根为构建上下文，使用根锁文件构建 Node 服务和私有共享协议包。运行层使用非 root Node 用户，自包含生产依赖；入口为 `node dist/main.js`，端口仍由 `PI_REACH_RELAY_PORT` 控制，健康检查仍为 `/health`。资源与超时配置见 [Relay README](../relay/README.md#resource-limits)。停止容器时应预留不小于 Relay shutdown deadline 的时间。

本地隔离 Relay 验收使用 `docker/e2e/compose.yml`。其 runner 会按该文件重新构建、重建服务，临时 overlay 不会自动继承到 runner 内部。验收前核对容器 image ID 和入口；不能用线上 PWA 启动成功代替 Node Relay 验收，也不能用本地通过推断远程版本已切换。

随后执行等价的流式传输：

```bash
docker save \
  pi-reach-local/pi-reach-relay:v0.0.1 \
  pi-reach-local/pi-reach-site:v0.0.1 \
  | gzip \
  | ssh your-deploy-user@your-ssh-alias 'gzip -dc | docker load'
```

服务器启动时使用：

```bash
docker-compose up -d --pull never
```

### 可选：同时推送远程镜像

只有明确需要给其他机器拉取镜像时才开启：

```dotenv
IMAGE_NAMESPACE=your-dockerhub-user
PUBLISH_IMAGES=1
```

先确保本机已经登录目标仓库：

```bash
docker login
```

此模式会额外执行 Buildx `--push`。它推送当前服务器架构的镜像；多架构公共发布仍可单独使用：

```bash
IMAGE=your-dockerhub-user/pi-reach-site ./pwa/push-docker.sh v0.0.1
IMAGE=your-dockerhub-user/pi-reach-relay ./relay/push-docker.sh
```

不要把 Token 写入 `deploy.env`、脚本、Compose 或 Git。

## Compose 运行结构

当前 Compose 项目名固定为 `pi-reach`，包含两个服务：

```text
Relay: 127.0.0.1:3000 -> 容器 3000（容器 pi-reach-relay）
PWA:   127.0.0.1:3001 -> 容器 3000（容器 pi-reach-site）
```

当前 [Compose](../docker-compose.yml) 的 Relay 服务没有业务卷或 SQLite membership 存储。Relay 的 endpoint registry 和 ACL 仅保存在内存中，重启后由 Host/Owner 重连重建；旧环境是否残留历史 volume 不在本流程中自动清理。PWA 不保存服务端业务会话数据，浏览器本地使用 IndexedDB；Host 身份、配对和 Pi 会话保存在运行 Pi 的电脑上，而不是这些 Relay/PWA 容器中。

源码子项目已名为 `pwa/`，但 Compose 服务 `site`、镜像名 `pi-reach-site` 和变量 `SITE_VERSION` / `SITE_IMAGE` 仍是当前脚本使用的名称。执行部署命令时不要仅按目录新名称替换它们。

服务器上查看状态。Compose 文件的镜像变量只由部署脚本注入，手工排查直接按容器名查看，避免 `docker-compose ps` 因变量未设置而解析失败：

```bash
docker ps --filter name=pi-reach
docker logs --tail=100 pi-reach-relay
docker logs --tail=100 pi-reach-site
```

服务器本机健康检查：

```bash
curl http://127.0.0.1:3000/health
curl -I http://127.0.0.1:3001/app
```

## Caddy 一次性配置

普通版本部署不修改 Caddy。只有首次部署、域名变化或容器端口变化时才需要调整。

假设使用两个域名：

```text
pwa.example.com
relay.example.com
```

DNS 都指向服务器公网 IP，并在云厂商安全组/防火墙开放 TCP `80` 和 `443`。不要把 `3000`、`3001` 暴露到公网。

Caddyfile 追加：

```caddyfile
pwa.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3001
}

relay.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

应用配置前先检查：

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Caddy 会自动申请和续期公开 HTTPS 证书，并自动转发 Relay 的 WebSocket Upgrade。客户端使用 HTTPS Relay URL：

```text
PWA Relay URL: https://relay.example.com
Pi extension:  https://relay.example.com
```

## 配对检查

二维码当前不携带 Relay 地址。切换到自建 Relay 后，必须在 PWA 设置中保存：

```text
https://relay.example.com
```

然后在 Pi 重新生成二维码：

```text
/pi-reach pair
```

配对超时时，先确认 PWA 和 Pi 使用同一个 Relay。服务器查看 Relay 日志：

```bash
docker logs -f pi-reach-relay
```

一次成功的配对应能看到 Pi 和浏览器两条认证连接。二维码或复制代码包含一次性凭据，不要写入文档、日志、Issue 或聊天记录。

## 发布脚本

`pwa/push-docker.sh` 和 `relay/push-docker.sh` 支持通过 `IMAGE` 覆盖镜像名：

```bash
IMAGE=your-dockerhub-user/pi-reach-site ./pwa/push-docker.sh v0.0.1
IMAGE=your-dockerhub-user/pi-reach-relay ./relay/push-docker.sh
```

不传 `IMAGE` 时使用 `REGISTRY_NAMESPACE`，再没有时使用本地占位命名空间。日常服务器部署不需要调用这两个发布脚本，直接执行 `./scripts/deploy-self-hosted.sh` 即可。

## Extension npm 发布

Extension 以 `@yefengr/pi-reach` 发布到 npm。常规发布由 Release 工作流（`.github/workflows/release.yml`）完成：`pi-extension/package.json` 的版本号变更合并到 `main` 后，工作流以 npm trusted publishing（GitHub OIDC）认证，运行 `pi-extension/publish-npm.sh --stage` 把新版本提交到 npm 待审区，维护者在 npmjs.com 用双重验证批准后才正式上线。仓库和 GitHub 中不保存 npm token。版本号一经发布不可复用。

`publish-npm.sh` 确认该版本尚未发布，运行 Extension 的 `pnpm verify`，用 `pnpm pack` 打包并检查 tarball，再以公开访问上传这个 tarball。默认直接发布；`--stage` 改为执行 `npm stage publish` 提交待审，需要 npm 11.15.0 或更高版本。

发布步骤：

1. 协议有变更时先部署 PWA，再发布 Extension（[ADR-20260927](adr/20260927-run-end-event.md)）；可核对线上 PWA 的脚本是否已包含新增的帧或事件类型。
2. 修改 `pi-extension/package.json` 的 `version`，经 Pull Request 合并到 `main`。
3. Release 工作流确认版本号确有变化且 npm 上尚无该版本后提交待审；版本号未变的推送（如只改依赖）或该版本已发布时跳过。也可在 Actions 页面手动运行，此时不比较版本号。
4. 在 npmjs.com 的 Staged Packages 中核对并批准，或在交互式终端执行 `npm stage list @yefengr/pi-reach` 与 `npm stage approve <stage-id>`；批准需要双重验证。

npm 侧一次性配置（需要网页登录与双重验证）：

- 在包设置的 Trusted publishing 中添加 GitHub Actions：用户 `yefengr`、仓库 `pi-reach`、工作流文件 `release.yml`，Environment 留空，不勾选允许直接 `npm publish`（`npm stage publish` 始终允许）。工作流改名时同步修改此配置。
- Release 工作流跑通后，把包设置的 Publishing access 改为 “Require two-factor authentication and disallow tokens”，并撤销可跳过双重验证的 token。

本地发布（备用）：

- 认证使用交互式终端的 `npm login` 或环境变量 `NPM_TOKEN`。使用 `NPM_TOKEN` 时，脚本写入只引用该变量的临时 npmrc，token 不落盘。
- `bash pi-extension/publish-npm.sh --stage` 提交待审，不需要双重验证。不加 `--stage` 时直接发布：交互式会话需要输入验证码，非交互环境（CI、agent 的 shell）只能使用可跳过双重验证的 token；包设置禁止 token 后，token 只能提交待审。
- 可跳过双重验证的细粒度 token 不能执行 `npm unpublish`。

核对：

```bash
npm view @yefengr/pi-reach version
```

新版本在批准或直接发布后才出现在 registry。npm 异步处理上传（返回 202），新版本通常几分钟后才可见，可能超过脚本直接发布时约 60 秒的确认等待；脚本此时只给出警告，稍后用 `npm view` 核对即可。处理完成前对同一个包执行 `npm deprecate` 会返回 422。首次发布新包时，npm 会自动生成 `0.0.0-stage` 占位版本，无需处理。发布后按 [Extension 协作规范](../pi-extension/AGENTS.md)在仓库之外安装并加载新版本。

## 版本标签与 GitHub Release

各组件上线后，在其版本号所在的 `main` 提交上打注解标签，并创建同名 GitHub Release。PWA 与 Relay 经自动部署时由工作流创建；下面的手工命令用于 Extension 和本机备用部署：

| 组件 | 标签 | 版本来源 |
|---|---|---|
| Extension | `extension-vX.Y.Z` | `pi-extension/package.json`，即 npm 上的 `@yefengr/pi-reach@X.Y.Z` |
| PWA | `pwa-vX.Y.Z` | `pwa/package.json`；部署时 `SITE_VERSION` 使用 `vX.Y.Z` |
| Relay | `relay-vX.Y.Z` | `relay/package.json`；部署时 `RELAY_VERSION` 使用 `vX.Y.Z` |

- Extension 在 npm 批准上线后打标签，PWA 与 Relay 在部署并核对后打标签；同一提交可以同时带多个组件的标签。
- Release 说明写该组件的变更与发布去向（npm 版本，或线上地址与镜像标签）。Extension 的 Release 标记为 Latest，其余不标记。

每个上线的组件各执行一组命令；各组件版本号相互独立，`--verify-tag` 要求标签已推送到远端：

```bash
git tag -a extension-vX.Y.Z -m "Extension X.Y.Z" <commit> && git push origin extension-vX.Y.Z
gh release create extension-vX.Y.Z --verify-tag --title "Extension X.Y.Z" --notes-file extension.md --latest

git tag -a pwa-vX.Y.Z -m "PWA X.Y.Z" <commit> && git push origin pwa-vX.Y.Z
gh release create pwa-vX.Y.Z --verify-tag --title "PWA X.Y.Z" --notes-file pwa.md --latest=false

git tag -a relay-vX.Y.Z -m "Relay X.Y.Z" <commit> && git push origin relay-vX.Y.Z
gh release create relay-vX.Y.Z --verify-tag --title "Relay X.Y.Z" --notes-file relay.md --latest=false
```

## 故障排查

### `docker compose` 不存在

服务器可能安装的是独立命令：

```bash
docker-compose version
```

部署脚本使用 `docker-compose`，与当前服务器环境一致。

### Docker Hub 超时

先区分失败发生在本机基础镜像/依赖获取、可选镜像推送，还是 SSH 镜像传输。`PUBLISH_IMAGES=0` 只关闭应用镜像推送，不消除本机构建对基础镜像和依赖源的需求；服务器接收的是本机传输的镜像，不需要从 Docker Hub 拉取这些应用镜像。

本机脚本默认使用 `docker-container` 驱动的 Buildx 构建器，它不继承 Docker 守护进程的代理设置。守护进程能拉取镜像、构建却在解析 `docker/dockerfile` 时超时，可改用 `docker` 驱动的构建器，例如 `BUILDER=<构建器名> ./scripts/deploy-self-hosted.sh pwa`（`docker buildx ls` 查看可用构建器）。自动部署在 GitHub 托管 runner 上构建，不受本机网络影响。

### 容器不是 healthy

```bash
docker ps --filter name=pi-reach
docker logs --tail=200 pi-reach-relay
docker logs --tail=200 pi-reach-site
curl http://127.0.0.1:3000/health
curl -I http://127.0.0.1:3001/app
```

### HTTPS 失败

确认：

- DNS A/AAAA 记录指向服务器；
- TCP `80/443` 已开放；
- Caddyfile 校验通过；
- 容器本机端口正常；
- Caddy 服务状态为 `active`。

```bash
sudo systemctl status caddy --no-pager
sudo journalctl -u caddy -n 100 --no-pager
```

不要为了绕过证书问题把客户端改成公网 `ws://`，生产环境必须使用 HTTPS/WSS。

## 安全边界

部署脚本不会：

- 读取、上传或修改 SSH 私钥；
- 读取或保存服务器密码、Docker Hub Token；
- 修改 `/etc/caddy/Caddyfile`；
- 重启 Docker daemon；
- 停止无关容器；
- 执行 `docker system prune`，或删除本项目镜像仓库和 `pi-reach.image` 标签以外的镜像；
- 在默认模式下向 Docker Hub 推送应用镜像，或要求服务器拉取这些应用镜像。

自动部署的服务器端脚本只接受固定格式的单个部署请求，不执行其他命令，不修改 Compose 文件、Caddy 或自身；GitHub 中的专用私钥只在 `production` Environment 批准后的作业中可用，不能用于登录终端或转发端口。
