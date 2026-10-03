'use strict';
/* 会话附件 UX 原型：只模拟界面状态，不接真实接口、文件系统、摄像头或网络。 */
const $ = id => document.getElementById(id);
const THUMB = '../../assets/screenshot-desktop-zh.png';
const DEFAULT_TEXT = '帮我结合截图和日志分析这个问题。';
const SCENARIOS = ['draft', 'uploading', 'disconnected', 'failed', 'sent', 'legacy', 'many'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  x: ['M18 6 6 18', 'm6 6 12 12'],
  retry: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5'],
  file: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4', 'M16 13H8', 'M16 17H8', 'M10 9H8'],
  check: ['M20 6 9 17l-5-5'],
  clock: ['M12 3a9 9 0 1 0 9 9', 'M12 7v5l3 2'],
  wifiOff: ['M12 20h.01', 'M8.5 16.4a5 5 0 0 1 7 0', 'm2 8.82a15 15 0 0 1 4.17-2.65', 'M5 12.86a10 10 0 0 1 5.17-2.69', 'm2 2 20 20'],
  alert: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z', 'M12 9v4', 'M12 17h.01'],
  sun: ['M12 4V2M12 22v-2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M4 12H2M22 12h-2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z'],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z']
};

function svg(paths, size) {
  const node = document.createElementNS(SVG_NS, 'svg');
  const attrs = {
    viewBox: '0 0 24 24', width: String(size || 20), height: String(size || 20),
    fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'
  };
  Object.keys(attrs).forEach(k => node.setAttribute(k, attrs[k]));
  paths.forEach(d => {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    node.appendChild(p);
  });
  return node;
}
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
function progressEl(value, label) {
  const p = document.createElement('progress');
  p.max = 100;
  p.value = value;
  if (label) p.setAttribute('aria-label', label);
  return p;
}
const on = (id, type, fn) => $(id).addEventListener(type, fn);

/* 固定示例附件；base 与扩展名分开存放，用于演示“保留扩展名的截断”。 */
const SAMPLE_TWO = [
  ['截图', '.png', '1.2 MB', 'image'],
  ['诊断日志', '.txt', '86 KB', 'file']
];
const SAMPLE_MANY = [
  ['界面截图_20261002', '.png', '1.2 MB', 'image'],
  ['诊断日志', '.txt', '86 KB', 'file'],
  ['会话附件需求评审记录最终版', '.pdf', '2.4 MB', 'file'],
  ['relay-连接日志', '.log', '512 KB', 'file'],
  ['导出数据', '.zip', '8.1 MB', 'file'],
  ['截图 2026-10-02 上午10.32', '.png', '740 KB', 'image'],
  ['上传失败堆栈', '.txt', '12 KB', 'file'],
  ['产品访谈录音转写', '.md', '34 KB', 'file'],
  ['设备信息', '.json', '6 KB', 'file'],
  ['会话附件界面走查', '.mp4', '18.7 MB', 'file']
];
const toAtt = (a, i, prefix) => ({
  id: (prefix || 'a') + i, base: a[0], ext: a[1], name: a[0] + a[1], size: a[2], kind: a[3]
});
const copyAttachments = list => list.map((a, i) => toAtt(a, i));
const state = {
  scenario: 'draft', theme: 'light', viewport: 'auto', placement: 'inside', activePi: 'main', expanded: false,
  text: DEFAULT_TEXT, attachments: [], upload: null,
  committed: false, committedText: '', committedAttachments: [], legacy: false
};
/* 上传快照：2 个附件时第一个“上传完成”、第二个 62%，其余保持可手动推进。 */
function makeUploadFrom(list) {
  const files = list.map((a, i) => ({
    id: 'u' + i, base: a.base, ext: a.ext, name: a.name, size: a.size, kind: a.kind,
    progress: 0, status: 'queued'
  }));
  const done = files.length >= 2 ? Math.min(2, files.length - 1) : 0;
  files.forEach((f, i) => { if (i < done) { f.progress = 100; f.status = 'done'; } });
  if (files[done]) { files[done].status = 'uploading'; files[done].progress = 62; }
  return { phase: 'uploading', files: files };
}

