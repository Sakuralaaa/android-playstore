import { VideoStreamRenderer } from './decoder.js';
import { PhoneInputController } from './input.js';
import { DrawerController } from './panels.js';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const appState = {
  authenticated: false,
  view: 'login', // login | dashboard | console
  phones: [],
  catalog: null,
  metrics: {},
  activePhoneId: null,
  activePhone: null,
  videoMeta: { width: 720, height: 1600, deviceName: 'Pixel Cloud' },
  logs: [],
  lastClipboard: '',
  decoderEngine: 'WebCodecs',
  fps: 0,
  rttMs: null,
};

// Views
const viewLogin = document.getElementById('view-login');
const viewDashboard = document.getElementById('view-dashboard');
const viewConsole = document.getElementById('view-console');

// Login elements
const loginForm = document.getElementById('login-form');
const loginPassword = document.getElementById('login-password');
const loginError = document.getElementById('login-error');
const loginSubmit = document.getElementById('login-submit');
const togglePwBtn = document.getElementById('toggle-pw-btn');
const loginPhoneCount = document.getElementById('login-phone-count');

// Dashboard elements
const phoneGrid = document.getElementById('phone-grid');
const hostCpu = document.getElementById('host-cpu');
const hostMem = document.getElementById('host-mem');
const hostDisk = document.getElementById('host-disk');
const hostRunning = document.getElementById('host-running');

// Console elements
const connDot = document.getElementById('conn-dot');
const deviceTitle = document.getElementById('device-title');
const consoleGeoChip = document.getElementById('console-geo-chip');
const streamStats = document.getElementById('stream-stats');
const phoneStage = document.getElementById('phone-stage');
const screenViewport = document.getElementById('screen-viewport');
const videoCanvas = document.getElementById('video-canvas');
const videoFallback = document.getElementById('video-fallback');
const streamOverlay = document.getElementById('stream-overlay');
const streamOverlayText = document.getElementById('stream-overlay-text');

// Modals
const phoneModal = document.getElementById('phone-modal');
const phoneModalTitle = document.getElementById('phone-modal-title');
const phoneForm = document.getElementById('phone-form');
const logsModal = document.getElementById('logs-modal');
const logsModalTitle = document.getElementById('logs-modal-title');
const logsModalBody = document.getElementById('logs-modal-body');
const imeModal = document.getElementById('ime-modal');
const imeModalInput = document.getElementById('ime-modal-input');
const imeModalEnter = document.getElementById('ime-modal-enter');
const dropOverlay = document.getElementById('drop-overlay');
const toastContainer = document.getElementById('toast-container');

let ws = null;
let wsPhoneId = null;
let wsReconnectTimer = null;
let pingTimer = null;
let logsPollTimer = null;

function toast(message, level = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${level === 'success' ? 'toast-success' : level === 'error' ? 'toast-error' : ''}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.25s';
    setTimeout(() => el.remove(), 260);
  }, 3000);
}

