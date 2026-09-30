# Pi Reach — Relay（Node.js）

Relay 使用 TypeScript、Node.js 和 `ws`，认证 PWA Owner 与 Pi Host 连接，在内存中维护 endpoint/runtime registry、每个 endpoint 的 Owner ACL、订阅与短期配对码，并转发 opaque `ct`。产品拓扑、状态所有权和协议分别见 [ARCHITECTURE](../docs/ARCHITECTURE.md) 与[协议入口](../docs/reference/protocol/README.md)。

## 工程与命令

- 使用根 pnpm workspace、catalog 和锁文件。Node 版本以根 `.node-version` 为准；不新建子项目锁文件。
- `@pi-reach/protocol/outer` 提供共享类型与版本常量。Relay 入站校验、Node crypto 身份验证、连接与 registry 留在本包。
- 根目录执行 `pnpm --filter @pi-reach/relay build`、`pnpm --filter @pi-reach/relay typecheck`、`pnpm test:relay`。局部类型检查前先构建共享包；本包 `build` 已包含此前置步骤。
- `pnpm --filter @pi-reach/relay start` 运行 `dist/main.js`；配置和限额真源为 `src/config.ts`，人类使用说明见 [README](README.md)。
- Docker 从仓库根构建：`docker build -f relay/Dockerfile .`。部署产物必须自包含；不能残留指向 builder workspace 的符号链接。

## 协议与安全

- outer `protocol_version=2`，Host/Owner hello 必须完成随机 challenge 的 Ed25519 验签；身份是标准带 padding 的 canonical Base64 32 字节公钥。
- `(device_id, endpoint_id)` 只有一个权威连接/runtime；takeover 后旧连接不能路由、更新、发布邀请或清理新连接。
- Owner discovery 只返回 ACL 授权的 endpoint；同一 Owner 多连接独立订阅，Host 回包广播给该 Owner 的所有有效连接。
- Owner→Host 禁止携带 source/target Owner，由 Relay 注入 source；Host→Owner 必须带 target 且禁止 source。
- pairing purpose 不等于 session 授权。Relay 不解析 inner protocol，不新增 pairing grant、业务授权或持久队列。
- `ct` 只作为不透明字符串转发，不 decode、parse、log 或 persist。
- strict parser 保留 UUID hex 布局、nullable Option 归一、整数 token 和完整 u64/i64 边界。不要用普通 `JSON.parse`/`JSON.stringify` 替代 `lossless-json.ts`，也不要拿面向客户端的 decoder 代替 Relay 入站校验。
- 认证失败关闭；认证后非法/错误方向帧丢弃；资源超限按已测试的策略关闭，不能静默截断正式消息。
- 只记录结构化事件、角色和结果枚举，不输出正文、`ct`、签名、配对码、私钥或完整公钥。诊断日志必须尊重 stderr 背压。

## 资源与生命周期

- 内存状态在 Relay 重启后由客户端重连重建；不添加数据库、endpoint inventory、离线队列或常驻 Host。
- 所有缓存、连接、待认证连接、发送缓冲和定时器必须有预算/归属/清理路径。
- 慢消费者超限不能挤掉没有积压的健康连接；transport 回调可能同步注销 registry，修改广播或注册逻辑时须验证重入。
- 认证前后的超时、heartbeat、原始 HTTP socket 和 SIGINT/SIGTERM 都要有明确期限，关闭不得遗留句柄。
- CLI 先注册 SIGINT/SIGTERM 处理，再输出 `relay_listening` 就绪事件：Linux 上写管道是同步的，读到就绪事件的一方可能立即发送信号。

## 验证

- `src/*.test.ts` 是 Vitest parser、registry、transport、logger 与服务测试。
- `test/blackbox.test.mjs` 和 `test/numeric.test.mjs` 默认启动本地 Relay；设置 `RELAY_TEST_URL` 可对外部测试实例执行同一行为矩阵，禁止指向生产。
- `test/resources.test.mjs` 仅启动隔离 Node 实例，覆盖资源、真实 TCP 慢消费者、CLI 信号与清理；不能用假 socket 单测替代真实负载证据。
- 修改源代码后执行相关类型、测试、构建和 `git diff --check`；最终包内测试前须有最新 `dist`，`pnpm test:relay` 会自动构建。
- 修改镜像或测试拓扑后核对容器真实命令与 image ID；固定 E2E runner 会按基础 Compose 重建服务，外部 override 不会自动传入。
- 不自动提交、push、发布镜像或远程部署；停止测试服务时保留固定测试身份与卷。
