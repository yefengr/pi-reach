(() => {
  'use strict';
  const scenes = [
    { id: 'composer', title: 'Composer 与按压', short: '输入与按压', question: '层次能否让输入区更容易辨认，而不增加嵌套边框？按压是否明确、克制？', baseline: '12px 外圆角、平面输入区；按现行规范近似还原。', candidate: '16px 外圆角、可选轻阴影与聚焦层次；动作只缩放内部绘制层。', observe: '输入长句、聚焦后取消聚焦，再试发送。比较外轮廓、模型标签与操作按钮；模拟受理不等同于真实送达。' },
    { id: 'menus', title: '长菜单与导航密度', short: '菜单与导航', question: '鼠标下能否更易扫描，同时保留触控和混合设备的操作空间？', baseline: '标准菜单密度、44px 操作区；长名称换行。', candidate: '细指针下 40px 视觉行，44px 实际操作区；触控与混合保持宽松。', observe: '打开长模型列表，滚到最后并选择；试思考级别与返回。对照边缘提示、入场锚点、键盘焦点与 Escape 回焦。' },
    { id: 'attachments', title: '附件与文件获取', short: '附件卡片', question: '进度、错误与重试能否留在原卡片里，并在准备就绪后连续进入内容？', baseline: '演示获取完成后保留 600ms 完成态，再打开阅读器。', candidate: '演示内容就绪后直接交接阅读器；新增卡片轻微淡入。', observe: '新增、移除附件，试获取成功、失败、取消与重试。进度与错误占用同一槽位；慢放不延长模拟异步任务。' },
    { id: 'activity', title: '思考、工具与流式内容', short: '思考与工具', question: '一个主要动态提示是否足够？完成、折叠与文字增量能否保持稳定？', baseline: '旋转运行提示与当前折叠节奏；只在主动重播时重置演示。', candidate: '三点波浪与更清晰的原位状态交接；完成后停止循环。', observe: '主动展开，再试运行、增量、完成、中断与未知。快速收展应续接当前状态；回看时新增内容不自动抢回底部。' },
    { id: 'confirm', title: '确认框与焦点交接', short: '确认框', question: '确认的层级是否明确，进入与退出是否自然？关闭后能否找到原入口？', baseline: '现行确认框的进入 / 退出近似效果。', candidate: '有限的上移与淡化，退出更短；动作结果不依赖动画完成。', observe: '分别从两版入口打开；试取消、确认、Escape、遮罩与快速重复打开。确认只重置演示，不影响真实数据。' },
    { id: 'images', title: '图片预览与回源', short: '图片预览', question: '缩略图到大图的连续过渡是否比整屏滑入更容易理解？', baseline: '从右侧覆盖进入图片阅读器。', candidate: '从已加载缩略图的实际图像边界放大；关闭回源，来源失效时淡化。', observe: '试放大、缩小、复位与关闭；再隐藏来源或快速开关。放大过渡不叠加整屏滑入，不等待网络制造迟到的开场。' },
    { id: 'readers', title: '文件与工具阅读器', short: '文件阅读器', question: '覆盖阅读的进入、长文滚动与退出是否连贯？代码与 Diff 是否保持可读？', baseline: '桌面右侧覆盖、移动全屏；约 200ms 的对称滑入滑出。', candidate: '同一覆盖结构，按剩余距离交接，减弱动态时淡化。', observe: '打开后切换正文、代码、Diff 与原始输出，滚到末尾；在头部拖动或用关闭按钮返回。不模拟宽屏非模态工作面板。' },
    { id: 'transitions', title: '页面、会话与加载', short: '页面与加载', question: '快速切换是否只呈现最后目标？加载提示能否在完成时立即安静下来？', baseline: '当前会话淡入、覆盖页面与低对比呼吸骨架。', candidate: '更短的目标切换淡入、语义覆盖与单一扫光骨架。', observe: '连续切换会话，打开设置覆盖演示，再试加载交接。页面不播放历史逐条入场；减少动态效果下循环静止。' },
    { id: 'copy', title: '复制与局部反馈', short: '复制反馈', question: '原位确认能否取代重复 Toast，同时让复制失败与读屏用户获得明确结果？', baseline: '剪贴板成功后显示对勾与成功 Toast。', candidate: '剪贴板成功后只显示原位对勾与简短读屏播报，约 2 秒复位。', observe: '复制中文和代码，连续点击检查反馈计时；再试失败。复制调用是真实浏览器动作，权限受限时可手动选择文本。' },
  ];
  const byId = new Map(scenes.map(scene => [scene.id, scene]));
  const $ = id => document.getElementById(id);
  const systemMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const coarsePointer = matchMedia('(any-pointer: coarse)');
  const state = { scene: byId.has(location.hash.slice(1)) ? location.hash.slice(1) : 'composer', active: 'candidate' };
  const controls = ['layout', 'theme', 'width', 'input', 'rate', 'reduced', 'palette', 'elevation', 'density', 'motion'];
  const decisions = Object.fromEntries(scenes.map(scene => [scene.id, { value: 'pending', reason: '', config: null }]));
  const labels = { pending: '待评审', adopt: '倾向采用候选', reject: '倾向保留当前', revise: '调整后再看' };
  const inputValue = () => $('input').value !== 'auto' ? $('input').value : coarsePointer.matches ? (finePointer.matches ? 'mixed' : 'touch') : finePointer.matches ? 'fine' : 'touch';
  const configFor = variant => ({
    variant, scene: state.scene, theme: $('theme').value, input: inputValue(), rate: Number($('rate').value),
    reduced: systemMotion.matches || $('reduced').value === 'reduce',
    palette: variant === 'baseline' ? 'neutral' : $('palette').value,
    elevation: variant === 'baseline' ? 'flat' : $('elevation').value,
    density: variant === 'baseline' ? 'standard' : $('density').value,
    motion: variant === 'baseline' ? 'current' : $('motion').value,
  });
  function syncAttributes(host, config) {
    for (const [key, value] of Object.entries(config)) host.dataset[key] = String(value);
  }
  for (const scene of scenes) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.scene = scene.id;
    const number = document.createElement('span'); number.textContent = String(scenes.indexOf(scene) + 1).padStart(2, '0'); number.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span'); title.textContent = scene.short;
    button.append(number, title); button.addEventListener('click', () => setScene(scene.id)); $('scene-nav').append(button);
  }
  const controllers = Object.fromEntries(['baseline', 'candidate'].map(variant => {
    const host = $(`${variant}-host`); syncAttributes(host, configFor(variant));
    const activate = () => {
      state.active = variant; $('comparison').dataset.mobile = variant; syncReplayLabel();
      document.querySelectorAll('[data-mobile-version]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mobileVersion === variant)));
    };
    host.addEventListener('pointerdown', activate); host.addEventListener('focusin', activate);
    host.addEventListener('input', event => {
      if(event.target.dataset.action !== 'draft') return;
      const peer = $(`${variant === 'baseline' ? 'candidate' : 'baseline'}-host`).querySelector('[data-action="draft"]');
      if(peer) peer.value = event.target.value;
    });
    return [variant, window.StageAScenes.mount(host, configFor(variant))];
  }));
  function syncReplayLabel() {
    const overlay = ['attachments', 'confirm', 'images', 'readers'].includes(state.scene);
    const variant = $('layout').value === 'compare' ? state.active : $('layout').value;
    $('replay').textContent = overlay ? `重播${variant === 'baseline' ? '当前' : '候选'}浮层` : '重播动作';
  }
  function render() {
    const scene = byId.get(state.scene);
    document.documentElement.dataset.theme = $('theme').value;
    $('comparison').dataset.layout = $('layout').value;
    $('comparison').dataset.width = $('width').value;
    $('comparison').dataset.mobile = state.active;
    for (const [variant, controller] of Object.entries(controllers)) {
      const config = configFor(variant); syncAttributes($(`${variant}-host`), config); controller.update(config);
    }
    $('scene-index').textContent = `场景 ${String(scenes.indexOf(scene) + 1).padStart(2, '0')} / 09`;
    $('scene-title').textContent = scene.title;
    $('scene-question').textContent = scene.question;
    $('baseline-note').textContent = scene.baseline;
    $('candidate-note').textContent = scene.candidate;
    $('scene-observe').textContent = scene.observe;
    $('scene-nav').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.scene === state.scene)));
    document.querySelectorAll('[data-mobile-version]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mobileVersion === state.active)));
    document.querySelector('.review-mobile-version').hidden = $('layout').value !== 'compare';
    const config = configFor('candidate');
    const inputLabels = { fine: '细指针', touch: '触控', mixed: '混合输入' };
    $('environment-note').textContent = `${inputLabels[config.input]} · ${config.reduced ? '减少动态效果已生效（系统偏好优先）' : '完整动态效果'} · ${config.rate === 4 ? '空间 / 透明度动作慢放，业务与反馈停留计时不变' : '常速动作'}。手机并排模式按版本切换；浮层一次只打开一个版本。`;
    syncReplayLabel();
  }
  function setScene(id, updateHash = true) {
    if (!byId.has(id)) return;
    state.scene = id; render();
    $('decision').value = decisions[id].value; $('reason').value = decisions[id].reason;
    if (updateHash) history.replaceState(null, '', `#${id}`);
  }
  controls.forEach(id => $(id).addEventListener('change', () => {
    if (id === 'layout' && $('layout').value !== 'compare') state.active = $('layout').value;
    render();
  }));
  document.querySelectorAll('[data-mobile-version]').forEach(button => button.addEventListener('click', () => { state.active = button.dataset.mobileVersion; render(); }));
  $('align-baseline').addEventListener('click', () => {
    for (const [id, value] of Object.entries({ palette: 'neutral', elevation: 'flat', density: 'standard', motion: 'current' })) $(id).value = value;
    render();
  });
  $('restore-candidate').addEventListener('click', () => {
    for (const [id, value] of Object.entries({ palette: 'neutral', elevation: 'raised', density: 'adaptive', motion: 'semantic' })) $(id).value = value;
    render();
  });
  $('replay').addEventListener('click', () => {
    const layout = $('layout').value;
    if (layout !== 'compare') controllers[layout].replay();
    else if (['attachments', 'confirm', 'images', 'readers'].includes(state.scene) || matchMedia('(max-width: 799px)').matches) controllers[state.active].replay();
    else Object.values(controllers).forEach(controller => controller.replay());
  });
  $('reset-scene').addEventListener('click', () => {
    Object.values(controllers).forEach(controller => controller.reset());
    $('review-announcement').textContent = '两版演示内容已重置，评审记录保留。';
  });
  function renderLedger() {
    $('decision-ledger').replaceChildren();
    for (const scene of scenes) {
      const row = document.createElement('div'); row.className = 'review-ledger-row';
      for (const value of [scene.short, labels[decisions[scene.id].value], decisions[scene.id].reason || '尚未填写理由']) {
        const cell = document.createElement('span'); cell.textContent = value; row.append(cell);
      }
      $('decision-ledger').append(row);
    }
    $('decision-count').textContent = `${Object.values(decisions).filter(item => item.value !== 'pending' || item.reason.trim()).length} / 9 已记录`;
  }
  function recordDecision() {
    decisions[state.scene] = { value: $('decision').value, reason: $('reason').value, config: configFor('candidate') };
    renderLedger();
  }
  $('decision').addEventListener('change', recordDecision); $('reason').addEventListener('input', recordDecision);
  $('export-decisions').addEventListener('click', () => {
    const lines = ['Pi Reach · 阶段 A HTML 原型评审记录', '状态：草稿。所有交互为模拟；取舍须在真实组件中复核。', `导出时间：${new Date().toLocaleString('zh-CN')}`, '', '导出时候选参数：', JSON.stringify(configFor('candidate'), null, 2), ''];
    for (const scene of scenes) {
      const item = decisions[scene.id];
      lines.push(`${scene.title}：${labels[item.value]}`, `理由：${item.reason || '未填写'}`, `记录时参数：${item.config ? JSON.stringify(item.config) : '未记录'}`, '');
    }
    lines.push('未覆盖：真实协议、真实组件生命周期、真机键盘与系统返回、草稿持久化、宽屏非模态工作面板。');
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'pi-reach-stage-a-review.txt'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('review-announcement').textContent = '评审记录已交给浏览器下载。';
  });
  for (const media of [systemMotion, finePointer, coarsePointer]) media.addEventListener('change', render);
  window.addEventListener('hashchange', () => setScene(location.hash.slice(1), false));
  window.addEventListener('pagehide', event => { if (!event.persisted) Object.values(controllers).forEach(controller => controller.dispose()); });
  render(); renderLedger();
})();
