/* 本地固定样例，仅供阶段 A 视觉与流程评审。 */
window.StageAFixtures = {
  imageSrc: 'assets/layout-preview.png',
  longPath: '/workspace/pi-reach/pwa/src/components/pwa/published-file-reader-with-long-preview-name.tsx',
  models: ['Claude Sonnet', 'OpenAI GPT · extended reasoning · long context preview', 'Gemini Pro · long context', 'Local model · coding workspace · experimental', 'Claude Opus · deep reasoning', 'OpenAI GPT · fast', 'Gemini Flash · fast', 'Local model · compact'],
  text: '让操作有回应，让阅读保持安静。\n\n这份演示只使用本地固定样例。文件阅读器保持原来的阅读位置，新增内容不会覆盖用户选择。\n\n输入、思考和工具是同一条工作路径：先看到结论，再按需检查过程。\n\nKeep reading in place. New output should never take over your scroll position or your current selection.',
  code: 'const preview = {\n  mode: "review",\n  network: false,\n  preserveDraft: true\n};\n\nfunction openPreview(source) {\n  return source ?? "local fixture";\n}',
  raw: '<!doctype html>\n<html lang="zh-CN">\n  <body><h1>只读样例，不执行 HTML</h1></body>\n</html>',
  diff: [{kind:'context', text:'@@ -1,3 +1,4 @@'}, {kind:'remove', text:'- radius: 12'}, {kind:'add', text:'+ radius: 16'}, {kind:'add', text:'+ preserveFocus: true'}, {kind:'context', text:'  color: mistBlue'}]
};