async function api(path, { method = 'GET', body = null } = {}) {
  const opts = { method, headers: {} };
  if (body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(path, opts);
  if (resp.status === 401 && path !== '/api/auth/login') {
    appState.authenticated = false;
    closeWebSocket();
    showView('login');
    throw new Error('会话已过期，请重新登录');
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `请求失败 (${resp.status})`);
  return data;
}

function showView(name) {
  appState.view = name;
  viewLogin.classList.toggle('hidden', name !== 'login');
  viewDashboard.classList.toggle('hidden', name !== 'dashboard');
  viewConsole.classList.toggle('hidden', name !== 'console');
  if (name === 'console') {
    requestAnimationFrame(fitPhoneViewport);
  }
}

function fitPhoneViewport() {
  const w = appState.videoMeta.width || 720;
  const h = appState.videoMeta.height || 1600;
  const aspect = w / h;

  const isMobile = window.innerWidth <= 900;
  const stageRect = phoneStage.getBoundingClientRect();
  const availW = Math.max(200, stageRect.width - (isMobile ? 28 : 116));
  const availH = Math.max(260, stageRect.height - (isMobile ? 96 : 64));

  let targetH = availH;
  let targetW = targetH * aspect;
  if (targetW > availW) {
    targetW = availW;
    targetH = targetW / aspect;
  }

  screenViewport.style.width = `${Math.floor(targetW)}px`;
  screenViewport.style.height = `${Math.floor(targetH)}px`;
}

function updateStatsHud() {
  const parts = [`${appState.fps} FPS`];
  if (appState.rttMs !== null) parts.push(`${appState.rttMs}ms`);
  if (appState.activePhone?.bitrateKbps > 0) {
    parts.push(`${(appState.activePhone.bitrateKbps / 1000).toFixed(1)}M`);
  }
  streamStats.textContent = parts.join(' · ');
}

function updateHostMetricsBar() {
  const m = appState.metrics || {};
  hostCpu.textContent = m.cpuPercent !== undefined ? `${m.cpuPercent}%` : '--%';
  hostMem.textContent = m.memTotalMb
    ? `${(m.memUsedMb / 1024).toFixed(1)} / ${(m.memTotalMb / 1024).toFixed(0)}G`
    : '--';
  hostDisk.textContent = m.diskTotalGb ? `${m.diskUsedGb} / ${m.diskTotalGb}G` : '--';
  const runningCount = appState.phones.filter((p) => p.status === 'running' || p.status === 'starting').length;
  hostRunning.textContent = String(runningCount);
}

function deviceLabel(id) {
  const found = appState.catalog?.devices?.find((d) => d.id === id);
  return found ? found.label : id;
}

function screenLabel(preset) {
  return appState.catalog?.screenPresets?.[preset]?.label || preset;
}

function localeBadgeText(phone) {
  if (phone.resolvedLocale) return phone.resolvedLocale;
  if (phone.localeMode === 'auto_ip') return '语言: 跟随IP';
  return phone.localeMode || 'zh-CN';
}

function renderDashboard() {
  updateHostMetricsBar();
  if (!appState.phones.length) {
    phoneGrid.innerHTML = `<div class="muted">还没有云手机，点击右上角「新建云手机」开始创建。</div>`;
    return;
  }

  phoneGrid.innerHTML = appState.phones
    .map((p) => {
      const isRunning = p.status === 'running';
      const isBusy = p.status === 'starting' || p.status === 'stopping';
      const isError = p.status === 'error';

      const statusBadge = isRunning
        ? `<span class="status-badge status-running"><span class="dot dot-emerald"></span>运行中</span>`
        : isBusy
        ? `<span class="status-badge status-starting"><span class="dot dot-amber"></span>${p.status === 'stopping' ? '关机中' : `启动中 ${p.progress}%`}</span>`
        : isError
        ? `<span class="status-badge status-error"><span class="dot dot-red"></span>异常</span>`
        : `<span class="status-badge status-stopped"><span class="dot dot-gray"></span>已关机</span>`;

      const geoTag = p.geo
        ? `<span class="phone-tag tag-geo">🌐 ${escapeHtml(p.geo.countryCode)} · ${escapeHtml(p.geo.timezone)}</span>`
        : p.autoIpEnv
        ? `<span class="phone-tag">🌐 开机自动同步 IP 时区/GPS</span>`
        : '';

      const proxyTag = p.httpProxy ? `<span class="phone-tag">代理已配置</span>` : '';
      const idleTag =
        p.idleStopMinutes > 0
          ? `<span class="phone-tag">空闲 ${p.idleStopMinutes}m 自动关机</span>`
          : '';

      const progressBlock =
        isBusy || isError
          ? `<div class="phone-progress-box">
              ${isBusy ? `<div class="progress-track"><div class="progress-fill" style="width:${Math.max(4, p.progress || 8)}%"></div></div>` : ''}
              <div class="small ${isError ? 'muted' : ''}" style="${isError ? 'color:#fca5a5' : ''}">${escapeHtml(p.message)}</div>
            </div>`
          : '';

      const actionsHtml = isRunning
        ? `
          <button class="btn btn-primary btn-sm btn-main" data-enter="${escapeHtml(p.id)}">进入屏幕</button>
          <button class="btn btn-danger btn-sm" data-stop="${escapeHtml(p.id)}">关机</button>
          <button class="btn btn-subtle btn-sm" data-edit="${escapeHtml(p.id)}">配置</button>
        `
        : isBusy
        ? `
          <button class="btn btn-subtle btn-sm btn-main" data-logs="${escapeHtml(p.id)}">查看启动日志</button>
          <button class="btn btn-danger btn-sm" data-stop="${escapeHtml(p.id)}">取消/关机</button>
        `
        : `
          <button class="btn btn-emerald btn-sm btn-main" data-start="${escapeHtml(p.id)}">一键开机</button>
          <button class="btn btn-subtle btn-sm" data-edit="${escapeHtml(p.id)}">配置</button>
          <button class="btn btn-ghost btn-sm" data-delete="${escapeHtml(p.id)}" title="删除云手机">删除</button>
        `;

      return `
        <article class="phone-card glass-panel ${isRunning ? 'card-running' : ''}">
          <div class="phone-card-head">
            <div>
              <div class="phone-card-title">${escapeHtml(p.name)}</div>
              <div class="phone-card-sub">${escapeHtml(deviceLabel(p.device))} · Android ${escapeHtml(p.androidVersion)} · Google Play</div>
            </div>
            ${statusBadge}
          </div>

          <div class="phone-tags">
            <span class="phone-tag">${escapeHtml(screenLabel(p.screenPreset))}</span>
            <span class="phone-tag">${p.cores}核 / ${(p.ramMb / 1024).toFixed(p.ramMb % 1024 === 0 ? 0 : 1)}G</span>
            <span class="phone-tag">语言: ${escapeHtml(localeBadgeText(p))}</span>
            ${geoTag}
            ${proxyTag}
            ${idleTag}
          </div>

          ${progressBlock}

          <div class="phone-card-actions">${actionsHtml}</div>
        </article>
      `;
    })
    .join('');

  phoneGrid.querySelectorAll('[data-start]').forEach((b) =>
    b.addEventListener('click', () => startPhone(b.dataset.start))
  );
  phoneGrid.querySelectorAll('[data-stop]').forEach((b) =>
    b.addEventListener('click', () => stopPhone(b.dataset.stop))
  );
  phoneGrid.querySelectorAll('[data-enter]').forEach((b) =>
    b.addEventListener('click', () => enterPhoneConsole(b.dataset.enter))
  );
  phoneGrid.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => openPhoneModal(b.dataset.edit))
  );
  phoneGrid.querySelectorAll('[data-delete]').forEach((b) =>
    b.addEventListener('click', () => deletePhone(b.dataset.delete))
  );
  phoneGrid.querySelectorAll('[data-logs]').forEach((b) =>
    b.addEventListener('click', () => openLogsModal(b.dataset.logs))
  );
}