function makeUpload(phase, list) {
  const upload = makeUploadFrom(list || copyAttachments(SAMPLE_TWO));
  if (phase === 'failed') {
    const target = upload.files.find(f => f.status === 'uploading') || upload.files[upload.files.length - 1];
    target.status = 'failed';
    target.progress = 62;
    target.reason = '写入失败';
  }
  upload.phase = phase;
  return upload;
}
function buildScenario(name) {
  const two = copyAttachments(SAMPLE_TWO);
  const draft = { text: DEFAULT_TEXT, attachments: two, upload: null, legacy: false,
    committed: false, committedText: '', committedAttachments: [], expanded: false };
  if (['uploading', 'disconnected', 'failed'].includes(name)) return { ...draft, upload: makeUpload(name) };
  if (name === 'sent') return { ...draft, text: '', attachments: [], committed: true,
    committedText: DEFAULT_TEXT, committedAttachments: two };
  if (name === 'legacy') return { ...draft, attachments: [], legacy: true };
  if (name === 'many') return { ...draft, attachments: copyAttachments(SAMPLE_MANY) };
  return draft;
}
/* ── URL 状态：?state=failed&theme=dark&viewport=mobile ── */
function readUrl() {
  const params = new URLSearchParams(location.search);
  const s = params.get('state'), t = params.get('theme'), v = params.get('viewport');
  if (SCENARIOS.indexOf(s) >= 0) state.scenario = s;
  if (t === 'dark' || t === 'light') state.theme = t;
  if (v === 'desktop' || v === 'mobile' || v === 'auto') state.viewport = v;
  if (params.get('placement') === 'outside') state.placement = 'outside';
}

function syncUrl() {
  const params = new URLSearchParams({ state: state.scenario, theme: state.theme, viewport: state.viewport, placement: state.placement });
  try {
    history.replaceState(null, '', location.pathname + '?' + params.toString());
  } catch (err) {
    /* file:// 或沙箱可能拒绝改写地址，原型不依赖它 */
  }
}
function isLocked() { return !!state.upload; }
function announce(msg) {
  const live = $('live');
  live.textContent = '';
  setTimeout(() => { live.textContent = msg; }, 30);
}

/* ── 渲染 ── */
function render() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.viewport = state.viewport;
  renderToolbar();
  renderPlacement();
  renderSelection();
  renderMessages();
  renderSwitched();
  renderComposer();
  renderUpload();
  syncUrl();
  if (state.committed && state.activePi === 'main') requestAnimationFrame(() => {
    const area = document.querySelector('.app-scroll');
    area.scrollTop = area.scrollHeight;
  });
}

function renderPlacement() {
  $('placement').value = state.placement;
  const zone = $('attachment-zone');
  if (state.placement === 'outside') $('composer-stack').insertBefore(zone, $('composer'));
  else $('composer').prepend(zone);
}

function renderToolbar() {
  $('scenario').value = state.scenario;
  $('sim-offline').textContent = state.upload?.phase === 'disconnected' ? '模拟恢复连接' : '模拟断线';
  document.querySelectorAll('[data-vp]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.vp === state.viewport));
  });
  const themeBtn = $('theme-toggle');
  themeBtn.replaceChildren(svg(ICONS[state.theme === 'dark' ? 'sun' : 'moon'], 20));
  themeBtn.setAttribute('aria-label', state.theme === 'dark' ? '切换到浅色外观' : '切换到深色外观');
  const active = !!state.upload && state.upload.phase !== 'committing';
  ['sim-complete', 'sim-offline', 'sim-fail'].forEach(id => { $(id).disabled = !active; });
}

function renderSelection() {
  document.querySelectorAll('[data-pi]').forEach(row => {
    row.setAttribute('aria-current', String(row.dataset.pi === state.activePi));
  });
  $('session-title').textContent = state.activePi === 'main' ? '会话附件上传排查' : '另一个 Pi 的会话（模拟）';
}

