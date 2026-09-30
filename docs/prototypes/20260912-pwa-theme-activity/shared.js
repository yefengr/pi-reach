/* Pi Reach prototype interactions — local simulation only. No network or real session. */
(function () {
  'use strict';
  const F = window.RP_FIXTURES;
  if (!F) return;
  const APPEARANCE_KEY = 'rpi-prototype-appearance';
  const THEME_COLOR = F.themeColor || { light: '#FFFFFF', dark: '#1C1C1E' };
  const TOOL_ICONS = { Read: 'i-file', Search: 'i-search', Bash: 'i-terminal', Edit: 'i-edit', Write: 'i-write' };
  const STATUS_ICONS = { running: 'i-loader', complete: 'i-check', error: 'i-alert', uncertain: 'i-alert', interrupted: 'i-stop' };
  const KIND_LABELS = {
    code: 'File contents', terminal: 'Command output', search: 'Search results',
    diff: 'Applied diff', write: 'Written file', fallback: 'Structured result',
  };

  const state = {
    scenarioId: 'running', data: null, appearance: 'system', reader: null, toastTimer: 0,
    groupOpen: new Map(), stepOpen: new Map(), thinkOpen: new Map(), earlierOpen: new Map(),
  };

  let dom = {};

  const clone = (value) => (window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)));
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const inline = (text) => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const icon = (id, extraClass) => '<svg class="icon' + (extraClass ? ' ' + extraClass : '') + '" aria-hidden="true"><use href="#' + id + '"></use></svg>';

  function readAppearance() {
    try {
      const stored = window.localStorage.getItem(APPEARANCE_KEY);
      if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    } catch (error) { /* storage unavailable on file:// — keep default */ }
    return 'system';
  }

  function resolvedTheme() {
    if (state.appearance !== 'system') return state.appearance;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyAppearance() {
    const theme = resolvedTheme();
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLOR[theme]);
    document.querySelectorAll('input[name="appearance"]').forEach((radio) => {
      radio.checked = radio.value === state.appearance;
    });
  }

  function setAppearance(value) {
    state.appearance = value;
    try { window.localStorage.setItem(APPEARANCE_KEY, value); } catch (error) { /* ignore */ }
    applyAppearance();
    showToast(value === 'system'
      ? 'Appearance follows the system setting.'
      : 'Appearance set to ' + value + ' (stored on this page only).');
  }

  function showToast(message) {
    if (!dom.toast) return;
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    if (state.toastTimer) window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => { dom.toast.hidden = true; }, 2600);
  }

  function setConnection(connectionState, label) {
    if (dom.connectionLabel) dom.connectionLabel.textContent = label;
    const holder = document.querySelector('.connection');
    if (holder) holder.dataset.state = connectionState;
  }

  function blocksHTML(blocks) {
    return (blocks || []).map((block) => {
      if (block.t === 'ul') {
        return '<ul>' + block.items.map((item) => '<li>' + inline(item) + '</li>').join('') + '</ul>';
      }
      return '<p>' + inline(block.text) + '</p>';
    }).join('');
  }

  function renderMessage(node) {
    const title = node.title ? '<h3 class="answer-title">' + esc(node.title) + '</h3>' : '';
    const foot = node.foot ? '<p class="answer-foot">' + esc(node.foot) + '</p>' : '';
    const localNote = node.local
      ? '<p class="answer-foot">Prototype echo — this message was not sent to a real session.</p>'
      : '';
    return '<article class="message ' + esc(node.role) + '">' +
      '<span class="message-label">' + esc(node.label) + '</span>' + title +
      '<div class="message-text">' + blocksHTML(node.blocks) + localNote + '</div>' + foot +
      '</article>';
  }

  function defaultGroupOpen(group) {
    if (group.stopped) return true;
    if (group.finished) return false;
    return group.state === 'running' || group.state === 'error'
      || group.state === 'uncertain' || group.state === 'interrupted';
  }

  function displayState(group) {
    const issues = group.steps.some((step) => step.status === 'error');
    return issues && (group.state === 'complete' || group.state === 'error') ? 'error' : group.state;
  }

  function groupIsOpen(group) { return state.groupOpen.get(group.id) ?? defaultGroupOpen(group); }

  function stepIsOpen(step) { return state.stepOpen.get(step.id) ?? (step.status === 'error'); }

  function renderThinking(group) {
    const thinking = group.thinking;
    if (!thinking) return '';
    const open = state.thinkOpen.get(thinking.id) === true;
    const active = thinking.streaming && group.steps.some((step) => step.status === 'running');
    const bodyId = 'thinking-body-' + thinking.id;
    return '<div class="thinking">' +
      '<button class="thinking-toggle" type="button" id="thinking-toggle-' + esc(thinking.id) + '" data-thinking="' + esc(thinking.id) + '" aria-expanded="' + open + '" aria-controls="' + bodyId + '">' +
      icon('i-brain') + '<span>' + (active ? 'Thinking…' : 'Thought process') + '</span>' + icon('i-chevron', 'chevron') +
      '</button>' +
      '<div class="thinking-content prose" id="' + bodyId + '"' + (open ? '' : ' hidden') + '>' +
      thinking.paras.map((para) => '<p>' + esc(para) + '</p>').join('') +
      '</div></div>';
  }

  function previewHTML(detail, rider) {
    const label = (text) => '<span class="preview-label">' + esc(text) + '</span>';
    const cut = (text) => {
      const lines = String(text).split('\n');
      const short = lines.slice(0, 8).join('\n');
      return lines.length > 8 ? short + '\n…' : short;
    };
    if (detail.kind === 'search') {
      return label(detail.header) + '<div class="preview-prose"><ul>' +
        detail.items.slice(0, 3).map((item) =>
          '<li><code>' + esc(item.path) + ':' + item.line + '</code> ' + esc(item.text) + '</li>').join('') +
        '</ul></div>';
    }
    if (detail.kind === 'fallback') {
      return label(detail.header || 'Result') + '<pre class="preview-code">' + esc(cut(detail.text || '')) + '</pre>';
    }
    const text = detail.kind === 'terminal'
      ? detail.text
      : detail.kind === 'code' || detail.kind === 'diff'
        ? detail.lines.join('\n')
        : detail.text || '';
    const head = (detail.header || 'Output') + (rider || '');
    return label(head) + '<pre class="preview-code">' + esc(cut(text)) + '</pre>';
  }

  function detailsHTML(step) {
    const raw = step.raw || {};
    const rider = raw.exitCode === undefined || raw.exitCode === null ? '' : ' · exit code ' + raw.exitCode;
    return '<div class="preview-block">' + previewHTML(step.d || {}, rider) + '</div>' +
      '<div class="preview-block">' +
      '<button class="read-more" type="button" id="step-' + esc(step.id) + '-read" data-read="' + esc(step.id) + '">View full output</button>' +
      '<button class="raw-button" type="button" id="step-' + esc(step.id) + '-raw" data-raw="' + esc(step.id) + '">View raw data</button>' +
      '</div>';
  }

  function stepCopy(step) {
    const name = step.title.split('/').pop();
    if (step.tool === 'Read' || step.tool === 'Edit' || step.tool === 'Write') return [step.tool + ' ' + name, step.title];
    if (step.tool === 'Search') return ['Search "' + step.title + '"', null];
    if (step.tool === 'Bash') return ['Run ' + step.title, null];
    return [step.tool, step.title];
  }

  function stepHTML(step) {
    const open = stepIsOpen(step);
    const bodyId = 'step-body-' + step.id;
    const copy = stepCopy(step);
    const statusIcon = step.status === 'running' ? 'i-loader' : TOOL_ICONS[step.tool] || 'i-more';
    return '<div class="step" data-status="' + esc(step.status) + '">' +
      '<button class="step-button" type="button" id="step-toggle-' + esc(step.id) + '" data-step="' + esc(step.id) + '" aria-expanded="' + open + '" aria-controls="' + bodyId + '">' +
      icon(statusIcon, 'step-icon') +
      '<span class="step-copy"><strong>' + esc(copy[0]) + '</strong>' + (copy[1] ? '<small>' + esc(copy[1]) + '</small>' : '') + '</span>' +
      '<span class="step-status">' + esc(step.statusText || step.status) + '</span>' + icon('i-chevron', 'chevron') +
      '</button>' +
      '<div class="step-details" id="' + bodyId + '"' + (open ? '' : ' hidden') + '>' + detailsHTML(step) + '</div>' +
      '</div>';
  }

  function stepsHTML(group) {
    const finished = group.steps.filter((step) => step.status !== 'running');
    const recent = new Set(finished.slice(-3).map((step) => step.id));
    const earlier = group.steps.filter((step) => step.status !== 'running' && !recent.has(step.id));
    const open = state.earlierOpen.get(group.id) === true;
    let html = '';
    if (earlier.length) {
      const issues = earlier.filter((step) => step.status === 'error').length;
      const suffix = issues ? ' · ' + issues + (issues === 1 ? ' issue' : ' issues') : '';
      html += '<button class="earlier-toggle" type="button" id="earlier-toggle-' + esc(group.id) + '" data-earlier="' + esc(group.id) + '" aria-expanded="' + open + '">' +
        (open ? 'Hide ' + earlier.length : 'View ' + earlier.length) + ' earlier actions' + suffix + '</button>';
    }
    const shown = open ? group.steps : group.steps.filter((step) => step.status === 'running' || recent.has(step.id));
    html += shown.map(stepHTML).join('');
    return '<div class="steps">' + html + '</div>';
  }

  function renderActivity(group) {
    const open = groupIsOpen(group);
    const state = displayState(group);
    const issues = group.steps.filter((step) => step.status === 'error').length;
    const bodyId = 'activity-body-' + group.id;
    const issueChip = issues
      ? '<span class="issue-count">' + issues + (issues === 1 ? ' issue' : ' issues') + '</span>'
      : '';
    return '<section class="activity" data-state="' + esc(state) + '" data-segment="' + esc(group.id) + '" data-group="' + esc(group.group || group.id) + '">' +
      '<button class="activity-toggle" type="button" id="activity-toggle-' + esc(group.id) + '" data-activity="' + esc(group.id) + '" aria-expanded="' + open + '" aria-controls="' + bodyId + '">' +
      icon(STATUS_ICONS[state] || 'i-alert', 'status-icon') +
      '<span class="activity-heading"><strong>' + esc(group.heading) + '</strong><span class="activity-subtitle">' + esc(group.subtitle) + '</span></span>' +
      issueChip + icon('i-chevron', 'chevron') +
      '</button>' +
      '<div class="activity-body" id="' + bodyId + '"' + (open ? '' : ' hidden') + '>' +
      renderThinking(group) + stepsHTML(group) +
      '</div></section>';
  }

  function render() {
    if (!dom.timeline || !state.data) return;
    dom.timeline.innerHTML = state.data.nodes.map((node) => (
      node.type === 'activity' ? renderActivity(node) : renderMessage(node)
    )).join('');
  }

  function findStep(stepId) {
    if (!state.data) return null;
    for (const node of state.data.nodes) {
      if (node.type !== 'activity') continue;
      for (const step of node.steps) if (step.id === stepId) return step;
    }
    return null;
  }

  function fullHTML(detail) {
    switch (detail.kind) {
      case 'code':
        return '<div class="code-view"><div class="code-header">' + esc(detail.header) + '</div><div class="code-lines">' +
          detail.lines.map((line, index) =>
            '<div class="code-line"><span class="line-number">' + (index + 1) + '</span><span class="line-text">' + (esc(line) || ' ') + '</span></div>').join('') +
          '</div></div>';
      case 'terminal':
        return '<pre class="terminal-output">' + esc(detail.header + '\n' + detail.text) + '</pre>';
      case 'search':
        return '<ul class="search-results">' +
          detail.items.map((item) =>
            '<li><code>' + esc(item.path) + ':' + item.line + '</code><p>' + esc(item.text) + '</p></li>').join('') +
          '</ul>';
      case 'diff':
        return '<div class="diff-output">' + detail.lines.map((line) => {
          const marker = line.charAt(0);
          const kind = marker === '+' ? 'add' : marker === '-' ? 'remove' : 'context';
          const text = kind === 'context' ? line : line.slice(1);
          return '<div class="diff-line ' + kind + '"><span class="diff-marker">' + esc(kind === 'context' ? ' ' : marker) + '</span><span class="line-text">' + esc(text) + '</span></div>';
        }).join('') + '</div>';
      case 'write':
        return '<pre class="write-output">' + esc(detail.header + '\n\n' + detail.text) + '</pre>';
      default:
        return '<pre class="raw-output">' + esc(detail.text || 'No output recorded.') + '</pre>';
    }
  }

  function setReaderTab(view) {
    if (dom.readerTabs) {
      dom.readerTabs.querySelectorAll('[data-tab]').forEach((tab) => {
        const selected = tab.getAttribute('data-tab') === view;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
      });
    }
    if (dom.readerContent) {
      dom.readerContent.setAttribute('aria-labelledby', view + '-tab');
      dom.readerContent.querySelectorAll('[data-pane]').forEach((pane) => {
        pane.hidden = pane.getAttribute('data-pane') !== view;
      });
      dom.readerContent.scrollTop = 0;
    }
  }

  function openReader(stepId, view, invoker) {
    const step = findStep(stepId);
    if (!step || !dom.readerDialog) return;
    const detail = step.d || {};
    const rawText = step.raw
      ? JSON.stringify(step.raw, null, 2)
      : detail.text || (detail.lines || []).join('\n') || 'No raw data recorded for this step.';
    if (dom.readerTitle) dom.readerTitle.textContent = step.tool + ' · ' + step.title;
    if (dom.readerSubtitle) {
      dom.readerSubtitle.textContent = [step.statusText, KIND_LABELS[detail.kind] || 'Result', 'simulated data']
        .filter(Boolean).join(' · ');
    }
    if (dom.readerContent) {
      dom.readerContent.innerHTML =
        '<div class="reader-pane" data-pane="preview">' + fullHTML(detail) + '</div>' +
        '<div class="reader-pane" data-pane="raw" hidden><pre class="raw-output">' + esc(rawText) + '</pre></div>';
    }
    state.reader = { stepId, invokerId: invoker && invoker.id ? invoker.id : null, scrollTop: dom.transcript ? dom.transcript.scrollTop : 0 };
    if (dom.readerDialog.open) dom.readerDialog.close();
    setReaderTab(view || 'preview');
    if (!dom.readerDialog.open) dom.readerDialog.showModal();
  }

  function onReaderClose() {
    const reader = state.reader;
    state.reader = null;
    if (!reader) return;
    if (dom.transcript) dom.transcript.scrollTop = reader.scrollTop;
    const anotherDialogOpen = document.querySelector('dialog[open]');
    const invoker = reader.invokerId ? document.getElementById(reader.invokerId) : null;
    if (invoker && invoker.focus && !anotherDialogOpen) invoker.focus({ preventScroll: true });
  }

  function flip(button, map, id) {
    const next = button.getAttribute('aria-expanded') !== 'true';
    map.set(id, next);
    button.setAttribute('aria-expanded', String(next));
    const body = document.getElementById(button.getAttribute('aria-controls'));
    if (body) body.hidden = !next;
  }

  function toggleEarlier(button) {
    const id = button.getAttribute('data-earlier');
    state.earlierOpen.set(id, button.getAttribute('aria-expanded') !== 'true');
    const scroll = dom.transcript ? dom.transcript.scrollTop : 0;
    render();
    if (dom.transcript) dom.transcript.scrollTop = scroll;
    const next = document.getElementById(button.id);
    if (next && next.focus) next.focus({ preventScroll: true });
  }

  function closeOtherDialogs(except) {
    document.querySelectorAll('dialog[open]').forEach((dialog) => {
      if (dialog !== except) dialog.close();
    });
  }

  const hasRunning = (node) => node.steps.some((step) => step.status === 'running');

  function canAdvance() {
    if (!state.data || !state.data.advance) return false;
    return state.data.nodes.some((node) =>
      node.type === 'activity' && !node.finished && !node.stopped && (node.state !== 'complete' || hasRunning(node)));
  }

  function finishGroup(group) {
    group.finished = true;
    group.state = group.steps.some((step) => step.status === 'error') ? 'error' : 'complete';
    if (group.doneSubtitle) group.subtitle = group.doneSubtitle;
    if (group.thinking) group.thinking.streaming = false;
    group.steps.forEach((step) => {
      if (step.status !== 'running') return;
      step.status = 'complete';
      step.statusText = 'Completed';
      if (step.done) {
        step.d = step.done.d;
        step.raw = step.done.raw;
      }
    });
  }

  function advance() {
    const config = state.data && state.data.advance;
    if (!config || !canAdvance()) return;
    const focusId = document.activeElement && document.activeElement.id;
    const scroll = dom.transcript ? dom.transcript.scrollTop : 0;
    state.data.nodes.forEach((node) => {
      if (node.type !== 'activity' || node.finished || node.stopped) return;
      if (node.state === 'complete' && !hasRunning(node)) return;
      finishGroup(node);
    });
    if (config.final) state.data.nodes.push(clone(config.final));
    if (config.connection) setConnection('online', config.connectionLabel || 'Connected');
    render();
    updateControls();
    if (dom.transcript) dom.transcript.scrollTop = scroll;
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el && el.focus) el.focus({ preventScroll: true });
    }
    showToast('Activity finished (simulated) — no real run happened.');
  }

  function stopActivity() {
    if (!state.data) return;
    let stopped = false;
    state.data.nodes.forEach((node) => {
      if (node.type !== 'activity') return;
      let touched = false;
      node.steps.forEach((step) => {
        if (step.status !== 'running') return;
        step.status = 'interrupted';
        step.statusText = 'Interrupted';
        touched = true;
        stopped = true;
      });
      if (!touched) return;
      node.stopped = true;
      node.subtitle = 'Stopped · ' + node.steps.filter(step => step.status === 'interrupted').length + ' interrupted';
      if (node.state !== 'error' && node.state !== 'uncertain') node.state = 'interrupted';
      if (node.thinking) node.thinking.streaming = false;
    });
    if (!stopped) return;
    render();
    updateControls();
    showToast('Activity stopped (simulated) — nothing was cancelled on a real device.');
  }

  function updateControls() {
    const running = !!state.data && state.data.nodes.some((node) => node.type === 'activity' && hasRunning(node));
    if (dom.advanceBtn) {
      const enabled = canAdvance();
      dom.advanceBtn.disabled = !enabled;
      dom.advanceBtn.title = enabled
        ? 'Simulate the end of the current activity'
        : 'No simulated activity left to finish';
    }
    if (dom.stopBtn) {
      dom.stopBtn.disabled = !running;
      dom.stopBtn.title = running
        ? 'Stop the simulated activity'
        : 'Nothing is running in this scenario';
    }
  }

  function loadScenario(id) {
    const scenario = F.scenarios[id] || F.scenarios[F.defaultScenario];
    if (!scenario) return;
    state.scenarioId = scenario.id || id;
    state.data = clone(scenario);
    state.data.nodes = state.data.nodes || [];
    state.groupOpen = new Map();
    state.stepOpen = new Map();
    state.thinkOpen = new Map();
    state.earlierOpen = new Map();
    state.reader = null;
    if (dom.scenarioSelect && dom.scenarioSelect.value !== state.scenarioId) {
      dom.scenarioSelect.value = state.scenarioId;
    }
    markSession(document.querySelector('[data-session="timeline"]'));
    if (dom.sessionTitle) dom.sessionTitle.textContent = state.data.title;
    if (dom.sessionLabel) dom.sessionLabel.textContent = state.data.sessionLabel || 'Timeline';
    if (dom.endpointValue) dom.endpointValue.textContent = state.data.endpoint || '';
    setConnection(state.data.connection || 'online', state.data.connectionLabel || 'Connected');
    if (dom.hint) dom.hint.textContent = state.data.hint || 'Prototype only — nothing is sent.';
    if (dom.draft) dom.draft.value = '';
    render();
    if (dom.transcript) dom.transcript.scrollTop = state.data.nodes.some(node => node.type === 'activity' && hasRunning(node)) ? dom.transcript.scrollHeight : 0;
    updateControls();
  }

  function resetScenario() {
    loadScenario(state.scenarioId);
    showToast('Prototype reset — appearance preference is unchanged.');
  }

  function onSubmit(event) {
    event.preventDefault();
    if (!state.data) return;
    const text = dom.draft ? dom.draft.value.trim() : '';
    if (!text) {
      if (dom.hint) dom.hint.textContent = 'Type a message before sending — this prototype does not send anything.';
      if (dom.draft) dom.draft.focus();
      return;
    }
    state.data.nodes.push({ type: 'message', role: 'user', label: 'You', blocks: [{ t: 'p', text }], local: true });
    if (dom.draft) dom.draft.value = '';
    render();
    if (dom.transcript) dom.transcript.scrollTop = dom.transcript.scrollHeight;
    if (dom.hint) dom.hint.textContent = 'Local echo only — no agent received this message.';
    showToast('Simulated locally. Nothing was sent.');
    if (dom.draft) dom.draft.focus();
  }

  function onTimelineClick(event) {
    const button = event.target.closest('button');
    if (!button || !dom.timeline.contains(button)) return;
    if (button.dataset.step) return flip(button, state.stepOpen, button.dataset.step);
    if (button.dataset.activity) return flip(button, state.groupOpen, button.dataset.activity);
    if (button.dataset.thinking) return flip(button, state.thinkOpen, button.dataset.thinking);
    if (button.dataset.earlier) return toggleEarlier(button);
    if (button.dataset.read) return openReader(button.dataset.read, 'preview', button);
    if (button.dataset.raw) return openReader(button.dataset.raw, 'raw', button);
  }

  function onReaderTabKey(event) {
    const key = event.key;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
    const tabs = Array.from(dom.readerTabs.querySelectorAll('[data-tab]'));
    if (!tabs.length) return;
    const current = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
    let next = current;
    if (key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (key === 'ArrowLeft') next = (current + tabs.length - 1) % tabs.length;
    else if (key === 'Home') next = 0;
    else next = tabs.length - 1;
    event.preventDefault();
    setReaderTab(tabs[next].getAttribute('data-tab'));
    tabs[next].focus();
  }

  function markSession(button) {
    document.querySelectorAll('[data-session]').forEach(item => item.classList.toggle('selected', item === button));
    button.append(document.querySelector('.session-pill'));
  }

  function switchSession(button) {
    markSession(button);
    const docs = button.getAttribute('data-session') === 'docs';
    if (dom.sessionLabel) dom.sessionLabel.textContent = docs ? 'docs-workspace' : 'pi-reach';
    if (dom.sessionTitle) dom.sessionTitle.textContent = docs ? 'Docs workspace' : (state.data ? state.data.title : 'Session');
    const dialog = button.closest('dialog');
    if (dialog && dialog.open) dialog.close();
    showToast('Prototype only — the session label changed locally. Nothing connected.');
  }

  function onDocumentClick(event) {
    const demo = event.target.closest('[data-demo]');
    if (demo) {
      showToast(demo.getAttribute('data-demo') || 'Demo control');
      return;
    }
    const opener = event.target.closest('[data-open]');
    if (opener) {
      const dialog = document.getElementById(opener.getAttribute('data-open') + '-dialog');
      if (dialog) {
        closeOtherDialogs(dialog);
        if (!dialog.open) dialog.showModal();
      }
      return;
    }
    const closer = event.target.closest('[data-close]');
    if (closer) {
      const dialog = closer.closest('dialog');
      if (dialog && dialog.open) dialog.close();
      return;
    }
    const sessionButton = event.target.closest('[data-session]');
    if (sessionButton) switchSession(sessionButton);
  }

  function bindEvents() {
    if (dom.scenarioSelect) dom.scenarioSelect.addEventListener('change', () => loadScenario(dom.scenarioSelect.value));
    if (dom.advanceBtn) dom.advanceBtn.addEventListener('click', advance);
    if (dom.resetBtn) dom.resetBtn.addEventListener('click', resetScenario);
    if (dom.stopBtn) dom.stopBtn.addEventListener('click', stopActivity);
    if (dom.composer) dom.composer.addEventListener('submit', onSubmit);
    if (dom.timeline) dom.timeline.addEventListener('click', onTimelineClick);
    if (dom.readerTabs) dom.readerTabs.addEventListener('keydown', onReaderTabKey);
    if (dom.readerTabs) {
      dom.readerTabs.addEventListener('click', (event) => {
        const tab = event.target.closest('[data-tab]');
        if (tab) setReaderTab(tab.getAttribute('data-tab'));
      });
    }
    if (dom.readerDialog) dom.readerDialog.addEventListener('close', onReaderClose);
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', (event) => {
      const dialog = document.querySelector('dialog[open]');
      if (event.key !== 'Tab' || !dialog) return;
      const stops = Array.from(dialog.querySelectorAll('button:not(:disabled), input:checked, [tabindex="0"]')).filter(el => el.checkVisibility() && el.tabIndex >= 0);
      const index = stops.indexOf(document.activeElement);
      event.preventDefault();
      stops[(index + (event.shiftKey ? stops.length - 1 : 1)) % stops.length]?.focus();
    });
    document.querySelectorAll('input[name="appearance"]').forEach((radio) => {
      radio.addEventListener('change', () => { if (radio.checked) setAppearance(radio.value); });
    });
    if (window.matchMedia) {
      const query = window.matchMedia('(prefers-color-scheme: dark)');
      const onSystemChange = () => { if (state.appearance === 'system') applyAppearance(); };
      if (query.addEventListener) query.addEventListener('change', onSystemChange);
      else if (query.addListener) query.addListener(onSystemChange);
    }
  }

  function boot() {
    const byId = (id) => document.getElementById(id);
    dom = {
      timeline: byId('timeline'), transcript: byId('transcript'), scenarioSelect: byId('scenario'),
      advanceBtn: byId('advance'), resetBtn: byId('reset'), stopBtn: byId('stop-button'),
      composer: byId('composer'), draft: byId('draft'), hint: byId('composer-hint'),
      readerDialog: byId('reader-dialog'), readerTitle: byId('reader-title'),
      readerSubtitle: byId('reader-subtitle'), readerTabs: byId('reader-tabs'), readerContent: byId('reader-content'),
      sessionLabel: byId('session-label'), sessionTitle: byId('session-title'),
      endpointValue: byId('endpoint-value'), connectionLabel: byId('connection-label'), toast: byId('toast'),
    };
    state.appearance = readAppearance();
    applyAppearance();
    bindEvents();
    loadScenario(F.scenarios[dom.scenarioSelect?.value] ? dom.scenarioSelect.value : F.defaultScenario);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