async function startPhone(id) {
  try {
    await api(`/api/phones/${encodeURIComponent(id)}/start`, { method: 'POST' });
    toast('正在启动云手机（首次启动新 Android 版本会自动下载镜像）');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function stopPhone(id) {
  try {
    await api(`/api/phones/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    toast('正在安全保存快照并关机…', 'success');
    if (appState.activePhoneId === id && appState.view === 'console') {
      leavePhoneConsole();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deletePhone(id) {
  const p = appState.phones.find((x) => x.id === id);
  if (!confirm(`确定删除云手机「${p?.name || id}」及其所有手机数据和登录状态吗？此操作不可恢复。`)) return;
  try {
    await api(`/api/phones/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('已删除云手机并释放磁盘空间', 'success');
    await refreshDashboardData();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// Create / Edit Phone Modal
function populateModalSelects() {
  if (!appState.catalog) return;
  const verSel = document.getElementById('pf-version');
  verSel.innerHTML = appState.catalog.androidVersions
    .map(
      (v) =>
        `<option value="${v.version}">${escapeHtml(v.label)}${v.downloaded ? ' · 已缓存' : ' · 首次需下载'}</option>`
    )
    .join('');

  const devSel = document.getElementById('pf-device');
  devSel.innerHTML = appState.catalog.devices
    .map((d) => `<option value="${d.id}">${escapeHtml(d.label)} (${escapeHtml(d.desc)})</option>`)
    .join('');

  const scrSel = document.getElementById('pf-screen');
  scrSel.innerHTML = Object.entries(appState.catalog.screenPresets)
    .map(([k, v]) => `<option value="${k}">${escapeHtml(v.label)}</option>`)
    .join('');

  const locSel = document.getElementById('pf-locale');
  locSel.innerHTML = appState.catalog.localeOptions
    .map((l) => `<option value="${l.id}">${escapeHtml(l.label)}</option>`)
    .join('');
}

function openPhoneModal(editId = null) {
  populateModalSelects();
  const editing = editId ? appState.phones.find((p) => p.id === editId) : null;
  phoneModalTitle.textContent = editing ? `配置云手机 · ${editing.name}` : '新建云手机';
  document.getElementById('pf-id').value = editing ? editing.id : '';
  document.getElementById('pf-name').value = editing ? editing.name : `云手机 #${appState.phones.length + 1}`;
  document.getElementById('pf-version').value = editing ? editing.androidVersion : '16';
  document.getElementById('pf-version').disabled = Boolean(editing);
  document.getElementById('pf-device').value = editing ? editing.device : 'pixel_8';
  document.getElementById('pf-screen').value = editing ? editing.screenPreset : 'balanced';
  document.getElementById('pf-locale').value = editing ? editing.localeMode : 'zh-CN';
  document.getElementById('pf-ram').value = String(editing ? editing.ramMb : 4096);
  document.getElementById('pf-cores').value = String(editing ? editing.cores : 4);
  document.getElementById('pf-idle').value = String(editing ? editing.idleStopMinutes : 30);
  document.getElementById('pf-storage').value = editing ? editing.dataSize : '16G';
  document.getElementById('pf-proxy').value = editing ? editing.httpProxy || '' : '';
  document.getElementById('pf-auto-ip').checked = editing ? Boolean(editing.autoIpEnv) : true;
  document.getElementById('pf-hint').textContent = editing
    ? '修改配置后，将在下次开机时生效'
    : '新建后默认处于关机状态，按需开机不占 CPU 和内存';
  phoneModal.classList.remove('hidden');
}

function closePhoneModal() {
  phoneModal.classList.add('hidden');
}

document.getElementById('btn-new-phone').addEventListener('click', () => openPhoneModal(null));
document.getElementById('phone-modal-close').addEventListener('click', closePhoneModal);
document.getElementById('pf-cancel').addEventListener('click', closePhoneModal);
phoneModal.addEventListener('click', (e) => {
  if (e.target === phoneModal) closePhoneModal();
});

phoneForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('pf-id').value;
  const payload = {
    name: document.getElementById('pf-name').value.trim(),
    androidVersion: document.getElementById('pf-version').value,
    device: document.getElementById('pf-device').value,
    screenPreset: document.getElementById('pf-screen').value,
    localeMode: document.getElementById('pf-locale').value,
    ramMb: Number(document.getElementById('pf-ram').value),
    cores: Number(document.getElementById('pf-cores').value),
    idleStopMinutes: Number(document.getElementById('pf-idle').value),
    dataSize: document.getElementById('pf-storage').value,
    httpProxy: document.getElementById('pf-proxy').value.trim(),
    autoIpEnv: document.getElementById('pf-auto-ip').checked,
  };
  try {
    if (id) {
      await api(`/api/phones/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload });
      toast('配置已更新', 'success');
    } else {
      await api('/api/phones', { method: 'POST', body: payload });
      toast('云手机已创建，点击「一键开机」即可使用', 'success');
    }
    closePhoneModal();
    await refreshDashboardData();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// Logs Modal
async function openLogsModal(phoneId) {
  const p = appState.phones.find((x) => x.id === phoneId);
  logsModalTitle.textContent = `启动与运行日志 · ${p?.name || phoneId}`;
  logsModal.classList.remove('hidden');

  const load = async () => {
    try {
      const data = await api(`/api/phones/${encodeURIComponent(phoneId)}/logs`);
      logsModalBody.textContent = (data.logs || []).join('\n') || '暂无日志…';
      logsModalBody.scrollTop = logsModalBody.scrollHeight;
    } catch {
      // ignore
    }
  };
  await load();
  clearInterval(logsPollTimer);
  logsPollTimer = setInterval(load, 2000);
}

function closeLogsModal() {
  clearInterval(logsPollTimer);
  logsModal.classList.add('hidden');
}

document.getElementById('logs-modal-close').addEventListener('click', closeLogsModal);
logsModal.addEventListener('click', (e) => {
  if (e.target === logsModal) closeLogsModal();
});

// Video decoder & input & drawer
function sendWsJson(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function sendWsBinary(buf) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(buf);
  }
}

const renderer = new VideoStreamRenderer({
  canvas: videoCanvas,
  videoEl: videoFallback,
  onFirstFrame: () => {
    streamOverlay.classList.add('hidden');
    connDot.className = 'dot dot-emerald';
  },
  onFps: (fps) => {
    appState.fps = fps;
    updateStatsHud();
  },
  onEngineChange: (engine) => {
    appState.decoderEngine = engine;
  },
});

new PhoneInputController({
  viewport: screenViewport,
  imeSink: document.getElementById('ime-sink'),
  pinchDot1: document.getElementById('pinch-dot-1'),
  pinchDot2: document.getElementById('pinch-dot-2'),
  sendBinary: sendWsBinary,
  sendJson: sendWsJson,
  onOpenImeModal: openImeModal,
});

const drawer = new DrawerController({
  drawerEl: document.getElementById('side-drawer'),
  titleEl: document.getElementById('drawer-title'),
  bodyEl: document.getElementById('drawer-body'),
  closeBtn: document.getElementById('drawer-close'),
  api,
  sendJson: sendWsJson,
  toast,
  getState: () => appState,
});

function setActiveQualityButton(preset) {
  document.querySelectorAll('#quality-segmented .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.preset === preset);
  });
}

function updateConsoleHeader() {
  const p = appState.activePhone;
  if (!p) return;
  deviceTitle.textContent = `${p.name} · Android ${p.androidVersion}`;
  setActiveQualityButton(p.streamPreset || 'balanced');
  if (p.geo) {
    consoleGeoChip.textContent = `${p.geo.countryCode} · ${p.geo.timezone}`;
    consoleGeoChip.classList.remove('hidden');
  } else {
    consoleGeoChip.classList.add('hidden');
  }
}

function enterPhoneConsole(phoneId) {
  const phone = appState.phones.find((p) => p.id === phoneId);
  if (!phone) return;
  appState.activePhoneId = phoneId;
  appState.activePhone = phone;
  appState.logs = [];
  appState.lastClipboard = '';
  appState.fps = 0;
  renderer.reset();
  streamOverlay.classList.remove('hidden');
  streamOverlayText.textContent = '正在建立低延迟视频通道…';
  connDot.className = 'dot dot-amber';
  updateConsoleHeader();
  drawer.close();
  showView('console');
  connectWebSocket(phoneId);
}

function leavePhoneConsole() {
  appState.activePhoneId = null;
  appState.activePhone = null;
  drawer.close();
  renderer.reset();
  showView('dashboard');
  connectWebSocket(null);
  refreshDashboardData();
}

document.getElementById('btn-back-dashboard').addEventListener('click', leavePhoneConsole);
document.getElementById('btn-console-poweroff').addEventListener('click', () => {
  if (!appState.activePhoneId) return;
  if (!confirm('安全保存快照并关机后，将立即释放该云手机占用的 CPU 和内存。确认关机？')) return;
  stopPhone(appState.activePhoneId);
});

// WebSocket management (dashboard mode: phoneId=null; console mode: phoneId=<id>)
function closeWebSocket() {
  clearTimeout(wsReconnectTimer);
  clearInterval(pingTimer);
  if (ws) {
    const old = ws;
    ws = null;
    try { old.close(); } catch {}
  }
}

function connectWebSocket(phoneId = null) {
  closeWebSocket();
  wsPhoneId = phoneId;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = phoneId ? `?phoneId=${encodeURIComponent(phoneId)}` : '';
  const sock = new WebSocket(`${proto}//${location.host}/ws${query}`);
  sock.binaryType = 'arraybuffer';
  ws = sock;

  sock.addEventListener('open', () => {
    if (ws !== sock) return;
    if (phoneId) {
      connDot.className = 'dot dot-amber';
      streamOverlayText.textContent = '已连接，等待画面关键帧…';
      pingTimer = setInterval(() => sendWsJson({ type: 'ping', ts: performance.now() }), 3000);
    }
  });

  sock.addEventListener('message', (ev) => {
    if (ws !== sock) return;
    if (typeof ev.data === 'string') {
      handleWsJson(JSON.parse(ev.data));
      return;
    }
    const bytes = new Uint8Array(ev.data);
    if (bytes.length < 2) return;
    const frameType = bytes[0];
    if (frameType === 0x01) {
      renderer.feedConfig(bytes.subarray(1));
    } else if (frameType === 0x02 || frameType === 0x03) {
      if (bytes.length <= 9) return;
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const pts = dv.getBigUint64(1);
      renderer.feedVideoFrame(frameType === 0x02, pts, bytes.subarray(9));
    }
  });

  sock.addEventListener('close', () => {
    if (ws !== sock) return;
    clearInterval(pingTimer);
    if (phoneId) {
      connDot.className = 'dot dot-red';
      streamOverlay.classList.remove('hidden');
      streamOverlayText.textContent = '连接中断，正在自动重连…';
      renderer.reset();
    }
    if (appState.authenticated) {
      wsReconnectTimer = setTimeout(() => connectWebSocket(wsPhoneId), 1800);
    }
  });
}

function handleWsJson(msg) {
  switch (msg.type) {
    case 'phones':
      appState.phones = msg.phones || [];
      if (appState.activePhoneId) {
        const current = appState.phones.find((p) => p.id === appState.activePhoneId);
        if (current) {
          appState.activePhone = current;
          updateConsoleHeader();
          if (current.status === 'stopped' && appState.view === 'console') {
            toast('云手机已关机，已返回设备中心');
            leavePhoneConsole();
            return;
          }
        }
      }
      if (appState.view === 'dashboard') renderDashboard();
      drawer.refreshIfOpen('system');
      break;

    case 'phone_status':
      if (msg.phone) {
        appState.activePhone = msg.phone;
        updateConsoleHeader();
      }
      if (Array.isArray(msg.logs)) {
        appState.logs = msg.logs;
      }
      break;

    case 'video_meta':
      appState.videoMeta = {
        width: msg.width || 720,
        height: msg.height || 1600,
        deviceName: msg.deviceName || 'Pixel Cloud',
      };
      renderer.setDimensions(appState.videoMeta.width, appState.videoMeta.height);
      fitPhoneViewport();
      break;

    case 'log':
      if (msg.line) {
        appState.logs.push(msg.line);
        if (appState.logs.length > 200) appState.logs.shift();
        drawer.refreshIfOpen('system');
      }
      break;

    case 'metrics':
      appState.metrics = msg;
      updateHostMetricsBar();
      updateStatsHud();
      drawer.refreshIfOpen('system');
      break;

    case 'clipboard':
      appState.lastClipboard = msg.text || '';
      drawer.refreshIfOpen('clipboard');
      toast('已同步手机剪贴板内容');
      break;

    case 'toast':
      toast(msg.message, msg.level);
      break;

    case 'pong':
      if (typeof msg.ts === 'number') {
        appState.rttMs = Math.max(1, Math.round(performance.now() - msg.ts));
        updateStatsHud();
      }
      break;

    default:
      break;
  }
}

// IME modal
function openImeModal() {
  if (appState.view !== 'console') return;
  imeModal.classList.remove('hidden');
  imeModalInput.value = '';
  setTimeout(() => imeModalInput.focus(), 30);
}

function closeImeModal() {
  imeModal.classList.add('hidden');
}

function submitImeModal(paste = true) {
  const val = imeModalInput.value;
  if (!val) {
    closeImeModal();
    return;
  }
  sendWsJson({ type: 'clipboard_set', text: val, paste });
  if (paste && imeModalEnter.checked) {
    setTimeout(() => {
      sendWsJson({ type: 'key', action: 0, keycode: 66, metaState: 0, repeat: 0 });
      sendWsJson({ type: 'key', action: 1, keycode: 66, metaState: 0, repeat: 0 });
    }, 120);
  }
  toast(paste ? '已发送并粘贴到手机' : '已写入手机剪贴板', 'success');
  closeImeModal();
}

document.getElementById('open-ime-btn').addEventListener('click', openImeModal);
document.getElementById('ime-modal-close').addEventListener('click', closeImeModal);
document.getElementById('ime-modal-send').addEventListener('click', () => submitImeModal(true));
document.getElementById('ime-modal-copy-only').addEventListener('click', () => submitImeModal(false));
imeModal.addEventListener('click', (e) => {
  if (e.target === imeModal) closeImeModal();
});
imeModalInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    submitImeModal(true);
  } else if (e.key === 'Escape') {
    closeImeModal();
  }
});

// Console buttons
document.querySelectorAll('#quality-segmented .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const preset = btn.dataset.preset;
    setActiveQualityButton(preset);
    sendWsJson({ type: 'quality', preset });
  });
});

document.querySelectorAll('[data-drawer]').forEach((btn) => {
  btn.addEventListener('click', () => drawer.toggle(btn.dataset.drawer));
});

document.querySelectorAll('.dock-btn[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => sendWsJson({ type: 'action', name: btn.dataset.action }));
});