function messagesFor() {
  if (state.activePi !== 'main') return [{ role: 'pi', text: '这是另一个会话。原会话的草稿和附件没有发送到这里。' }];
  const list = [
    { role: 'user', text: '会话列表一直不刷新，帮我看看是什么问题。' },
    { role: 'pi', text: '先确认一下：页面顶部有没有出现「连接中断」提示？如果有，可能是 Relay 连接断开后没有重连。' }
  ];
  if (state.legacy) {
    list.unshift({ role: 'user', text: '这是我上次发的截图。', attachments: [toAtt(SAMPLE_TWO[0], 0)] });
  }
  if (state.committed) {
    list.push({ role: 'user', text: state.committedText, attachments: state.committedAttachments });
    list.push({ role: 'pi', text: '收到，我会结合前面的信息继续分析。（模拟回复）' });
  }
  return list;
}

function nameNode(a) {
  const name = el('span', 'att-name');
  name.title = a.name;
  name.appendChild(el('span', 'att-base', a.base));
  name.appendChild(el('span', 'att-ext', a.ext));
  return name;
}

function thumbNode(a, cls) {
  const img = el('img', cls || 'att-thumb');
  img.src = THUMB;
  img.alt = '';
  img.loading = 'lazy';
  return img;
}

function iconNode() {
  const box = el('div', 'att-icon');
  box.appendChild(svg(ICONS.file, 20));
  return box;
}

function sentAttachment(a) {
  const card = el('div', 'sent-att ' + (a.kind === 'image' ? 'is-image' : 'is-file'));
  card.appendChild(a.kind === 'image' ? thumbNode(a, 'sent-thumb') : svg(ICONS.file, 20));
  const meta = el('div', 'sent-meta');
  const name = el('span', 'sent-name', a.name);
  name.title = a.name;
  meta.appendChild(name);
  meta.appendChild(el('span', 'att-size', a.size));
  card.appendChild(meta);
  return card;
}

function renderMessages() {
  const box = $('messages');
  box.replaceChildren();
  messagesFor().forEach(m => {
    const row = el('div', 'msg ' + m.role);
    const bubble = el('div', m.role === 'user' ? 'bubble' : 'pi-text');
    if (m.text) bubble.appendChild(el('p', 'msg-text', m.text));
    if (m.attachments && m.attachments.length) {
      const wrap = el('div', 'sent-atts');
      m.attachments.forEach(a => wrap.appendChild(sentAttachment(a)));
      bubble.appendChild(wrap);
    }
    row.appendChild(bubble);
    box.appendChild(row);
  });
}

/* ── Composer ── */
function pendingCard(a) {
  const card = el('div', 'att-card');
  card.appendChild(a.kind === 'image' ? thumbNode(a) : iconNode());
  const meta = el('div', 'att-meta');
  meta.appendChild(nameNode(a));
  meta.appendChild(el('span', 'att-size', a.size));
  card.appendChild(meta);
  if (!isLocked()) {
    const btn = el('button', 'att-remove');
    btn.type = 'button';
    btn.setAttribute('aria-label', '移除 ' + a.name);
    btn.appendChild(svg(ICONS.x, 16));
    btn.addEventListener('click', () => removeAttachment(a.id));
    card.appendChild(btn);
  }
  return card;
}

function renderAttachments() {
  const list = $('attachments');
  list.replaceChildren();
  state.attachments.forEach((a, i) => {
    const card = pendingCard(a);
    card.hidden = !state.expanded && i >= 2;
    list.appendChild(card);
  });
  list.classList.toggle('expanded', !!state.expanded);
  const toggle = $('expand-toggle');
  toggle.hidden = state.attachments.length <= 2;
  toggle.setAttribute('aria-expanded', String(state.expanded));
  if (!toggle.hidden) {
    $('expand-label').textContent = state.expanded ? '收起' : '展开全部（' + state.attachments.length + '）';
  }
}

