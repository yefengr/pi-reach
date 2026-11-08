# 临时文件：让 Deploy branch to staging 工作流把 main 最新代码部署到 staging。
# 该文件位于 pwa/ 构建输入路径内，用于让分支相对 main 出现 PWA 改动；
# 不进入 pwa/dist，也不影响运行时镜像。部署完成后随触发分支一起删除。
