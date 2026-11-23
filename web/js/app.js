import { VideoStreamRenderer } from './decoder.js';
import { PhoneInputController } from './input.js';
import { DrawerController } from './panels.js';

const STAGE_ORDER = ['init', 'downloading_sdk', 'downloading_image', 'creating_avd', 'booting', 'ready'];
const STAGE_NAMES = {
  init: '初始化环境',
  downloading_sdk: '下载 Android 工具链',
  downloading_image: '下载 Google Play 系统镜像',
  creating_avd: '创建虚拟手机',
  booting: '启动 Android 系统',
  installing_apks: '安装预置 APK',
  ready: '系统就绪',
  error: '启动异常',
};

const appState = {
  authenticated: false,
  ready: false,
  stage: 'init',
  androidVersion: '16',
  videoMeta: { width: 720, height: 1600, deviceName: 'Pixel Cloud' },
  metrics: {},
  deviceInfo: null,
  logs: [],
  lastClipboard: '',
  decoderEngine: 'WebCodecs',
  fps: 0,
  rttMs: null,
  preset: 'balanced',
};

// DOM references
const viewLogin = document.getElementById('view-login');
const viewBoot = document.getElementById('view-boot');
const viewConsole = document.getElementById('view-console');

const loginForm = document.getElementById('login-form');
const loginPassword = document.getElementById('login-password');
const loginError = document.getElementById('login-error');
const loginSubmit = document.getElementById('login-submit');
const togglePwBtn = document.getElementById('toggle-pw-btn');
const loginAndroidBadge = document.getElementById('login-android-badge');

const bootHeading = document.getElementById('boot-heading');
const bootMessage = document.getElementById('boot-message');
const bootProgressBar = document.getElementById('boot-progress-bar');
const bootStageLabel = document.getElementById('boot-stage-label');
const bootPercent = document.getElementById('boot-percent');
const bootLogsEl = document.getElementById('boot-logs');
const bootStepsEl = document.getElementById('boot-steps');

const connDot = document.getElementById('conn-dot');
const deviceTitle = document.getElementById('device-title');
const streamStats = document.getElementById('stream-stats');
const phoneStage = document.getElementById('phone-stage');
const screenViewport = document.getElementById('screen-viewport');
const videoCanvas = document.getElementById('video-canvas');
const videoFallback = document.getElementById('video-fallback');
const streamOverlay = document.getElementById('stream-overlay');
const streamOverlayText = document.getElementById('stream-overlay-text');

const imeModal = document.getElementById('ime-modal');
const imeModalInput = document.getElementById('ime-modal-input');
const imeModalEnter = document.getElementById('ime-modal-enter');
const dropOverlay = document.getElementById('drop-overlay');
const toastContainer = document.getElementById('toast-container');

let ws = null;
let wsReconnectTimer = null;
let pingTimer = null;

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
    showView('login');
    throw new Error('会话已过期，请重新登录');
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `请求失败 (${resp.status})`);
  return data;
}

function showView(name) {
  viewLogin.classList.toggle('hidden', name !== 'login');
  viewBoot.classList.toggle('hidden', name !== 'boot');
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
  if (appState.metrics.streamBitrateKbps > 0) {
    parts.push(`${(appState.metrics.streamBitrateKbps / 1000).toFixed(1)}M`);
  }
  streamStats.textContent = parts.join(' · ');
}

function updateBootUi(status) {
  appState.stage = status.stage || 'init';
  appState.ready = Boolean(status.ready);
  if (status.androidVersion) appState.androidVersion = status.androidVersion;

  if (Array.isArray(status.logs)) {
    appState.logs = status.logs;
    bootLogsEl.textContent = appState.logs.join('\n');
    bootLogsEl.scrollTop = bootLogsEl.scrollHeight;
  }

  const pct = Math.max(0, Math.min(100, Number(status.progress) || 0));
  bootProgressBar.style.width = `${pct}%`;
  bootPercent.textContent = `${pct}%`;
  bootMessage.textContent = status.message || '正在处理…';
  bootStageLabel.textContent = `阶段：${STAGE_NAMES[appState.stage] || appState.stage}`;
  bootHeading.textContent = status.error ? '启动过程中出现错误' : '正在准备云手机环境';

  const currentIdx = STAGE_ORDER.indexOf(appState.stage === 'installing_apks' ? 'booting' : appState.stage);
  bootStepsEl.querySelectorAll('.boot-step').forEach((stepEl) => {
    const idx = STAGE_ORDER.indexOf(stepEl.dataset.step);
    stepEl.classList.toggle('done', idx !== -1 && idx < currentIdx);
    stepEl.classList.toggle('active', idx === currentIdx);
  });

  if (appState.authenticated) {
    showView(appState.ready ? 'console' : 'boot');
  }
}

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