function renderComposer() {
  const input = $('composer-input');
  input.value = state.text;
  input.disabled = isLocked();
  const attach = $('attach-button');
  attach.disabled = state.legacy || isLocked();
  $('command-button').disabled = isLocked();
  $('attachments').parentElement.hidden = isLocked();
  if (state.legacy) {
    attach.setAttribute('aria-describedby', 'composer-notice');
    closeMenu();
  } else attach.removeAttribute('aria-describedby');
  renderAttachments();
  $('attachment-zone').hidden = !state.upload && state.attachments.length === 0;
  $('send').disabled = isLocked() || (!state.text.trim() && state.attachments.length === 0);
}

function renderSwitched() {
  const switched = state.activePi !== 'main';
  $('switched-note').hidden = !switched;
  $('composer-stack').hidden = switched;
}
/* ── 上传状态面板 ── */
function statusText(f) {
  if (f.status === 'done') return '上传完成';
  if (f.status === 'failed') return f.reason || (f.name + ' 上传失败');
  if (f.status === 'uploading') return (f.progress || 0) + '%';
  return '等待上传';
}

function uploadRow(f) {
  const row = el('div', 'up-row' + (f.status === 'failed' ? ' is-failed' : ''));
  row.dataset.status = f.status;
  row.dataset.progress = String(f.progress || 0);
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', f.name + '，' + statusText(f));
  row.appendChild(f.kind === 'image' ? thumbNode(f) : iconNode());
  const meta = el('div', 'up-meta');
  meta.appendChild(nameNode(f));
  if (f.status !== 'done') {
    const sub = el('div', 'up-sub');
    if (f.status === 'uploading') sub.appendChild(progressEl(f.progress || 0, f.name + ' 上传进度'));
    sub.appendChild(el('span', 'up-status ' + f.status, statusText(f)));
    meta.appendChild(sub);
  }
  row.appendChild(meta);
  const actions = el('div', 'up-file-actions');
  if (f.status === 'done') actions.appendChild(svg(ICONS.check, 18)).classList.add('up-done');
  else if (state.upload.phase !== 'committing') {
    if (f.status === 'failed') actions.appendChild(fileAction('重试 ' + f.name, 'retry', () => retryUpload(f.id)));
    actions.appendChild(fileAction('取消 ' + f.name + '（行为待确认）', 'x', () => {
      $('review-feedback').hidden = false;
      $('review-feedback').textContent = '本轮仅比较布局：取消是移除附件还是停止并保留，尚待确认。没有更改文件或发送意图。';
    }));
  }
  row.appendChild(actions);
  return row;
}

function fileAction(label, icon, handler) {
  const btn = el('button', 'icon-btn');
  btn.type = 'button';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.appendChild(svg(ICONS[icon], 18));
  btn.addEventListener('click', handler);
  return btn;
}

function renderUpload() {
  const messages = {
    disconnected: ['wifiOff', 'warning', '连接中断，恢复后继续上传。'],
    failed: ['alert', 'error', '有附件未上传成功，消息尚未发送。'],
    committing: ['clock', 'info', '附件已上传，消息发送中…']
  };
  const hint = state.legacy ? ['alert', 'warning', '上传附件需要升级电脑端扩展'] : messages[state.upload?.phase];
  const notice = $('composer-notice');
  notice.hidden = !hint;
  notice.replaceChildren();
  if (hint) {
    const [icon, tone, text] = hint;
    notice.dataset.tone = tone;
    notice.append(svg(ICONS[icon], 18), el('span', '', text));
  } else notice.removeAttribute('data-tone');

  const panel = $('upload-panel');
  panel.hidden = !state.upload;
  panel.replaceChildren();
  if (!state.upload) { panel.removeAttribute('data-phase'); return; }
  panel.dataset.phase = state.upload.phase;
  const list = el('div', 'up-list');
  state.upload.files.forEach(f => list.appendChild(uploadRow(f)));
  panel.appendChild(list);
}

