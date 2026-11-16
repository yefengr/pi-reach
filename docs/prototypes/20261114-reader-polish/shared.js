(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ICON = {
    eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/>',
    terminal: '<path d="m5 7 4 5-4 5"/><path d="M12 17h7"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    filediff: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M12 10v5M9.5 12.5h5M9.5 18h5"/>',
    pencil: '<path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m13.5 6.5 3 3"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5M12 16h.01"/>',
    loader: '<path d="M12 3a9 9 0 1 0 9 9"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>',
    chevronLeft: '<path d="m14.5 6-6 6 6 6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronRight: '<path d="m9 6 6 6-6 6"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
    download: '<path d="M12 4v10m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a2 2 0 0 0-2 2v9"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>'
  };
  const icon = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

  let copySeq = 0;
  const copyTexts = new Map();
  const copyMarkup = (text, label) => {
    const id = ++copySeq;
    copyTexts.set(id, text);
    return `<span class="copy-wrap"><span class="copy-msg" role="status"></span><button class="icon-btn" type="button" data-copy="${id}" aria-label="${esc(label)}" title="${esc(label)}">${icon('copy')}</button></span>`;
  };

  const statusText = (status) => {
    const label = status === 'running' ? '运行中' : status === 'error' ? '出错' : '完成';
    const name = status === 'running' ? 'loader' : status === 'error' ? 'alert' : 'check';
    return `<span class="tool-status ${status}" id="tool-status" role="status">${icon(name, status === 'running' ? 'spin' : '')}<span>${label}</span></span>`;
  };

  const pathRow = (path) => `<p class="file-path"><bdi>${esc(path)}</bdi></p>`;

  const sourceMarkup = (lines, start = 1) => `<div class="source-code">${lines.map((line, index) => `<span class="n">${start + index}</span><span class="c">${esc(line) || ' '}</span>`).join('')}</div>`;

  const fileToolbar = (label, text, documentView = false) => `<div class="file-toolbar"><span class="file-type">${esc(label)}</span><div class="file-actions">${documentView ? `<div class="view-switch" role="group" aria-label="内容视图"><button type="button" data-action="preview" aria-pressed="${state.contentView === 'preview'}">预览</button><button type="button" data-action="source" aria-pressed="${state.contentView === 'source'}">源码</button></div>` : ''}${copyMarkup(text, '复制文件内容')}</div></div>`;

  const writeContent = [
    'import { useRef } from "react";',
    'import type { ToolDetail } from "@pi-reach/protocol";',
    '',
    'export const READER_WIDTH = 720;',
    '',
    'export function useReaderScroll(detail: ToolDetail) {',
    '  const scroller = useRef<HTMLDivElement>(null);',
    '  const pinned = useRef(true);',
    '',
    '  function onScroll() {',
    '    const node = scroller.current;',
    '    if (!node) return;',
    '    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;',
    '  }',
    '',
    '  return { scroller, pinned, onScroll };',
    '}'
  ].join('\n');
  const readLines = [
    'export function readLineOffset(value: unknown) {',
    '  if (value === undefined) return 1;',
    '',
    '  if (typeof value !== "number") {',
    '    return undefined;',
    '  }',
    '',
    '  if (!Number.isInteger(value)) return undefined;',
    '  return value > 0 ? value : undefined;',
    '}'
  ];
  // 合成的统一 diff；行号来自此 hunk 的明确起点，不从请求推算执行结果。
  const diffRows = [
    [' ', 18, 18, 'function ToolCard({ tool }: ToolCardProps) {'],
    [' ', 19, 19, '  const copy = toolCallCopy(tool);'],
    ['-', 20, '', '  return <div>{copy.title}</div>;'],
    ['+', '', 20, '  const icon = TOOL_TYPE_ICONS[tool.kind];'],
    ['+', '', 21, '  return ('],
    ['+', '', 22, '    <div className="pwa-tool-row">'],
    ['+', '', 23, '      <Icon icon={icon} />'],
    ['+', '', 24, '      <span>{copy.title}</span>'],
    ['+', '', 25, '    </div>'],
    ['+', '', 26, '  );'],
    [' ', 21, 27, '}']
  ];
  const diffText = '--- a/pwa/src/components/pwa/tool-card.tsx\n+++ b/pwa/src/components/pwa/tool-card.tsx\n@@ -18,4 +18,10 @@\n' + diffRows.map(([sign, , , text]) => sign + text).join('\n');
  const diffMarkup = (path) => `<div class="diff-file-header">${pathRow(path)}<div class="diff-toolbar"><span class="diff-count"><span class="removed">−1</span><span class="added">+7</span></span>${copyMarkup(diffText, '复制差异')}</div></div><div class="diff-view" role="region" aria-label="统一差异：左侧两列依次为旧行号与新行号">${diffRows.map(([sign, oldLine, newLine, text]) => `<div class="diff-row ${sign === '+' ? 'addition' : sign === '-' ? 'deletion' : ''}"><span class="diff-number">${oldLine}</span><span class="diff-number">${newLine}</span><span class="diff-sign">${sign === '-' ? '−' : sign}</span><span class="diff-text">${esc(text)}</span></div>`).join('')}</div>`;
  const searchTerm = 'readerHasOverlay OR scrollIndicator OR (durationFade AND reducedMotion AND focusReturn) OR --pwa-z-reader OR --pwa-radius-lg OR toolCallCopy OR readLineOffset OR ToolStatusRow OR toolOutputBlocks OR PATH_KEYS OR COMMAND_KEYS OR QUERY_KEYS';
  const bashCommand = 'pnpm --filter pwa exec playwright test src/components/pwa/tool-reader.browser.test.tsx --project=chromium --reporter=line --workers=1 --repeat-each=2';
  const runLog = [
    'Running 12 tests using 1 worker',
    '',
    '  ✓  1  tool-reader.browser.test.tsx:42:1 › 标题与时间线同源',
    '  ✓  2  tool-reader.browser.test.tsx:58:1 › 未分类工具保持工具名',
    '  ✓  3  tool-reader.browser.test.tsx:76:1 › 长路径展开后完整可选',
    '  ✓  4  tool-reader.browser.test.tsx:94:1 › 复制保持原文',
    '  ✓  5  tool-reader.browser.test.tsx:118:1 › 长参数默认收起',
    '  ✓  6  tool-reader.browser.test.tsx:136:1 › 流式更新保留展开状态',
    '  ✓  7  tool-reader.browser.test.tsx:158:1 › 读日志底部时状态仍可见',
    '  ✓  8  tool-reader.browser.test.tsx:180:1 › 状态变化播报一次',
    '  ✓  9  tool-reader.browser.test.tsx:210:1 › 长参数展开后保持滚动位置',
    '  ✓  10 tool-reader.browser.test.tsx:238:1 › 运行中跟随与手动回看不回退',
    '  ›  11 tool-reader.browser.test.tsx:266:1 › read 行号与续读提示',
    '  ›  12 tool-reader.browser.test.tsx:294:1 › 错误输出使用普通底色'
  ].join('\n');
  const failLog = [
    'Running 12 tests using 1 worker',
    '',
    '  ✓  1  tool-reader.browser.test.tsx:42:1 › 标题与时间线同源',
    '  ✓  2  tool-reader.browser.test.tsx:58:1 › 未分类工具保持工具名',
    '  ✓  3  tool-reader.browser.test.tsx:76:1 › 长路径展开后完整可选',
    '  1) tool-reader.browser.test.tsx:94:1 › 复制保持原文 ─────────────────────────',
    '',
    '    Error: expect(received).toBe(expected)',
    '',
    '    Expected: "export function ToolReader({ tool, onClose }: ToolReaderProps) {"',
    '    Received: "53  export function ToolReader({ tool, onClose }: ToolReaderProps) {"',
    '',
    '      92 |   await page.getByRole("button", { name: "复制输出" }).click();',
    '      93 |   const text = await page.evaluate(() => navigator.clipboard.readText());',
    '    > 94 |   expect(text).toBe("offset: 53");',
    '         |                ^',
    '',
    '  2) tool-reader.browser.test.tsx:142:1 › 长参数默认收起 ────────────────────────',
    '',
    '    Error: locator.click: Target closed',
    '    Call log:',
    '      - waiting for getByRole("button", { name: "展开" })',
    '',
    '  2 failed',
    '    tool-reader.browser.test.tsx:94:1 › 复制保持原文',
    '    tool-reader.browser.test.tsx:142:1 › 长参数默认收起',
    '  10 passed',
    '',
    'Command exited with code 2'
  ].join('\n');

  const H = (level, text) => ({ t: `h${level}`, text });
  const P = (text) => ({ t: 'p', text });
  const UL = (...items) => ({ t: 'ul', items });
  const mdBlocks = [
    H(1, 'Pi Reach 阅读与文件查看指南'),
    P('在手机或桌面浏览器中回看 Pi 的工作过程，展开工具详情，并查看会话里的文本文件。'),
    H(2, '1. 从会话进入详情'),
    P('工具行用动作词和对象说明正在进行的操作。选择一条工具记录，即可查看该次调用的参数和返回内容。'),
    H(3, '1.1 识别工具类型'),
    P('Read 表示读取文件，Edit 表示修改文件，Write 表示写入文件；命令和搜索分别显示 Run 与 Search。'),
    H(3, '1.2 查看完整路径'),
    P('路径较长时会自然换行，可以直接选中完整路径。文件名在标题中保留，方便辨认当前对象。'),
    H(2, '2. 理解工具状态'),
    P('状态显示在详情顶部。向下阅读长输出时，它仍保持可见，方便确认调用是否已经结束。'),
    H(3, '2.1 运行中'),
    P('运行中的调用显示旋转图标和文字。可以向上回看已有输出，回看时保留当前阅读位置。'),
    H(3, '2.2 完成或出错'),
    P('完成和出错都有明确的图标与文字。出错时先查看返回内容，错误日志仍使用普通阅读底色。'),
    H(2, '3. 在手机上查看长文件路径与内容'),
    P('标题只显示便于识别的摘要。完整路径在标题下方显示，较长时自然换行，可直接选择复制。'),
    H(3, '3.1 直接阅读内容'),
    P('正文只保留文档、源码、差异或命令日志，不显示原始调用参数与成功回执。'),
    UL('读取与写入的文件使用文档或源码视图。', '编辑使用统一差异视图。', '未返回差异时明确说明，不从请求推导执行结果。'),
    H(3, '3.2 读取行范围'),
    P('请求读取 100 行，并不保证文件还有 100 行。详情中的范围表示本次实际展示的内容。'),
    { t: 'code', lang: '', text: '已显示第 53–62 行' },
    H(2, '4. 复制与保存'),
    P('代码块右侧的复制按钮只复制该块的内容。读取结果的行号、块标签和单独显示的提示不会混进复制内容。'),
    H(3, '4.1 复制输出'),
    P('复制成功后按钮显示对勾。如果浏览器未允许访问剪贴板，可以手动选择文本再复制。'),
    H(3, '4.2 保存原件'),
    P('已获取的文件可通过保存按钮交给浏览器下载。部分预览只限制阅读器显示的内容，不改变完整原件。'),
    H(2, '5. 阅读长文档'),
    P('Markdown 文档按标题、段落、列表、代码块和表格排版。普通文本文件保持文本展示。'),
    H(3, '5.1 使用目录'),
    P('点按顶部目录按钮，选择章节后跳转到正文对应位置。重新打开目录时，当前章节会保持可见。'),
    H(3, '5.2 部分预览'),
    P('文件较大时，正文只展示预览部分。目录也只列出预览中已经显示的标题，不会跳到尚未显示的内容。'),
    H(2, '6. 调整阅读外观'),
    P('在设置中选择浅色或深色外观，并根据阅读需要调整字号。路径和代码仍使用等宽字体，方便辨认字符。'),
    H(3, '6.1 字号'),
    P('标准、大和特大三个档位同步调整标题、正文和辅助信息，保持相互之间的层级。'),
    H(3, '6.2 窄屏阅读'),
    P('长标题会换行，完整路径可直接选择复制。工具详情与文件阅读器在手机上使用全屏显示。'),
    H(2, '7. 常见情况'),
    { t: 'table', head: ['现象', '查看位置'], rows: [['文件名未显示完整', '标题下的完整路径'], ['文件内容不完整', '实际显示范围与截断提示'], ['目录没有后面的章节', '部分预览提示']] },
    H(3, '7.1 返回会话'),
    P('关闭阅读器即可回到会话；目录打开时，先收起目录，再继续阅读或返回。'),
    H(3, '7.2 继续阅读'),
    P('需要阅读预览之外的内容时，保存完整原件，使用设备上的文本阅读工具打开。')
  ];

  const documentBlocks = [
    H(1, '阅读器使用指南'),
    P('在会话中选择一条工具记录，即可在抽屉中查看文件、差异或命令日志。'),
    H(2, '查看文件'),
    P('Markdown 按文档排版，代码保留缩进与行号。需要核对原始文本时，切换到源码。'),
    UL('Read 展示本次读取的内容。', 'Write 展示本次提交的写入内容。', 'Edit 展示工具返回的修改差异。'),
    H(2, '阅读差异'),
    P('绿色和加号表示新增，红色和减号表示删除；未修改的上下文保留在两者附近。'),
    H(2, '运行命令'),
    P('命令与执行日志连续展示。运行时可以回看之前的日志，状态始终保留在顶部。')
  ];
  const documentSource = documentBlocks.map((item) => item.t.startsWith('h') ? `${'#'.repeat(Number(item.t[1]))} ${item.text}` : item.t === 'ul' ? item.items.map((text) => '- ' + text).join('\n') : item.text).join('\n\n') + '\n';

  const scenes = {
    edit: {
      kind: 'tool', icon: 'filediff', verb: 'Edit', object: 'tool-card.tsx', status: 'complete',
      path: 'pwa/src/components/pwa/tool-card.tsx',
      diff: true,
      note: '目标效果：Edit 直接阅读统一 diff。此处为合成的返回差异样例；正式接通需要扩展回传真实 diff，当前缺少数据的记录见降级场景。'
    },
    'edit-unavailable': {
      kind: 'tool', icon: 'filediff', verb: 'Edit', object: 'tool-card.tsx', status: 'complete',
      path: 'pwa/src/components/pwa/tool-card.tsx', unavailable: true,
      note: '降级效果：现有详情未返回差异时明确说明；不从请求参数伪造已执行 diff，也不把降级当作 Edit 的目标效果。'
    },
    write: {
      kind: 'tool', icon: 'pencil', verb: 'Write', object: 'reader-guide.md', status: 'complete',
      path: 'docs/reader-guide.md', document: documentBlocks, source: documentSource,
      fileLabel: '写入内容 · Markdown',
      note: 'Write 主体是文档，可切换源码；内容取本次写入请求，完成状态取回执，不代表重新读回的磁盘快照。'
    },
    'write-code': {
      kind: 'tool', icon: 'pencil', verb: 'Write', object: 'reader-layout.ts', status: 'complete',
      path: 'pwa/src/components/pwa/readers/long-running-tools/reader-layout.ts',
      read: { start: 1, lines: writeContent.split('\n') }, fileLabel: '写入内容 · TypeScript',
      note: 'Write 代码直接作为源码展示，不展示原始参数或成功回执。'
    },
    read: {
      kind: 'tool', icon: 'eye', verb: 'Read', object: 'tool-reader.tsx', status: 'complete',
      path: 'pwa/src/components/pwa/tool-reader.tsx',
      fileLabel: 'TypeScript · 第 53–62 行',
      read: { start: 53, lines: readLines },
      note: 'Read 直接使用源码视图。请求读取 100 行，实际显示 10 行；只展示实际范围，复制不含行号。'
    },
    'read-document': {
      kind: 'tool', icon: 'eye', verb: 'Read', object: 'reader-guide.md', status: 'complete',
      path: 'docs/reader-guide.md', document: documentBlocks, source: documentSource,
      fileLabel: 'Markdown · 完整内容',
      note: 'Read Markdown 默认文档预览，也可切回源码。此处为完整读取样例；中间起读或结构不完整的片段默认源码。'
    },
    search: {
      kind: 'tool', icon: 'search', verb: 'Search', object: searchTerm, status: 'complete',
      term: searchTerm,
      output: {
        label: '搜索结果',
        text: 'pwa/src/components/pwa/tool-reader.tsx:58: const hasDiff = output.some((block) => block.style === "diff");\npwa/src/components/pwa/tool-reader.tsx:86: <ToolStatusRow status={tool.status} />\npwa/src/components/pwa/reader-shell.tsx:24: const overlay = readerHasOverlay();\npwa/src/lib/ui/scroll-indicator.ts:42: export const FADE = "--pwa-duration-fade";\npwa/src/components/pwa/tool-presentation.ts:118: export function readLineOffset(value: unknown): number | undefined {\npwa/src/components/pwa/tool-presentation.ts:144: const QUERY_KEYS = ["query", "q", "pattern", "search"] as const;\npwa/src/app/pwa-theme.css:312: --pwa-z-reader: 30;'
      },
      note: '评审点：超长搜索词完整换行并可复制，标题只做识别。静态样例，不覆盖真实搜索执行与结果排序。'
    },
    'bash-run': {
      kind: 'tool', icon: 'terminal', verb: 'Run', object: bashCommand, status: 'running',
      command: bashCommand,
      output: { label: '输出', text: runLog },
      note: '评审点：运行状态收进固定顶栏，滚动日志时始终可见，不另占正文一行。静态样例，不覆盖真实流式跟随与中断。'
    },
    'bash-fail': {
      kind: 'tool', icon: 'terminal', verb: 'Run', object: bashCommand, status: 'error',
      command: bashCommand,
      output: { label: '输出', text: failLog, error: true },
      note: '评审点：失败状态由顶部标签表达，正文保留 Pi 的真实结尾文字，不显示耗时。静态样例，不覆盖扩展端回传与真机日志。'
    },
    markdown: {
      kind: 'file', object: 'pi-reach-reading-and-file-preview-guide.md', info: 'Markdown · 12 KiB · 部分预览',
      blocks: mdBlocks,
      trunc: '当前只显示文件的预览部分，保存原件后可阅读完整内容。',
      note: '评审点：长目录在画布内独立滚动，点项只滚正文。样例原件不可下载，保存按钮置灰；真实叠层与手势需在正式应用验收。'
    }
  };

  const state = { scene: 'edit', viewport: 'phone', size: 'standard', contentView: 'preview', closed: false, tocOpen: false };
  let tocData = [];
  const canvas = $('#reader');
  const barEl = $('#readerBar');
  const bodyEl = $('#readerBody');
  const noteEl = $('#sceneNote');

  const renderBar = (scene) => {
    const phone = state.viewport === 'phone';
    const actions = [];
    let left = '';
    if (!state.closed) {
      if (phone) left = `<button class="icon-btn" type="button" data-action="close" aria-label="返回" title="返回">${icon('chevronLeft', 'ctl')}</button>`;
      if (scene.kind === 'file' || (scene.document && state.contentView === 'preview')) {
        actions.push(`<button class="icon-btn" type="button" data-action="toc" aria-label="目录" title="目录" aria-expanded="false">${icon('list', 'ctl')}</button>`);
      }
      if (scene.kind === 'file') {
        actions.push(`<button class="icon-btn" type="button" disabled aria-label="保存（静态稿无原件）" title="静态稿不提供原件下载">${icon('download', 'ctl')}</button>`);
      }
      if (!phone) actions.push(`<button class="icon-btn" type="button" data-action="close" aria-label="关闭" title="关闭">${icon('x', 'ctl')}</button>`);
    }
    const titleContent = scene.kind === 'file'
      ? `<span class="file-name">${esc(scene.object)}</span>`
      : `${icon(scene.icon, 't20')}<span class="verb">${esc(scene.verb)}</span><span class="obj">${esc(scene.object)}</span>`;
    const status = scene.kind === 'tool' && !state.closed ? statusText(scene.status) : '';
    return `${left}<div class="reader-title">${titleContent}</div>${status}${actions.length ? `<div class="actions">${actions.join('')}</div>` : ''}`;
  };

  const renderTool = (scene) => {
    const parts = ['<div class="reader-content">'];
    if (scene.path && !scene.diff) parts.push(pathRow(scene.path));
    if (scene.command) parts.push(`<div class="terminal"><div class="terminal-command"><pre><span class="ps">$ </span>${esc(scene.command)}</pre>${copyMarkup(scene.command, '复制命令')}</div><div class="file-toolbar terminal-tools"><span class="file-type">执行日志</span>${copyMarkup(scene.output.text, '复制日志')}</div><pre class="terminal-log">${esc(scene.output.text)}</pre></div>`);
    if (scene.term) parts.push(`<div class="search-query"><span class="file-type">搜索 · pwa/src</span>${copyMarkup(scene.term, '复制搜索词')}<p>${esc(scene.term)}</p></div><div class="file-toolbar"><span class="file-type">匹配结果</span>${copyMarkup(scene.output.text, '复制搜索结果')}</div><pre class="search-results">${esc(scene.output.text)}</pre>`);
    if (scene.diff) parts.push(diffMarkup(scene.path));
    if (scene.unavailable) parts.push('<div class="diff-empty"><h2>本次未返回差异</h2><p>无法查看这次修改的具体内容。</p></div>');
    if (scene.read) parts.push(fileToolbar(scene.fileLabel, scene.read.lines.join('\n')), sourceMarkup(scene.read.lines, scene.read.start));
    if (scene.document) {
      parts.push(fileToolbar(scene.fileLabel, scene.source, true));
      parts.push(state.contentView === 'preview' ? renderArticle(scene.document) : sourceMarkup(scene.source.trimEnd().split('\n')));
    }
    if (scene.notice) parts.push(`<p class="notice">${esc(scene.notice)}</p>`);
    parts.push('</div>');
    return parts.join('');
  };

  const renderArticle = (blocks) => {
    tocData = [];
    const article = blocks.map((item) => {
      if (item.t === 'h1' || item.t === 'h2' || item.t === 'h3') {
        const depth = Number(item.t[1]);
        const index = tocData.length;
        tocData.push({ index, text: item.text, depth });
        return `<h${depth} id="md-h-${index}" data-heading="${index}">${esc(item.text)}</h${depth}>`;
      }
      if (item.t === 'ul') return `<ul>${item.items.map((text) => `<li>${esc(text)}</li>`).join('')}</ul>`;
      if (item.t === 'table') {
        return `<table><thead><tr>${item.head.map((text) => `<th>${esc(text)}</th>`).join('')}</tr></thead><tbody>${item.rows.map((row) => `<tr>${row.map((text) => `<td>${esc(text)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      }
      if (item.t === 'code') {
        return `<div class="md-code"><div class="block-head"><span class="block-label">${esc(item.lang)}</span>${copyMarkup(item.text, '复制代码')}</div><pre class="block-pre">${esc(item.text)}</pre></div>`;
      }
      return `<p>${esc(item.text)}</p>`;
    }).join('');
    return `<article class="md">${article}</article>`;
  };

  const renderFile = (scene) => `<div class="reader-content file-content"><p class="file-info">${esc(scene.info)}</p>${renderArticle(scene.blocks)}<p class="trunc">${esc(scene.trunc)}</p></div>`;

  const trackScroll = () => {
    if (state.tocOpen) updateCurrentToc(false);
  };

  const renderScene = (key, keepView = false) => {
    const scene = scenes[key];
    if (!scene) return;
    if (!keepView) state.contentView = 'preview';
    tocData = [];
    state.scene = key;
    state.closed = false;
    closeToc(false);
    copyTexts.clear();
    canvas.dataset.viewport = state.viewport;
    canvas.dataset.size = state.size;
    barEl.innerHTML = renderBar(scene);
    bodyEl.innerHTML = scene.kind === 'file' ? renderFile(scene) : renderTool(scene);
    noteEl.textContent = scene.note;
    bodyEl.scrollTop = 0;
    bodyEl.removeEventListener('scroll', trackScroll);
    if (tocData.length) bodyEl.addEventListener('scroll', trackScroll, { passive: true });
    $('#sceneSelect').value = key;
  };

  const showClosed = () => {
    state.closed = true;
    closeToc(false);
    { const scene = scenes[state.scene]; barEl.innerHTML = renderBar(scene); }
    bodyEl.innerHTML = '<div class="closed"><h2>已关闭预览</h2><p>静态效果稿只切换画布，不涉及历史记录与手势。</p><button class="btn" type="button" data-action="reopen">重新打开</button></div>';
  };

  function updateCurrentToc(scrollPanel) {
    const headings = $$('[data-heading]', bodyEl);
    if (!headings.length) return;
    const bodyTop = bodyEl.getBoundingClientRect().top;
    let current = Number(headings[0].dataset.heading);
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top - bodyTop <= 16) current = Number(heading.dataset.heading);
    }
    $$('.toc-item').forEach((item) => {
      if (Number(item.dataset.toc) === current) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    });
    if (scrollPanel) {
      const list = $('.toc-list');
      const selected = list && $('[aria-current="true"]', list);
      if (list && selected) {
        const listRect = list.getBoundingClientRect();
        const itemRect = selected.getBoundingClientRect();
        list.scrollTop += itemRect.top - listRect.top - listRect.height / 2 + itemRect.height / 2;
      }
    }
  }

  const openToc = () => {
    if (state.tocOpen || state.closed || !tocData.length) return;
    state.tocOpen = true;
    const button = $('[data-action="toc"]');
    button?.setAttribute('aria-expanded', 'true');
    const panel = document.createElement('div');
    panel.className = 'toc';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '目录');
    panel.innerHTML = `<div class="toc-head"><span>目录</span><button class="icon-btn" type="button" data-action="toc-close" aria-label="关闭目录" title="关闭目录">${icon('x', 'ctl')}</button></div><ul class="toc-list">${tocData.map((item) => `<li><button class="toc-item" type="button" data-toc="${item.index}" data-depth="${item.depth}">${esc(item.text)}</button></li>`).join('')}</ul>${scenes[state.scene].trunc ? '<p class="toc-note">仅显示预览部分的目录</p>' : ''}`;
    canvas.appendChild(panel);
    updateCurrentToc(true);
    document.addEventListener('keydown', onDocKey);
    document.addEventListener('pointerdown', onDocPointer, true);
    $('[aria-current="true"]', panel)?.focus({ preventScroll: true });
  };

  function closeToc(focus) {
    if (!state.tocOpen) return;
    state.tocOpen = false;
    $('.toc')?.remove();
    const button = $('[data-action="toc"]');
    button?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onDocKey);
    document.removeEventListener('pointerdown', onDocPointer, true);
    if (focus) button?.focus({ preventScroll: true });
  }

  function onDocPointer(event) {
    if (event.target.closest('.toc') || event.target.closest('[data-action="toc"]') || event.target.closest('[data-action="close"]')) return;
    closeToc(false);
    event.preventDefault();
    event.stopImmediatePropagation();
    // 原型中外部点按只关闭目录，这次 click 不再触发背后的控件。
    document.addEventListener('click', (click) => { click.preventDefault(); click.stopImmediatePropagation(); }, { capture: true, once: true });
  }

  function onDocKey(event) {
    if (event.key !== 'Escape' || !state.tocOpen) return;
    event.preventDefault();
    event.stopPropagation();
    closeToc(true);
  }

  const jumpToc = (index) => {
    const heading = bodyEl.querySelector(`#md-h-${index}`);
    if (!heading) return;
    const delta = heading.getBoundingClientRect().top - bodyEl.getBoundingClientRect().top;
    bodyEl.scrollTo({ top: bodyEl.scrollTop + delta, behavior: reducedMotion() ? 'auto' : 'smooth' });
    closeToc(true);
  };

  async function copyValue(button) {
    const text = copyTexts.get(Number(button.dataset.copy));
    const message = $('.copy-msg', button.closest('.copy-wrap'));
    clearTimeout(message?._timer);
    try {
      if (!text || !navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (message) { message.textContent = '已复制'; message.classList.remove('err'); }
      if (button.isConnected) button.innerHTML = icon('check');
    } catch {
      if (message) { message.textContent = '复制失败，请手选'; message.classList.add('err'); }
    }
    if (message) message._timer = setTimeout(() => { message.textContent = ''; message.classList.remove('err'); if (button.isConnected) button.innerHTML = icon('copy'); }, 2000);
  }

  document.addEventListener('click', (event) => {
    const copyButton = event.target.closest('[data-copy]');
    if (copyButton) { copyValue(copyButton); return; }
    const tocItem = event.target.closest('[data-toc]');
    if (tocItem) { jumpToc(Number(tocItem.dataset.toc)); return; }
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === 'close') { if (state.tocOpen) closeToc(true); else showClosed(); }
    else if (action === 'reopen') renderScene(state.scene);
    else if (action === 'toc') { if (state.tocOpen) closeToc(true); else openToc(); }
    else if (action === 'toc-close') closeToc(true);
    else if (action === 'preview' || action === 'source') { state.contentView = action; renderScene(state.scene, true); $('[data-action="' + action + '"]')?.focus({ preventScroll: true }); }
  });

  $$('[data-theme-set]').forEach((button) => button.addEventListener('click', () => {
    document.documentElement.dataset.theme = button.dataset.themeSet;
    $$('[data-theme-set]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
  }));

  $$('[data-size-set]').forEach((button) => button.addEventListener('click', () => {
    state.size = button.dataset.sizeSet;
    canvas.dataset.size = state.size;
    $$('[data-size-set]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
  }));

  $$('[data-viewport-set]').forEach((button) => button.addEventListener('click', () => {
    state.viewport = button.dataset.viewportSet;
    const wasClosed = state.closed;
    $$('[data-viewport-set]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    renderScene(state.scene);
    if (wasClosed) showClosed();
  }));

  $('#sceneSelect').addEventListener('change', (event) => renderScene(event.target.value));

  renderScene('edit');
})();
