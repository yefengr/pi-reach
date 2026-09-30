/* Local interaction simulation only. No network, pairing, or real Pi session. */
(function () {
  'use strict';

  const app = document.querySelector('#app');
  const previewMode = document.querySelector('#preview-mode');
  const themeToggle = document.querySelector('#theme-toggle');
  const contextOverlay = document.querySelector('#context-overlay');
  const actionsMenu = document.querySelector('#actions-menu');
  const toast = document.querySelector('#toast');
  const state = { preview: 'auto', layout: 'desktop', mode: 'live', computer: 'mac', endpoint: 'api', history: 'connection', connection: 'online', theme: 'light' };
  let toastTimer = 0;

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const icon = (id) => '<svg class="icon small" aria-hidden="true"><use href="#' + id + '"/></svg>';

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 2600);
  }

  function setLayout(layout) {
    state.layout = layout;
    app.dataset.layout = layout;
  }

  function setMode(mode) {
    state.mode = mode;
    app.dataset.mode = mode;
    const history = mode === 'history';
    $('#mode-label').textContent = history ? 'Saved conversation' : 'Live conversation';
    const historyTitles = { connection: 'Fix connection recovery', layout: 'PWA layout review', theme: 'Theme activity' };
    $('#conversation-title').textContent = history ? historyTitles[state.history] : state.endpoint === 'docs' ? 'Pi in docs-site' : 'Pi in api-service';
    $('#desktop-device').textContent = state.computer === 'office' ? 'Office PC' : 'MacBook Pro';
    $('#mobile-device').textContent = state.computer === 'office' ? 'Office PC' : 'MacBook Pro';
    $('#mobile-endpoint').textContent = history ? 'Saved conversation' : state.endpoint === 'docs' ? 'Pi in docs-site' : 'Pi in api-service';
    $('#cwd').textContent = history ? 'Browser local history' : state.endpoint === 'docs' ? '~/Code/docs-site' : '~/Code/api-service';
    $('#read-only-label').hidden = !history;
    $('#composer-hint').textContent = history ? 'Read-only local history' : state.connection === 'online' ? 'Connected to ' + (state.computer === 'office' ? 'Office PC' : 'MacBook Pro') : 'Draft preserved while offline';
    $('#offline-notice').hidden = history || state.connection === 'online';
    $('#desktop-connection').textContent = history ? 'Local only' : state.connection === 'online' ? 'Connected' : 'Offline';
    updateConnection();
    syncSelectedRows();
  }

  function updateConnection() {
    const online = state.connection === 'online' && state.mode !== 'history';
    $('#connection').classList.toggle('online', online);
    $('#connection').classList.toggle('offline', !online);
    $('#connection-label').textContent = online ? 'Connected' : state.mode === 'history' ? 'Local only' : 'Offline';
    $('#desktop-connection').textContent = state.mode === 'history' ? 'Local only' : online ? 'Connected' : 'Offline';
  }

  function syncSelectedRows() {
    $$('[data-computer]').forEach((row) => row.classList.toggle('active', row.dataset.computer === state.computer));
    $$('[data-endpoint]').forEach((row) => row.classList.toggle('active', state.mode === 'live' && row.dataset.endpoint === state.endpoint));
    $$('[data-history]').forEach((row) => row.classList.toggle('active', state.mode === 'history' && row.dataset.history === state.history));
  }

  function closeActions() {
    actionsMenu.hidden = true;
    $('#actions-trigger').setAttribute('aria-expanded', 'false');
  }

  function openContext() {
    contextOverlay.hidden = false;
    $('#mobile-context-trigger').setAttribute('aria-expanded', 'true');
    syncSheetTab(state.mode === 'history' ? 'history' : 'live');
  }

  function closeContext() {
    contextOverlay.hidden = true;
    $('#mobile-context-trigger').setAttribute('aria-expanded', 'false');
  }

  function syncSheetTab(tab) {
    $$('.sheet-tab').forEach((button) => {
      const active = button.dataset.tab === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    $$('.sheet-panel').forEach((panel) => { panel.hidden = panel.dataset.panel !== tab; });
  }

  function updatePreview(value) {
    state.preview = value;
    if (value === 'desktop' || value === 'desktop-offline') setLayout('desktop');
    else if (value.indexOf('mobile') === 0) setLayout('mobile');
    else setLayout(window.innerWidth <= 760 ? 'mobile' : 'desktop');
    state.connection = value === 'desktop-offline' ? 'offline' : 'online';
    setMode(value === 'mobile-history' ? 'history' : 'live');
    closeActions();
    closeContext();
    if (value === 'mobile-context') openContext();
  }

  function chooseComputer(computer) {
    state.computer = computer;
    if (computer === 'office') {
      state.connection = 'offline';
      showToast('Office PC is offline. No Pi can be selected.');
    } else {
      state.connection = 'online';
      showToast('MacBook Pro selected.');
    }
    setMode('live');
    closeContext();
  }

  function chooseEndpoint(endpoint) {
    if (state.computer !== 'mac') {
      showToast('This computer has no running Pi.');
      return;
    }
    state.endpoint = endpoint;
    state.connection = 'online';
    setMode('live');
    showToast(endpoint === 'docs' ? 'Switched to Pi in docs-site.' : 'Switched to Pi in api-service.');
    closeContext();
  }

  function chooseHistory(history) {
    state.history = history || 'connection';
    setMode('history');
    closeContext();
    showToast('Opened saved conversation. Read only.');
  }

  function runAction(action) {
    closeActions();
    if (action === 'retry') {
      state.connection = 'online';
      setMode('live');
      showToast('Connection retry simulated.');
      return;
    }
    const messages = { new: 'New session confirmation would open here.', compact: 'Compact context request simulated.', model: 'Model selector would open here.', thinking: 'Thinking level selector would open here.', pair: 'Pairing flow would open here.', settings: 'Settings drawer would open here.', live: 'Returned to the selected live Pi.' };
    if (action === 'live') setMode('live');
    showToast(messages[action] || 'This action is simulated in the prototype.');
  }

  previewMode.addEventListener('change', (event) => updatePreview(event.target.value));
  themeToggle.addEventListener('click', () => {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = state.theme;
    themeToggle.textContent = state.theme === 'light' ? 'Dark mode' : 'Light mode';
  });
  $('#mobile-context-trigger').addEventListener('click', openContext);
  $('#context-close').addEventListener('click', closeContext);
  $('.overlay-scrim').addEventListener('click', closeContext);
  $('#actions-trigger').addEventListener('click', () => {
    const next = actionsMenu.hidden;
    closeContext();
    actionsMenu.hidden = !next;
    $('#actions-trigger').setAttribute('aria-expanded', String(next));
  });
  $('#desktop-refresh').addEventListener('click', () => runAction('retry'));
  $('#composer').addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.mode === 'history') return showToast('Saved conversations are read only.');
    const draft = $('#draft').value.trim();
    showToast(draft ? 'Message send simulated.' : 'Type a message to send.');
    if (draft) $('#draft').value = '';
  });
  document.addEventListener('click', (event) => {
    const actionTarget = event.target.closest('[data-action]');
    if (actionTarget) runAction(actionTarget.dataset.action);
    const demoTarget = event.target.closest('[data-demo]');
    if (demoTarget) showToast(demoTarget.dataset.demo);
    const computerTarget = event.target.closest('[data-computer]');
    if (computerTarget) chooseComputer(computerTarget.dataset.computer);
    const endpointTarget = event.target.closest('[data-endpoint]');
    if (endpointTarget) chooseEndpoint(endpointTarget.dataset.endpoint);
    const historyTarget = event.target.closest('[data-history]');
    if (historyTarget) chooseHistory(historyTarget.dataset.history);
    const tabTarget = event.target.closest('[data-tab]');
    if (tabTarget) syncSheetTab(tabTarget.dataset.tab);
    if (!event.target.closest('.more-wrap') && !actionsMenu.hidden) closeActions();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeActions();
    closeContext();
  });
  window.addEventListener('resize', () => {
    if (state.preview === 'auto') setLayout(window.innerWidth <= 760 ? 'mobile' : 'desktop');
  });

  updatePreview('auto');
})();