/* ── 交互 ── */
function applyScenario(name) {
  if (SCENARIOS.indexOf(name) < 0) return;
  Object.assign(state, buildScenario(name), { scenario: name, activePi: 'main' });
  closeMenu();
  render();
  announce('已切换到场景：' + $('scenario').selectedOptions[0].textContent);
}

function removeAttachment(id) {
  const removed = state.attachments.find(a => a.id === id);
  state.attachments = state.attachments.filter(a => a.id !== id);
  if (state.attachments.length <= 2) state.expanded = false;
  renderComposer();
  if (removed) announce('已移除附件 ' + removed.name);
}

function addAttachments(list, note) {
  if (isLocked() || state.legacy) return;
  let added = 0;
  list.forEach(a => {
    if (state.attachments.length >= 10) return;
    const item = toAtt(a, added, 'x' + Date.now() + '-');
    if (state.attachments.some(x => x.name === item.name)) return;
    state.attachments.push(item);
    added += 1;
  });
  renderComposer();
  announce(added ? note + '，已添加 ' + added + ' 个附件' : note + '，没有新增附件');
}

function openMenu() {
  $('attach-menu').hidden = false;
  $('attach-button').setAttribute('aria-expanded', 'true');
}

function closeMenu() {
  $('attach-menu').hidden = true;
  $('attach-button').setAttribute('aria-expanded', 'false');
}

function onSend() {
  if (isLocked()) return;
  if (state.attachments.length) {
    state.upload = makeUploadFrom(state.attachments.slice());
    state.scenario = 'uploading';
    closeMenu();
    render();
    announce('开始模拟上传 ' + state.upload.files.length + ' 个附件');
    return;
  }
  if (!state.text.trim()) return;
  state.committed = true;
  state.committedText = state.text.trim();
  state.committedAttachments = [];
  state.text = '';
  render();
  announce('消息已发送（模拟）');
}

function commitUpload() {
  if (!state.upload) return;
  const upload = state.upload;
  upload.files.forEach(f => { f.status = 'done'; f.progress = 100; });
  state.upload.phase = 'committing';
  render();
  announce('上传完成，消息发送中');
  setTimeout(() => {
    if (state.upload !== upload || upload.phase !== 'committing') return;
    state.committedText = state.text.trim();
    state.committedAttachments = state.upload.files.map(f => ({ base: f.base, ext: f.ext, name: f.name, size: f.size, kind: f.kind }));
    state.committed = true;
    state.scenario = 'sent';
    state.text = '';
    state.attachments = [];
    state.upload = null;
    render();
    announce('消息已发送（模拟）');
  }, 700);
}

function cancelUpload(msg) {
  state.upload = null;
  state.scenario = 'draft';
  closeMenu();
  render();
  announce(msg || '已取消上传，文字与附件草稿已保留');
}

function retryUpload(id) {
  const file = state.upload?.files.find(f => f.id === id && f.status === 'failed');
  if (!file || state.upload.phase === 'disconnected') return;
  file.status = 'uploading'; file.reason = null;
  state.upload.phase = state.upload.files.some(f => f.status === 'failed') ? 'failed' : 'uploading';
  state.scenario = state.upload.phase;
  render();
  announce('正在重试 ' + file.name + '，其他附件保持不变');
}

function reconnectUpload() {
  if (!state.upload) return;
  state.upload.phase = 'uploading';
  render();
  announce('已模拟恢复连接，从电脑确认的位置继续上传');
}

/* ── 切换会话 ── */
let pendingPi = null;

function requestSwitch(pi) {
  if (pi === state.activePi) return;
  if (state.upload) {
    pendingPi = pi;
    $('confirm-dialog').showModal();
    return;
  }
  doSwitch(pi);
}

function doSwitch(pi) {
  const nav = $('nav-dialog');
  if (nav.open) nav.close();
  state.activePi = pi;
  render();
  announce(pi === 'main'
    ? '已返回原会话，草稿已恢复'
    : '已切换到「另一个在线 Pi」（模拟），原会话草稿保留在原会话，未转投新会话');
}

