# Pi Reach — PWA（React + Vite）

浏览器 PWA 子项目。产品路由均位于 `/app` 下（工作区 `/app`、设置页 `/app/settings`）；`/` 使用服务端重定向进入 `/app`，同时保留根路径 Docker healthcheck。

## 技术栈与入口

- React、Vite、TypeScript；版本与 Node 兼容范围以 [`package.json`](package.json) 和锁文件为准。
- Mantine core/hooks 提供基础组件与交互能力；业务 CSS 承担布局、响应式及项目样式。Tailwind 只提供 preflight 与入口，业务组件不使用其间距、颜色和圆角工具类。
- Dexie 管理 IndexedDB；Serwist 与 Vite 构建集成；ZXing 用于二维码扫描，react-markdown/remark-gfm 用于消息展示。
- Vitest 分 Node 与 Browser Mode；Playwright 承担跨模块 E2E。
- 包管理器使用根 pnpm workspace；依赖 catalog、`allowBuilds` 和 overrides 以 [`../pnpm-workspace.yaml`](../pnpm-workspace.yaml) 为准。使用根 `pnpm-lock.yaml`，不创建子项目锁文件，不另用 npm/yarn 安装。

主要入口：

- 页面入口：`index.html` 与 `src/main.tsx`，通过 `/app` 访问；业务组件：`src/components/pwa/`；浏览器业务运行态与存储：`src/lib/pwa/`。
- 协议与传输适配：`src/lib/pi-reach/`；公共 wire 定义来自 `../packages/protocol/`，旧入口只作薄适配，业务与连接状态留在端内。Mantine theme：`src/lib/ui/pi-reach-theme.ts`；产品样式：`src/app/globals.css` 与 `src/app/pwa-theme.css`。
- 开发预览：`pnpm dev` 后访问 `/app/ui-states` 查看当前真实组件的受控状态；`/app/ui-review` 与 `/app/ui-review-stage-a` 保留历史对照。入口由 `src/main.tsx` 的 DEV 分支动态加载，生产构建须核对未包含展厅与评审标识。
- 状态展厅同时演示对话边界与连续输出、导航／只读历史、设置／配对码／确认／通知；导航与回执均由本页内存状态驱动。设置、快捷键和 Composer 传入显式内存偏好，配对仅输入码；不得挂载持久化应用壳、注册 Service Worker、连接 Pi／Relay 或请求摄像头。完整路由、真实连接和设备能力另用正式工作区验收。
- 当前状态所有权见 [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)，设计与组件边界见 [`../docs/DESIGN.md`](../docs/DESIGN.md)；本文件不重复维护架构正文或 token 表。

## 常用命令

首次安装在仓库根执行 `pnpm install --frozen-lockfile`。改动共享协议源码后，局部测试、类型检查或开发服务启动前先执行根 `pnpm --filter @pi-reach/protocol build`，或另开根 `pnpm dev:protocol` 持续编译；根验证与 `dev:pwa` 自动构建共享协议。下列命令在 `pwa/` 中执行，也可从根使用 `pnpm --filter pwa <命令>`：

