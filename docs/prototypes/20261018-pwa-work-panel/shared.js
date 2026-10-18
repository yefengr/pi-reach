(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const app = $('#app');
  const workspace = $('#workspace');
  const pane = $('#detail-pane');
  const dialog = $('#reader-dialog');
  const content = $('#detail-content');
  const detailBody = $('#detail-body');
  const detailTitle = $('#detail-title');
  const draft = $('#draft');
  const messages = $('#messages');
  const handle = $('#resize-handle');
  const MIN_CHAT = 480;
  const MIN_DETAIL = 360;
  const SEPARATOR = 16;
  const SPLIT_THRESHOLD = 900;
  const DEFAULT_WIDTH = 440;
  const WIDTH_STEP = 24;
  const state = { mode: 'split', size: 'auto', session: 'main', selected: null, width: DEFAULT_WIDTH, source: null };
  let sessions = freshSessions();
  let suppressedCloses = 0;
  let drag = null;
  let observedWidth = 0;
  let composing = false;

  const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const fileButton = (title, subtitle) => `<button type="button" class="file-card" data-open="note" aria-pressed="false" title="${title}">${icon('file')}<span><strong>${title}</strong><small>${subtitle}</small></span>${icon('chevron')}</button>`;
  const mainConversation = `
    <article class="message user"><p>请把这次界面调整整理成简短说明，顺便检查相关样式。</p></article>
    <article class="message assistant">
      <div class="message-label"><strong>Pi</strong><span>示例对话</span></div>
      <p>整理好了。说明里区分了已保留的设计规则，以及这次需要评审的工作面板体验。</p>
      ${fileButton('界面调整说明.md', '说明文档 · 点击阅读')}
      <h3>这次调整的重点</h3>
      <ul><li>宽屏时把说明放在对话旁边，阅读时仍然可以继续输入。</li><li>聊天与详情各自滚动，不为看一段输出丢掉对话位置。</li><li>空间不够时回到覆盖阅读，不硬挤成两栏。</li></ul>
      <h3>样式检查</h3>
      <div class="tool-list">
        <button type="button" class="tool-row" data-open="read" aria-pressed="false" title="read · pwa/src/app/workspace-shell.css">${icon('check')}<span>read · pwa/src/app/workspace-shell.css</span>${icon('chevron')}</button>
        <button type="button" class="tool-row" data-open="check" aria-pressed="false" title="bash · pnpm check:docs">${icon('check')}<span>bash · pnpm check:docs</span>${icon('chevron')}</button>
      </div>
      <p class="quiet">以上为静态样例，未读取真实文件或执行命令。</p>
      <p>你可以对照右侧说明继续提问，也可以点开工具结果，看看较长的路径和输出是否容易阅读。</p>
    </article>`;
  const otherConversation = `
    <article class="message user"><p>帮我整理一份发布前的人工检查清单。</p></article>
    <article class="message assistant"><div class="message-label"><strong>Pi</strong><span>示例对话</span></div><p>这里是一份供讨论的清单，没有执行检查或发布操作。</p>${fileButton('发布检查清单.md', '说明文档 · 另一段模拟会话')}<p>你可以在这段会话里写新的草稿。切回「界面调整」时，原来的草稿与模拟消息还会保留。</p></article>`;

  const documents = {
    note: {
      title: '界面调整说明.md', kind: '文件 · 只读预览', position: '说明文档', icon: 'file',
      body: `<article class="document">
        <p class="doc-meta">Pi Reach / 界面调整说明</p>
        <h3>把阅读留在对话旁边</h3>
        <p>文件和工具结果通常不是对话的终点。看完一段内容后，我们还会追问、补充条件，或者让 Pi 继续调整。</p>
        <p>这份候选方案让宽屏中的详情成为一个工作面板：对话留在左边，选中的内容留在右边。</p>
        <h4>01 · 阅读时，输入仍然可用</h4>
        <p>打开说明以后，可以直接在对话底部继续输入。面板不遮住聊天，不锁住背景，也不把键盘焦点困在阅读区域。</p>
        <blockquote>试着一边读这份说明，一边输入「把第二点再说得具体一点」。右侧内容会保持不变。</blockquote>
        <h4>02 · 只展示你选择的内容</h4>
        <p>点击消息中的文件或工具，会替换同一个面板的内容。新的对话消息不会自动切走正在阅读的说明。</p>
        <p>面板没有多标签页，也没有内嵌编辑器。这里优先回答的是「边看边聊是否顺手」，而不是增加一个新的工作空间。</p>
        <h4>03 · 把空间交给当前任务</h4>
        <p>面板默认宽 440px。拖动中间的分隔条，可以把更多空间分给长路径和输出；选中分隔条后，也可以使用左右方向键。</p>
        <ul><li>左方向键：加宽面板。</li><li>右方向键：缩窄面板。</li><li>Home / End：最窄 / 最宽。</li><li>工具栏的还原按钮：恢复默认宽度。</li></ul>
        <h4>04 · 不够宽，就覆盖阅读</h4>
        <p>是否分栏取决于工作区的真实可用宽度，而不只是浏览器窗口宽度。聊天至少保留约 480px，详情至少保留约 360px。</p>
        <p>手机和较窄的窗口继续使用覆盖式阅读。改变窗口大小时，当前内容与未发送草稿不丢失。</p>
        <h4>保持不变的部分</h4>
        <p>中性灰表面、雾蓝操作色、系统字体和阅读列宽度沿用现有设计。Composer 仍然是对话底部最明确的操作区域。</p>
        <p>文件内容只读。这里没有真实保存、代码执行、网络连接或浏览器返回处理。</p>
        <h4>评审时可以留意</h4>
        <ol><li>第一眼能否理解左边是对话、右边是所选内容？</li><li>读到中途继续输入，是否需要额外寻找输入区？</li><li>切换工具结果后，是否还清楚当前在看什么？</li><li>窗口变窄以后，关闭并返回对话是否自然？</li></ol>
        <p class="doc-meta">文档结束 · 此处所有内容均为模拟样例</p>
      </article>`
    },
    read: {
      title: 'read · workspace-shell.css', kind: '工具详情 · 静态样例', position: 'CSS 样例', icon: 'terminal',
      body: `<article class="document tool-document"><p class="mock-output">模拟输出 · 未读取真实文件</p><h3>read</h3><dl><dt>文件路径</dt><dd>pwa/src/app/workspace-shell.css</dd><dt>参数（只读）</dt><dd>offset: 1<br>limit: 80</dd><dt>结果</dt><dd>以下仅为布局示意，不代表当前源码。</dd></dl><pre class="code-block">/* 静态示例：对话与详情各自滚动 */
.workspace {
  display: grid;
  grid-template-columns:
    minmax(480px, 1fr)
    16px
    var(--detail-width, 440px);
  min-height: 0;
}

.conversation {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.messages,
.detail-body {
  overflow: auto;
  min-height: 0;
  overscroll-behavior: contain;
}

.composer {
  flex-shrink: 0;
  font-size: 16px;
}

/* 空间不足时，详情切换为覆盖阅读。 */</pre><h4>阅读提示</h4><p>长路径会完整换行显示，代码可以横向滚动。此处只用来评审阅读体验，不提供修改或执行入口。</p><p>你可以保持这个结果打开，回到左侧继续描述需要调整的细节。</p></article>`
    },
    check: {
      title: 'bash · pnpm check:docs', kind: '工具详情 · 静态样例', position: '命令输出', icon: 'terminal',
      body: `<article class="document tool-document"><p class="mock-output">模拟输出 · 未执行真实命令</p><h3>文档链接检查</h3><dl><dt>命令（只读）</dt><dd>pnpm check:docs</dd><dt>工作目录</dt><dd>pi-reach</dd></dl><pre class="code-block">$ pnpm check:docs

[模拟] 正在检查 Markdown 站内链接…
[模拟] 正在检查标题锚点…

[模拟] 未发现失效链接。
[模拟] 未发现缺失锚点。

模拟退出码：0

这不是本仓库的真实检查结果。</pre><h4>这段输出说明什么？</h4><p>这里只展示完成态工具输出的阅读方式。绿色完成图标与这里的文本均为模拟，不构成验证证据。</p><p>当前内容可以选中阅读，但没有复制、重新运行或打开终端等真实操作。</p><h4>接下来仍然可以聊天</h4><p>在候选并排模式里，试着问「还需要检查哪些地方？」。新的模拟回复会出现在左边，不会替换这段输出。</p></article>`
    },
    other: {
      title: '发布检查清单.md', kind: '文件 · 只读预览', position: '检查清单', icon: 'file',
      body: `<article class="document"><p class="doc-meta">Pi Reach / 发布前讨论</p><h3>发布前检查清单</h3><p>这是一份独立会话中的静态样例，不表示检查已完成。</p><h4>交互与阅读</h4><ul><li>检查明暗主题下的文字与焦点。</li><li>检查较窄窗口中的输入区。</li><li>检查文件与工具结果的关闭路径。</li></ul><h4>范围说明</h4><p>本原型不执行构建、发布、提交或网络请求。模拟消息与草稿只保存在当前页面内存。</p><p>切换会话会关闭当前工作面板，避免把上一段对话的内容带到这里。</p></article>`
    }
  };

  function freshSessions() {
    return { main: { draft: '', messages: [] }, other: { draft: '', messages: [] } };
  }

  function usable(element) {
    return element instanceof HTMLElement && element.isConnected && !element.closest('[hidden], [inert], [aria-hidden="true"]') && !element.matches(':disabled') && element.getClientRects().length > 0;
  }

  function focus(element) {
    if (usable(element)) element.focus({ preventScroll: true });
  }

  function announce(text) {
    $('#announcement').textContent = text;
  }

  function updateSelection() {
    document.querySelectorAll('[data-open]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.open === state.selected));
    });
  }

  function renderSession() {
    $('#message-list').innerHTML = state.session === 'main' ? mainConversation : otherConversation;
    sessions[state.session].messages.forEach(appendMessage);
    draft.value = sessions[state.session].draft;
    $('#send').disabled = !draft.value.trim();
    const title = state.session === 'main' ? '界面调整' : '发布前检查';
    $('#session-title').textContent = title;
    $('#session-select').value = state.session;
    document.querySelectorAll('button[data-session]').forEach((button) => {
      button.setAttribute('aria-current', String(button.dataset.session === state.session));
    });
    messages.scrollTop = 0;
  }

  function appendMessage(message) {
    const article = document.createElement('article');
    article.className = `message simulated ${message.role}`;
    if (message.role === 'assistant') {
      const label = document.createElement('div');
      label.className = 'message-label';
      label.innerHTML = '<strong>Pi</strong><span class="simulated-badge">模拟回复</span>';
      article.append(label);
    }
    const paragraph = document.createElement('p');
    paragraph.textContent = message.text;
    article.append(paragraph);
    $('#message-list').append(article);
  }

  function renderDetail() {
    const key = state.session === 'other' ? 'other' : state.selected;
    const entry = documents[key];
    detailTitle.textContent = entry.title;
    detailTitle.title = entry.title;
    $('#detail-kind').textContent = entry.kind;
    $('#detail-icon').setAttribute('href', `#i-${entry.icon}`);
    $('#reader-position').textContent = entry.position;
    detailBody.innerHTML = entry.body;
    detailBody.scrollTop = 0;
    updateSelection();
  }

  // close 事件异步到达；程序关闭（含尺寸迁移）的事件逐个消费，不能擦掉新面板。
  function closeNativeQuietly() {
    if (!dialog.open) return;
    suppressedCloses += 1;
    dialog.close();
  }

  function cancelDrag() {
    if (!drag) return;
    const pointerId = drag.id;
    drag = null;
    document.body.classList.remove('is-resizing');
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
  }

  function widthLimit() {
    return Math.max(MIN_DETAIL, Math.floor(workspace.getBoundingClientRect().width - MIN_CHAT - SEPARATOR));
  }

  function updateWidth() {
    const maximum = widthLimit();
    state.width = Math.round(Math.max(MIN_DETAIL, Math.min(maximum, state.width)));
    workspace.style.setProperty('--detail-width', `${state.width}px`);
    handle.setAttribute('aria-valuemax', String(maximum));
    handle.setAttribute('aria-valuenow', String(state.width));
    handle.setAttribute('aria-valuetext', `工作面板 ${state.width} 像素`);
    $('#width-value').textContent = `${state.width} px`;
  }

  function positionDialog() {
    const frame = app.getBoundingClientRect();
    const fullScreen = frame.width < 768;
    const width = Math.min(fullScreen ? frame.width : 720, frame.width);
    dialog.dataset.fullscreen = String(fullScreen);
    dialog.style.setProperty('--dialog-x', `${frame.right - width}px`);
    dialog.style.setProperty('--dialog-y', `${frame.top}px`);
    dialog.style.setProperty('--dialog-w', `${width}px`);
    dialog.style.setProperty('--dialog-h', `${frame.height}px`);
  }

  function applyLayout(shouldFocus = false) {
    const width = workspace.getBoundingClientRect().width;
    const canSplit = state.mode === 'split' && width >= Math.max(SPLIT_THRESHOLD, MIN_CHAT + MIN_DETAIL + SEPARATOR);
    const layout = !state.selected ? 'closed' : canSplit ? 'split' : 'overlay';
    const previous = workspace.dataset.layout;
    const active = document.activeElement;
    const hadDetailFocus = content.contains(active);
    const scrollTop = detailBody.scrollTop;
    if (layout !== previous) cancelDrag();
    workspace.dataset.layout = layout;
    $('#resize-slot').hidden = layout !== 'split';
    $('#width-controls').hidden = layout !== 'split';
    $('#overlay-label').hidden = layout !== 'overlay';
    if (layout === 'overlay') {
      pane.hidden = true;
      positionDialog();
      if (content.parentElement !== dialog) dialog.append(content);
      if (!dialog.open) dialog.showModal();
      if (shouldFocus || previous !== 'overlay') focus(hadDetailFocus ? active : detailTitle);
    } else {
      closeNativeQuietly();
      if (content.parentElement !== pane) pane.append(content);
      pane.hidden = layout !== 'split';
      if (layout === 'split') {
        updateWidth();
        if (shouldFocus) focus(detailTitle);
        else if (hadDetailFocus) focus(active);
      }
    }
    detailBody.scrollTop = scrollTop;
  }

  function openDetail(button) {
    state.source = button;
    state.selected = button.dataset.open;
    renderDetail();
    applyLayout(true);
    announce(`已打开 ${detailTitle.textContent}`);
  }

  function closeDetail(toComposer = false, restoreFocus = true) {
    const active = document.activeElement;
    const wasModal = dialog.open;
    const wasInDetail = content.contains(active) || active === handle;
    state.selected = null;
    cancelDrag();
    applyLayout();
    updateSelection();
    if (!restoreFocus) return;
    if (toComposer) focus(draft);
    else if (wasModal || wasInDetail || !usable(active)) {
      focus(usable(state.source) ? state.source : $('#conversation-title'));
    }
    announce('工作面板已关闭');
  }

  function selectSession(session) {
    if (session === state.session) return;
    sessions[state.session].draft = draft.value;
    closeDetail(false, false);
    state.source = null;
    state.session = session;
    renderSession();
    focus($('#conversation-title'));
    announce('已切换模拟会话，旧详情已关闭');
  }

  function updateReviewControls() {
    document.querySelectorAll('[data-mode]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
    });
    document.querySelectorAll('[data-size]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.size === state.size));
    });
    app.dataset.size = state.size;
  }

  function reset() {
    closeDetail(false, false);
    sessions = freshSessions();
    Object.assign(state, { mode: 'split', size: 'auto', session: 'main', selected: 'note', width: DEFAULT_WIDTH, source: null });
    document.documentElement.dataset.theme = 'light';
    $('[data-action="theme"]').setAttribute('aria-label', '切换为深色');
    updateReviewControls();
    renderSession();
    state.source = $('[data-open="note"]');
    renderDetail();
    applyLayout();
    announce('已重置为默认候选方案');
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.open) return openDetail(button);
    if (button.dataset.session) return selectSession(button.dataset.session);
    if (button.dataset.mode) {
      state.mode = button.dataset.mode;
      updateReviewControls();
      return applyLayout();
    }
    if (button.dataset.size) {
      cancelDrag();
      state.size = button.dataset.size;
      updateReviewControls();
      return applyLayout();
    }
    const action = button.dataset.action;
    if (action === 'close-detail') closeDetail();
    if (action === 'return-chat') {
      if (dialog.open) closeDetail(true);
      else focus(draft);
    }
    if (action === 'reset-width') {
      state.width = DEFAULT_WIDTH;
      updateWidth();
    }
    if (action === 'theme') {
      const root = document.documentElement;
      const dark = root.dataset.theme !== 'dark';
      root.dataset.theme = dark ? 'dark' : 'light';
      button.setAttribute('aria-label', dark ? '切换为浅色' : '切换为深色');
    }
    if (action === 'reset') reset();
  });

  $('#session-select').addEventListener('change', (event) => selectSession(event.target.value));
  draft.addEventListener('input', () => {
    sessions[state.session].draft = draft.value;
    $('#send').disabled = !draft.value.trim();
  });
  draft.addEventListener('compositionstart', () => { composing = true; });
  draft.addEventListener('compositionend', () => { composing = false; });
  draft.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composing || event.keyCode === 229) return;
    event.preventDefault();
    if (draft.value.trim()) $('#composer').requestSubmit();
  });
  $('#composer').addEventListener('submit', (event) => {
    event.preventDefault();
    if (composing || !draft.value.trim()) return;
    const text = draft.value.trim();
    const additions = [
      { role: 'user', text },
      { role: 'assistant', text: '这是本地模拟回复，未连接 Pi。你的消息已加入当前会话；正在阅读的内容保持不变。' }
    ];
    sessions[state.session].messages.push(...additions);
    additions.forEach(appendMessage);
    draft.value = '';
    sessions[state.session].draft = '';
    $('#send').disabled = true;
    messages.scrollTop = messages.scrollHeight;
    focus(draft);
    announce('已模拟发送；工作面板保持不变');
  });

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDetail();
  });
  dialog.addEventListener('close', () => {
    if (suppressedCloses > 0) { suppressedCloses -= 1; return; }
    if (!dialog.open && state.selected) closeDetail();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDetail();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || dialog.open || !state.selected) return;
    if (workspace.dataset.layout === 'split') {
      event.preventDefault();
      closeDetail();
    }
  });

  handle.addEventListener('keydown', (event) => {
    if (workspace.dataset.layout !== 'split') return;
    const values = { ArrowLeft: state.width + WIDTH_STEP, ArrowRight: state.width - WIDTH_STEP, Home: MIN_DETAIL, End: widthLimit() };
    if (!(event.key in values)) return;
    event.preventDefault();
    state.width = values[event.key];
    updateWidth();
  });
  handle.addEventListener('pointerdown', (event) => {
    if (workspace.dataset.layout !== 'split' || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    cancelDrag();
    drag = { id: event.pointerId, startX: event.clientX, width: state.width };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing');
    focus(handle);
  });
  handle.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    state.width = drag.width + drag.startX - event.clientX;
    updateWidth();
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((type) => {
    handle.addEventListener(type, (event) => {
      if (drag && event.pointerId === drag.id) cancelDrag();
    });
  });
  window.addEventListener('blur', cancelDrag);
  window.addEventListener('resize', () => {
    cancelDrag();
    applyLayout();
  });
  const observer = new ResizeObserver(() => {
    const width = Math.round(workspace.getBoundingClientRect().width);
    if (width !== observedWidth) cancelDrag();
    observedWidth = width;
    applyLayout();
  });
  observer.observe(workspace);
  reset();
})();
