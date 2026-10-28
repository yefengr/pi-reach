# 复现本次 PWA 生产编译对照

这些脚本生成实验专用生产编译，不是发布入口，也不会部署服务器。它们只在仓库的 `.pi/tmp/pwa-production-ab/` 下写隔离快照、构建和测量文件；正式浏览器使用新建的本地临时 context，不访问真实 Relay 或模型。

## 前置条件

- 在 Pi Reach 仓库根运行，能够读取报告中两个 Git 提交。
- Node、pnpm 与依赖安装遵循根 `package.json`、`.node-version` 和锁文件。已安装依赖须与本次目标锁文件一致；脚本复用当前 `node_modules`，不会联网安装。
- 已有与项目 Playwright 匹配的 Chromium 缓存。不同浏览器、系统或硬件可以复现方法，但不能要求得到相同绝对毫秒数。
- 留出独占的浏览器测试窗口；不同时跑构建、其他浏览器套件或性能负载。报告没有把桌面移动尺寸窗口当作手机。

## 执行

从仓库根复制脚本到约定的临时目录：

```bash
mkdir -p .pi/tmp/pwa-production-ab
cp -R docs/plans/completed/20261021-pwa-production-ab-report/reproduce/. .pi/tmp/pwa-production-ab/
node .pi/tmp/pwa-production-ab/build.mjs
node .pi/tmp/pwa-production-ab/run.mjs --pilot --scenarios=text60,tool-reader60
node .pi/tmp/pwa-production-ab/run.mjs
node .pi/tmp/pwa-production-ab/summarize.mjs
node .pi/tmp/pwa-production-ab/render-tables.mjs
```

正式回放必须包含全部六个场景，按 AB、BA、AB、BA 各运行一对，共 48 个样本。`--scenarios` 只供 pilot 使用，pilot 不能进入正式结论。

每次尝试保存在临时目录 `runs/` 中的带时间文件；`raw-results.json` 和 `pilot-results.json` 是最近一次尝试的副本。无效样本会停止本轮并保留错误，不自动跳过、补齐或选取最好数据。

脚本会在成功或失败收尾时关闭其浏览器和临时 HTTP 服务。若手动中断进程，应确认没有遗留对应的 Chromium 子进程和监听端口，不要误停已有开发服务。

## 产物解释

- `build-manifest.json`：版本、生产模块证明、共用夹具和构建哈希。
- `raw-results.json`：逐轮主线程指标、时间、输入/保存/DOM校验、推进节奏和内存。
- `summary.json`：每轮指标的中位数、范围和四个配对结果；延迟先逐轮算分位数，再对轮次聚合。
- `tables.md`：由冻结汇总数据生成的表格，不自动宣判功耗或温升改善。

CPU 计量包含共同的少量探针开销。总 CPU、活动期、完成尾部和显示节奏必须一起解释，不能用单一更小的 CPU 数字替代流式体验验证。完整方法见上级目录的 [测量方法](../METHODOLOGY.md)。