| 命令 | 用途 |
| --- | --- |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm dev` | 启动开发服务，默认端口 3000 |
| `pnpm build` | 构建共享协议、同步安装脚本静态资源并生成生产构建 |
| `pnpm start` | 用 Vite preview 本地预览 `dist/`，不作为生产服务器 |
| `pnpm lint` | ESLint |
| `pnpm test:unit` | Vitest Node 测试 |
| `pnpm test:component` | Vitest Browser Mode 组件测试，按文件串行以隔离键盘焦点 |
| `pnpm test:component:production` | 仅以 production 编译语义执行 Service Worker 生命周期组件测试 |
| `pnpm test` | 串行执行 Node、默认 Browser Mode 与 production Service Worker 专项 |
| `pnpm test:coverage` | 覆盖率报告 |
| `pnpm test:e2e` | Playwright 本地生产构建与浏览器 E2E，不启动 Docker |
| `pnpm test:e2e:remote:list` | 只列出 Docker 支撑的真实浏览器场景，不启动服务 |
| `pnpm test:e2e:remote` | Docker Relay／Extension 与两个真实浏览器 Owner 的独立回归 |
| `pnpm screenshots` | 用演示数据重新生成 README 截图，写入仓库根 `docs/assets/`；不连接真实 Relay、Pi 或模型，也不属于 `pnpm test` |

命令入口以 `package.json` 为准，测试项目和运行环境分别见 [`vitest.config.ts`](vitest.config.ts)、[`playwright.config.ts`](playwright.config.ts)。ESLint 排除 Playwright/Vitest 报告及 coverage 等生成物，源码与测试源码仍参与检查。不要把文档中的历史测试数量当成当前验证结果。

## 编码与组件约定

- 应用运行在浏览器中，入口复用 `PwaUiProvider`、`PwaAppShell` 和 `PwaApp`。公开环境变量遵循 Vite 规则，不向 bundle 注入完整 `process.env` 或服务端凭据。
- 组件 props 明确类型，不使用 `any`。
- 基础控件直接复用 Mantine，不重新建立仅转发 props 的 `components/ui` 包装层。公共默认值、产品 class 与业务样式的分工遵循 [`../docs/DESIGN.md`](../docs/DESIGN.md)，不以旧 Tailwind-only 描述忽略现有 Mantine。
- 保留业务 CSS 的现有组织方式；颜色与圆角引用 `src/app/pwa-theme.css` 的 `--pwa-*` token，间距按 [`DESIGN`](../docs/DESIGN.md#间距) 的通用档位与领域细档取值（可直接写 px，也可用语义 token）。不擅自引入 CSS Modules 或 styled-components。
- 图片使用浏览器原生资源与现有错误 fallback；data URL 附件按实际消费者处理。界面只使用系统字体栈（见 `src/app/pwa-theme.css`），不引入或下载网络字体。品牌图标由 `scripts/render-brand-icons.mjs` 生成到 `public/`，修改标识几何后重新运行。
- 涉及 Modal、Drawer、Menu、Popover 的调整必须核对 Portal、焦点返回、Escape 竞争、滚动和叠层关系；按项目 overlay 验证技能验收，不仅比较截图。

## 范围与限制

- UI 调整以 [`DESIGN`](../docs/DESIGN.md) 的当前规则为基线；品牌刷新按[活动方案](../docs/plans/active/20260925-pi-reach-brand-refresh.md#分阶段实施)分阶段落地。修改共享布局、全局 CSS、设计 token 或 Mantine theme 时，核对响应式断点两侧的桌面与移动表现。
- 不恢复 landing page、公开文档、教程或法律页面；产品界面仅位于 `/app` 下。
- 不未经授权添加 backend、API routes、账号或其他服务端业务入口。
- 不把历史 room/mesh 模型或尚未实施的主题原型当作当前实现规范；协议与安全边界引用 [协议与安全总览](../docs/reference/protocol/README.md)。
- 不提交 `dist/`、`node_modules/` 等生成物；不通过禁用 lint 或修改生成物规避错误。
- 可以直接在当前分支开发；保留用户既有未提交改动，不自动提交、push 或发布。

## 验证与交付

- PWA 行为变更：执行 `pnpm lint` 和受影响的 Node/Browser Mode 测试。
- 本地 Browser Mode 测试按文件串行（隔离键盘焦点），平均约 1 秒／用例，全量 `pnpm test:component` 需十分钟以上。本地只运行直接覆盖改动的测试文件，即断言了被改组件、选择器或行为的文件，可用 `-t` 进一步缩小到相关用例；不因“可能受影响”在本地运行全量或成批文件。
- 共享布局、全局 CSS、设计 token 等更广的回归由 Pull Request 的 CI（`checks` 与分 4 组的 `pwa-browser`）覆盖：本地定向验证通过后推送，以 CI 结果作为扩大验证的证据，CI 失败时再在本地定向复现。
- 需要逐帧采样或等待动画的测试，采样窗口只覆盖一次过渡所需时长，避免累积等待。
- 生产 bundle 受影响时执行 `pnpm build`；关键跨模块流程增加相关 Playwright 场景。
- UI/Mantine 改动按上述受影响验证要求验收；涉及叠层、焦点或 Portal 时执行 [overlay 验证技能](../.agents/skills/validate-mantine-stacked-overlays/SKILL.md)。
- 纯文档变更核对事实、引用和授权范围，并从仓库根执行 `pnpm check:docs` 与 `git diff --check`，不据此运行或宣称通过业务测试。
- 真实移动设备能力不能用桌面 Chromium 的移动 viewport 代替；尚未结束的设备验收见 [`PWA 加固验收方案`](../docs/plans/active/20260824-pwa-hardening.md)。
- 最终执行受影响验证和 `git diff --check`；只扩展到实际受影响的范围。

## 发布

部署与运维事实统一维护在 [`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md)。PWA 镜像使用仓库根上下文与 `pwa/Dockerfile`，对应白名单为 `pwa/Dockerfile.dockerignore`。生产容器由非 root Nginx 托管 `dist/`，路由配置见 `nginx.conf.template`；本地 E2E 使用 `scripts/start-e2e-server.mjs` 启动 Vite preview。构建生成 `dist/sw.js`，只修改 `src/app/sw.ts` 真源；涉及缓存时验证全新安装后的离线启动。发布、推送和部署需要各自授权。