function confirmStay() {
  pendingPi = null;
  $('confirm-dialog').close();
  announce('留在当前会话，上传继续');
}

function confirmSwitch() {
  const pi = pendingPi || 'other';
  pendingPi = null;
  $('confirm-dialog').close();
  if (state.upload) {
    state.upload = null;
    state.scenario = 'draft';
  }
  doSwitch(pi);
}

/* ── 事件绑定 ── */
function bindEvents() {
  on('scenario', 'change', e => applyScenario(e.target.value));
  on('placement', 'change', e => { state.placement = e.target.value; render(); });
  document.querySelectorAll('[data-vp]').forEach(btn => {
    btn.addEventListener('click', () => { state.viewport = btn.dataset.vp; render(); });
  });
  on('theme-toggle', 'click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    render();
    announce(state.theme === 'dark' ? '已切换到深色外观' : '已切换到浅色外观');
  });
  on('reset-demo', 'click', () => { $('review-feedback').hidden = true; if (state.upload) cancelUpload(); else applyScenario('draft'); });

  on('sim-complete', 'click', commitUpload);
  on('sim-offline', 'click', () => {
    if (!state.upload || state.upload.phase === 'committing') return;
    if (state.upload.phase === 'disconnected') { reconnectUpload(); return; }
    state.upload.phase = 'disconnected';
    state.scenario = 'disconnected';
    render();
    announce('已模拟连接中断，已完成的进度保留');
  });
  on('sim-fail', 'click', () => {
    if (!state.upload || state.upload.phase === 'committing') return;
    const target = state.upload.files.find(f => f.status === 'uploading') || state.upload.files[state.upload.files.length - 1];
    target.status = 'failed';
    target.reason = '写入失败';
    state.upload.phase = 'failed';
    state.scenario = 'failed';
    render();
    announce(target.name + ' 上传失败');
  });
  on('toolbar-switch-session', 'click', () => requestSwitch(state.activePi === 'main' ? 'other' : 'main'));

  on('attach-button', 'click', () => { if ($('attach-menu').hidden) openMenu(); else closeMenu(); });
  on('menu-sample', 'click', () => { closeMenu(); addAttachments(SAMPLE_MANY.slice(2, 3), '已添加示例文件（模拟）'); });
  on('menu-camera', 'click', () => {
    closeMenu();
    addAttachments([['模拟拍照_20261002', '.jpg', '1.4 MB', 'image']], '已添加模拟拍照（未调用摄像头）');
  });
  on('command-button', 'click', () => announce('斜杠命令入口不在本次评审范围'));
  on('expand-toggle', 'click', () => { state.expanded = !state.expanded; renderAttachments(); });
  on('composer-input', 'input', e => {
    state.text = e.target.value;
    $('send').disabled = isLocked() || (!state.text.trim() && state.attachments.length === 0);
  });
  $('composer').addEventListener('submit', e => { e.preventDefault(); onSend(); });

  document.addEventListener('click', e => {
    const menu = $('attach-menu');
    if (!menu.hidden && !e.target.closest('#attach-menu') && !e.target.closest('#attach-button')) closeMenu();
    const row = e.target.closest('[data-pi]');
    if (row) requestSwitch(row.dataset.pi);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

  on('nav-toggle', 'click', () => $('nav-dialog').showModal());
  on('nav-close', 'click', () => $('nav-dialog').close());
  on('confirm-stay', 'click', confirmStay);
  on('confirm-switch', 'click', confirmSwitch);
  on('confirm-dialog', 'cancel', () => { pendingPi = null; announce('留在当前会话，上传继续'); });
  on('restore-draft', 'click', () => doSwitch('main'));
}

function init() {
  readUrl();
  Object.assign(state, buildScenario(state.scenario));
  bindEvents();
  new ResizeObserver(([entry]) => document.documentElement.style.setProperty('--review-bar-height', entry.target.getBoundingClientRect().height + 'px')).observe(document.querySelector('.review-bar'));
  render();
}

init();