document.getElementById('btn-screenshot').addEventListener('click', () => {
  if (!appState.activePhoneId) return;
  const link = document.createElement('a');
  link.href = `/api/phones/${encodeURIComponent(appState.activePhoneId)}/screenshot?t=${Date.now()}`;
  link.download = `droidcloud-${appState.activePhoneId}-${Date.now()}.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  toast('正在保存高清截图…', 'success');
});

async function handleLogout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  appState.authenticated = false;
  appState.activePhoneId = null;
  closeWebSocket();
  renderer.reset();
  drawer.close();
  showView('login');
  loginPassword.value = '';
  loginPassword.focus();
}

document.getElementById('dash-logout-btn').addEventListener('click', handleLogout);

// Drag & Drop APK/File when in phone console
let dragCounter = 0;
window.addEventListener('dragenter', (e) => {
  if (!appState.authenticated || appState.view !== 'console') return;
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  dragCounter++;
  dropOverlay.classList.remove('hidden');
});
window.addEventListener('dragover', (e) => {
  if (dragCounter > 0) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  if (dragCounter > 0) dragCounter--;
  if (dragCounter === 0) dropOverlay.classList.add('hidden');
});
window.addEventListener('drop', async (e) => {
  if (!appState.authenticated || appState.view !== 'console') return;
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.add('hidden');
  const files = Array.from(e.dataTransfer?.files || []);
  for (const file of files) {
    if (file.name.toLowerCase().endsWith('.apk')) {
      await drawer.installApkFile(file);
    } else {
      await drawer.uploadFileToPhone(file);
    }
  }
});

// Login form
togglePwBtn.addEventListener('click', () => {
  loginPassword.type = loginPassword.type === 'password' ? 'text' : 'password';
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.classList.add('hidden');
  loginSubmit.disabled = true;
  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: { password: loginPassword.value },
    });
    appState.authenticated = true;
    await enterDashboard();
  } catch (err) {
    loginError.textContent = err.message;
    loginError.classList.remove('hidden');
    loginForm.classList.remove('shake');
    void loginForm.offsetWidth;
    loginForm.classList.add('shake');
    loginPassword.select();
  } finally {
    loginSubmit.disabled = false;
  }
});

window.addEventListener('resize', () => {
  if (appState.view === 'console') fitPhoneViewport();
});

async function refreshDashboardData() {
  const data = await api('/api/phones');
  appState.phones = data.phones || [];
  appState.metrics = data.metrics || {};
  appState.catalog = data.catalog || appState.catalog;
  renderDashboard();
}

async function enterDashboard() {
  showView('dashboard');
  try {
    await refreshDashboardData();
  } catch (err) {
    toast(err.message, 'error');
  }
  connectWebSocket(null);
}

// Bootstrap
(async function init() {
  try {
    const auth = await api('/api/auth/status');
    if (typeof auth.totalPhones === 'number') {
      loginPhoneCount.textContent = `${auth.totalPhones} 台云手机`;
    }
    if (auth.authenticated) {
      appState.authenticated = true;
      await enterDashboard();
    } else {
      showView('login');
      loginPassword.focus();
    }
  } catch {
    showView('login');
  }
})();