// Video decoder
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

// Input controller
new PhoneInputController({
  viewport: screenViewport,
  imeSink: document.getElementById('ime-sink'),
  pinchDot1: document.getElementById('pinch-dot-1'),
  pinchDot2: document.getElementById('pinch-dot-2'),
  sendBinary: sendWsBinary,
  sendJson: sendWsJson,
  onOpenImeModal: openImeModal,
});

// Side drawer
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

function connectWebSocket() {
  clearTimeout(wsReconnectTimer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('open', () => {
    connDot.className = 'dot dot-amber';
    streamOverlayText.textContent = '已连接，等待画面关键帧…';
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      sendWsJson({ type: 'ping', ts: performance.now() });
    }, 3000);
  });

  ws.addEventListener('message', (ev) => {
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

  ws.addEventListener('close', () => {
    clearInterval(pingTimer);
    connDot.className = 'dot dot-red';
    streamOverlay.classList.remove('hidden');
    streamOverlayText.textContent = '连接中断，正在自动重连…';
    renderer.reset();
    if (appState.authenticated) {
      wsReconnectTimer = setTimeout(connectWebSocket, 1800);
    }
  });
}

function handleWsJson(msg) {
  switch (msg.type) {
    case 'status':
      if (msg.preset) setActiveQualityButton(msg.preset);
      updateBootUi(msg);
      if (msg.ready && !appState.deviceInfo) {
        api('/api/status')
          .then((s) => {
            appState.deviceInfo = s.deviceInfo;
            if (s.metrics) appState.metrics = s.metrics;
          })
          .catch(() => {});
      }
      break;

    case 'video_meta':
      appState.videoMeta = {
        width: msg.width || 720,
        height: msg.height || 1600,
        deviceName: msg.deviceName || 'Pixel Cloud',
      };
      deviceTitle.textContent = `${appState.videoMeta.deviceName} · Android ${appState.androidVersion}`;
      renderer.setDimensions(appState.videoMeta.width, appState.videoMeta.height);
      fitPhoneViewport();
      break;

    case 'log':
      if (msg.line) {
        appState.logs.push(msg.line);
        if (appState.logs.length > 250) appState.logs.shift();
        bootLogsEl.textContent = appState.logs.join('\n');
        bootLogsEl.scrollTop = bootLogsEl.scrollHeight;
      }
      break;

    case 'metrics':
      appState.metrics = msg;
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

function setActiveQualityButton(preset) {
  appState.preset = preset;
  document.querySelectorAll('#quality-segmented .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.preset === preset);
  });
}

// IME modal logic
function openImeModal() {
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

// Topbar & Dock bindings
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
  btn.addEventListener('click', () => {
    sendWsJson({ type: 'action', name: btn.dataset.action });
  });
});

document.getElementById('btn-screenshot').addEventListener('click', () => {
  const link = document.createElement('a');
  link.href = `/api/screenshot?t=${Date.now()}`;
  link.download = `droidcloud-${Date.now()}.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  toast('正在保存高清截图…', 'success');
});

async function handleLogout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // ignore
  }
  appState.authenticated = false;
  clearTimeout(wsReconnectTimer);
  clearInterval(pingTimer);
  if (ws) ws.close();
  renderer.reset();
  drawer.close();
  showView('login');
  loginPassword.value = '';
  loginPassword.focus();
}

document.getElementById('logout-btn').addEventListener('click', handleLogout);
document.getElementById('boot-logout-btn').addEventListener('click', handleLogout);

// Global drag & drop APK/file install
let dragCounter = 0;
window.addEventListener('dragenter', (e) => {
  if (!appState.authenticated || !appState.ready) return;
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
  if (!appState.authenticated || !appState.ready) return;
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

// Login form handling
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
    await enterAuthenticatedApp();
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
  if (!viewConsole.classList.contains('hidden')) {
    fitPhoneViewport();
  }
});

async function enterAuthenticatedApp() {
  try {
    const status = await api('/api/status');
    appState.deviceInfo = status.deviceInfo;
    if (status.metrics) appState.metrics = status.metrics;
    if (status.preset) setActiveQualityButton(status.preset);
    if (status.videoMeta?.width) appState.videoMeta = status.videoMeta;
    updateBootUi(status);
  } catch {
    showView('boot');
  }
  connectWebSocket();
}

// Bootstrap
(async function init() {
  try {
    const auth = await api('/api/auth/status');
    if (auth.androidVersion) {
      appState.androidVersion = auth.androidVersion;
      loginAndroidBadge.textContent = `Android ${auth.androidVersion}`;
    }
    if (auth.authenticated) {
      appState.authenticated = true;
      await enterAuthenticatedApp();
    } else {
      showView('login');
      loginPassword.focus();
    }
  } catch {
    showView('login');
  }
})();
