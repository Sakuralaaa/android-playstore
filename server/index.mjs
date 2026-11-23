import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuthManager, getClientIp } from './auth.mjs';
import { WebSocketServer } from './ws.mjs';
import { PhoneManager } from './phones.mjs';
import { QUALITY_PRESETS } from './scrcpy.mjs';
import { collectSystemMetrics } from './system.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '../web');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes = 256 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('请求体过大'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('无效的 JSON 请求体'), { statusCode: 400 });
  }
}

async function streamBodyToTempFile(req, prefix = 'upload', maxBytes = 512 * 1024 * 1024) {
  const tmpPath = path.join(
    os.tmpdir(),
    `droidcloud-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const ws = fs.createWriteStream(tmpPath);
  let total = 0;
  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) {
        ws.destroy();
        await fs.promises.unlink(tmpPath).catch(() => {});
        throw Object.assign(new Error('文件超过大小限制 (512MB)'), { statusCode: 413 });
      }
      if (!ws.write(chunk)) {
        await new Promise((r) => ws.once('drain', r));
      }
    }
    await new Promise((resolve, reject) => {
      ws.end((err) => (err ? reject(err) : resolve()));
    });
    return {
      tmpPath,
      size: total,
      cleanup: () => fs.promises.unlink(tmpPath).catch(() => {}),
    };
  } catch (err) {
    ws.destroy();
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

function buildApiDocs(baseUrl) {
  return {
    name: 'DroidCloud Open Control API',
    version: '1.0',
    auth: {
      headers: ['Authorization: Bearer <API_TOKEN>', 'X-API-Key: <API_TOKEN>'],
      websocket: 'wss://<host>/ws?phoneId=<id>&token=<API_TOKEN>',
    },
    baseUrl,
    endpoints: [
      { method: 'GET', path: '/api/phones', desc: 'List all cloud phones, states, IP geo, and host metrics' },
      { method: 'POST', path: '/api/phones', desc: 'Create a new cloud phone (official KVM emulator or Redroid/ADB)', body: { name: 'string', engine: 'emulator|redroid', androidVersion: '9|10|11|13|14|15|16', device: 'pixel_8', adbAddress: 'redroid:5555', redroidPreset: 'redroid-11-gapps', screenPreset: 'smooth|balanced|hd', ramMb: 3072, cores: 3, localeMode: 'zh-CN|auto_ip|en-US', autoIpEnv: true, ecoMode: true, httpProxy: '', idleStopMinutes: 30, autoStart: false } },
      { method: 'POST', path: '/api/phones/:id/start', desc: 'Boot phone on demand' },
      { method: 'POST', path: '/api/phones/:id/stop', desc: 'Save snapshot & power off phone' },
      { method: 'GET', path: '/api/phones/:id/screen-info', desc: 'Get screen width, height, and current focused app/activity' },
      { method: 'GET', path: '/api/phones/:id/screenshot', desc: 'Capture PNG screenshot (?format=base64 for JSON base64)' },
      { method: 'GET', path: '/api/phones/:id/ui-tree', desc: 'Dump structured Android Accessibility UI elements (?xml=1 to include raw XML)' },
      { method: 'POST', path: '/api/phones/:id/input/tap', desc: 'Tap coordinates', body: { x: 360, y: 800, normalized: false } },
      { method: 'POST', path: '/api/phones/:id/input/long-press', desc: 'Long press coordinates', body: { x: 360, y: 800, durationMs: 800 } },
      { method: 'POST', path: '/api/phones/:id/input/swipe', desc: 'Swipe gesture', body: { x1: 360, y1: 1200, x2: 360, y2: 400, durationMs: 300 } },
      { method: 'POST', path: '/api/phones/:id/input/text', desc: 'Input ASCII or Chinese/Unicode text', body: { text: 'hello 你好', enter: false } },
      { method: 'POST', path: '/api/phones/:id/input/key', desc: 'Press key by name (home|back|recents|enter|delete|power|vol_up|vol_down) or Android keycode', body: { key: 'home' } },
      { method: 'POST', path: '/api/phones/:id/shell', desc: 'Execute an adb shell command on the phone', body: { command: 'getprop ro.product.model', timeoutMs: 10000 } },
      { method: 'GET', path: '/api/phones/:id/apps', desc: 'List installed Google and user apps' },
      { method: 'POST', path: '/api/phones/:id/apps/launch', desc: 'Launch an app by packageName', body: { packageName: 'com.android.vending' } },
      { method: 'POST', path: '/api/phones/:id/apk/install', desc: 'Install APK (raw binary body + X-Filename header)' },
      { method: 'POST', path: '/api/phones/:id/location', desc: 'Set mock GPS location', body: { lon: -118.2437, lat: 34.0522 } },
      { method: 'POST', path: '/api/phones/:id/sync-ip', desc: 'Re-detect exit IP and sync GPS' },
      { method: 'POST', path: '/api/phones/:id/diagnose', desc: 'Run internal network/DNS/GMS diagnostic report' },
      { method: 'POST', path: '/api/phones/:id/fix-google', desc: 'Reset Wi-Fi, sync time, and clear Play Store cache' },
    ],
  };
}

export function createDroidCloudServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 6080);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  const auth =
    options.auth ??
    new AuthManager({
      password: options.password,
      apiToken: options.apiToken,
      persistDir: options.persistDir,
    });
  const phones =
    options.phones ??
    new PhoneManager({
      avdHome: options.avdHome || process.env.ANDROID_AVD_HOME_PARENT || '/root/.android',
      sdkRoot: options.sdkRoot || process.env.ANDROID_SDK_ROOT || '/opt/android-sdk',
      geoDetector: options.geoDetector,
    });
  const enableBackgroundLoops = options.enableBackgroundLoops ?? true;

  const wss = new WebSocketServer({
    path: '/ws',
    verifyClient: (req) => auth.isAuthenticated(req),
  });

  const clientScope = new Map();

  function broadcastToPhone(phoneId, obj) {
    const text = JSON.stringify(obj);
    for (const [client, scope] of clientScope.entries()) {
      if (scope === phoneId && !client.closed) {
        client.sendText(text);
      }
    }
  }

  function broadcastBinaryToPhone(phoneId, buf, opts = {}) {
    const maxBuffered = opts.maxBuffered ?? 384 * 1024;
    for (const [client, scope] of clientScope.entries()) {
      if (scope !== phoneId || client.closed) continue;
      if (opts.droppable && client.bufferedAmount > maxBuffered) continue;
      client.sendBinary(buf);
    }
  }

  phones.on('phones_changed', (list) => {
    wss.broadcastJson({ type: 'phones', phones: list });
  });

  phones.on('phone_status', (summary) => {
    broadcastToPhone(summary.id, { type: 'phone_status', phone: summary });
  });

  phones.on('phone_log', ({ id, line }) => {
    broadcastToPhone(id, { type: 'log', phoneId: id, line });
  });

  phones.on('phone_video_meta', ({ id, meta }) => {
    broadcastToPhone(id, { type: 'video_meta', phoneId: id, ...meta });
  });

  phones.on('phone_video_frame', ({ id, frame, isConfig, isKeyFrame }) => {
    broadcastBinaryToPhone(id, frame, { droppable: !isConfig && !isKeyFrame });
  });

  phones.on('phone_clipboard', ({ id, text }) => {
    broadcastToPhone(id, { type: 'clipboard', phoneId: id, text });
  });

  wss.on('connection', (client, req) => {
    const url = new URL(req.url || '/ws', 'http://localhost');
    const phoneId = url.searchParams.get('phoneId') || null;
    clientScope.set(client, phoneId);

    client.sendJson({ type: 'phones', phones: phones.listPhones() });

    if (phoneId) {
      const summary = phones.getPhoneSummary(phoneId);
      const rt = phones.getRuntime(phoneId);
      if (summary && rt) {
        phones.attachViewer(phoneId, client);
        client.sendJson({
          type: 'phone_status',
          phone: summary,
          logs: phones.getPhoneLogs(phoneId),
          presets: QUALITY_PRESETS,
        });
        if (rt.scrcpy?.isConnected && rt.scrcpy.meta.width > 0) {
          client.sendJson({ type: 'video_meta', phoneId, ...rt.scrcpy.meta });
          if (rt.scrcpy.lastConfigFrame) client.sendBinary(rt.scrcpy.lastConfigFrame);
          if (rt.scrcpy.lastKeyFrame) client.sendBinary(rt.scrcpy.lastKeyFrame);
          rt.scrcpy.requestKeyFrame();
        }
      }
    }

    client.on('close', () => {
      const scope = clientScope.get(client);
      clientScope.delete(client);
      if (scope) {
        phones.detachViewer(scope, client);
      }
    });

    client.on('message', (data, isBinary) => {
      const targetId = clientScope.get(client);
      if (isBinary) {
        if (targetId) handleBinaryControl(targetId, data);
      } else {
        handleJsonControl(client, targetId, data);
      }
    });
  });

  function handleBinaryControl(phoneId, buf) {
    const rt = phones.getRuntime(phoneId);
    const scrcpy = rt?.scrcpy;
    if (!scrcpy || !Buffer.isBuffer(buf) || buf.length < 2) return;
    rt.lastActiveAt = Date.now();
    const type = buf[0];

    if (type === 0x10 && buf.length >= 18) {
      const action = buf.readUInt8(1);
      const pointerId = BigInt(buf.readInt32BE(2));
      const normX = buf.readFloatBE(6);
      const normY = buf.readFloatBE(10);
      const pressure = buf.readFloatBE(14);
      const w = scrcpy.meta.width || 720;
      const h = scrcpy.meta.height || 1600;
      scrcpy.sendTouch({
        action,
        pointerId,
        x: Math.max(0, Math.min(w - 1, Math.round(normX * w))),
        y: Math.max(0, Math.min(h - 1, Math.round(normY * h))),
        screenWidth: w,
        screenHeight: h,
        pressure,
      });
      return;
    }

    if (type === 0x11 && buf.length >= 17) {
      const normX = buf.readFloatBE(1);
      const normY = buf.readFloatBE(5);
      const hScroll = buf.readFloatBE(9);
      const vScroll = buf.readFloatBE(13);
      const w = scrcpy.meta.width || 720;
      const h = scrcpy.meta.height || 1600;
      scrcpy.sendScroll({
        x: Math.max(0, Math.min(w - 1, Math.round(normX * w))),
        y: Math.max(0, Math.min(h - 1, Math.round(normY * h))),
        screenWidth: w,
        screenHeight: h,
        hScroll,
        vScroll,
      });
    }
  }

  async function handleJsonControl(client, phoneId, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'ping') {
      client.sendJson({ type: 'pong', ts: msg.ts });
      return;
    }

    if (!phoneId) return;
    const rt = phones.getRuntime(phoneId);
    const scrcpy = rt?.scrcpy;
    if (!scrcpy) return;
    rt.lastActiveAt = Date.now();

    switch (msg.type) {
      case 'key':
        scrcpy.sendKey(msg.action | 0, msg.keycode | 0, msg.metaState | 0, msg.repeat | 0);
        break;
      case 'text':
        scrcpy.sendText(msg.text || '');
        break;
      case 'clipboard_set':
        scrcpy.setClipboard(msg.text || '', Boolean(msg.paste));
        break;
      case 'action':
        scrcpy.performAction(msg.name);
        break;
      case 'quality':
        try {
          await scrcpy.setQualityPreset(msg.preset);
          phones.updatePhone(phoneId, { streamPreset: msg.preset });
          broadcastToPhone(phoneId, {
            type: 'toast',
            level: 'success',
            message: `画质已切换为 ${QUALITY_PRESETS[msg.preset].label}`,
          });
        } catch (err) {
          client.sendJson({ type: 'toast', level: 'error', message: err.message });
        }
        break;
      default:
        break;
    }
  }

  async function requireRunningAdb(phoneId, { wake = true } = {}) {
    const rt = phones.getRuntime(phoneId);
    if (!rt) throw Object.assign(new Error('找不到指定的云手机'), { statusCode: 404 });
    if (rt.status !== 'running' || !rt.adb) {
      throw Object.assign(new Error('该云手机尚未开机就绪'), { statusCode: 409 });
    }
    if (wake) {
      await phones.ensureAwake(phoneId);
    } else {
      rt.lastActiveAt = Date.now();
    }
    return rt;
  }

  async function resolveCoords(rt, x, y, normalized = false) {
    if (!normalized) return { x: Number(x), y: Number(y) };
    const info = rt.scrcpy?.meta?.width
      ? { width: rt.scrcpy.meta.width, height: rt.scrcpy.meta.height }
      : await rt.adb.getScreenInfo();
    return {
      x: Math.round(Math.max(0, Math.min(1, Number(x))) * info.width),
      y: Math.round(Math.max(0, Math.min(1, Number(y))) * info.height),
    };
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');

    if (pathname === '/api/health' && req.method === 'GET') {
      const list = phones.listPhones();
      return sendJson(res, 200, {
        ok: true,
        totalPhones: list.length,
        runningPhones: list.filter((p) => p.status === 'running').length,
      });
    }

    if (pathname === '/api/auth/status' && req.method === 'GET') {
      return sendJson(res, 200, {
        authenticated: auth.isAuthenticated(req),
        totalPhones: phones.listPhones().length,
      });
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const ip = getClientIp(req);
      const rl = auth.checkRateLimit(ip);
      if (!rl.allowed) {
        return sendJson(
          res,
          429,
          { error: `尝试次数过多，请 ${rl.retryAfterSec} 秒后重试` },
          { 'Retry-After': String(rl.retryAfterSec) }
        );
      }

      try {
        const body = await readJsonBody(req);
        if (!auth.verifyPassword(body.password)) {
          auth.recordFailure(ip);
          return sendJson(res, 401, { error: '访问密码错误' });
        }
        auth.clearFailures(ip);
        const token = auth.createToken();
        return sendJson(
          res,
          200,
          { ok: true },
          { 'Set-Cookie': auth.buildLoginCookie(req, token) }
        );
      } catch (err) {
        return sendJson(res, err.statusCode || 400, { error: err.message });
      }
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.buildLogoutCookie(req) });
    }

    if (pathname.startsWith('/api/')) {
      if (!auth.isAuthenticated(req)) {
        return sendJson(res, 401, { error: '未登录或 API Token 无效' });
      }
      return handleProtectedApi(req, res, url);
    }

    return serveStatic(req, res, pathname);
  }

  async function handleProtectedApi(req, res, url) {
    // Support optional /api/v1/* alias seamlessly
    const pathname = url.pathname.replace(/^\/api\/v1\//, '/api/');
    try {
      if (pathname === '/api/docs' && req.method === 'GET') {
        const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
        const hostHdr = req.headers.host || 'localhost:6080';
        return sendJson(res, 200, buildApiDocs(`${proto}://${hostHdr}`));
      }

      if (pathname === '/api/token' && req.method === 'GET') {
        return sendJson(res, 200, {
          token: auth.apiToken,
          fromEnv: auth.apiTokenFromEnv,
        });
      }

      if (pathname === '/api/token/rotate' && req.method === 'POST') {
        const token = auth.rotateApiToken();
        return sendJson(res, 200, { token, fromEnv: false });
      }

      if (pathname === '/api/catalog' && req.method === 'GET') {
        return sendJson(res, 200, phones.getCatalog());
      }

      if (pathname === '/api/phones' && req.method === 'GET') {
        const metrics = await collectSystemMetrics();
        return sendJson(res, 200, {
          phones: phones.listPhones(),
          metrics,
          catalog: phones.getCatalog(),
        });
      }

      if (pathname === '/api/phones' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const created = phones.createPhone(body);
        if (body.autoStart) {
          await phones.startPhone(created.id);
        }
        return sendJson(res, 201, { phone: phones.getPhoneSummary(created.id) });
      }

      const m = pathname.match(/^\/api\/phones\/([^/]+)(\/.*)?$/);
      if (m) {
        const phoneId = decodeURIComponent(m[1]);
        const sub = m[2] || '';
        return handlePhoneRoute(req, res, url, phoneId, sub);
      }

      return sendJson(res, 404, { error: 'API 路径不存在' });
    } catch (err) {
      return sendJson(res, err.statusCode || 500, { error: err.message || '服务器内部错误' });
    }
  }

  async function handlePhoneRoute(req, res, url, phoneId, sub) {
    if (sub === '' && req.method === 'GET') {
      const summary = phones.getPhoneSummary(phoneId);
      if (!summary) return sendJson(res, 404, { error: '找不到指定的云手机' });
      const rt = phones.getRuntime(phoneId);
      const [metrics, deviceInfo] = await Promise.all([
        collectSystemMetrics(),
        rt?.status === 'running' && rt.adb ? rt.adb.getDeviceInfo() : Promise.resolve(null),
      ]);
      return sendJson(res, 200, {
        phone: summary,
        logs: phones.getPhoneLogs(phoneId),
        metrics,
        deviceInfo,
      });
    }

    if (sub === '' && req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const updated = phones.updatePhone(phoneId, body);
      return sendJson(res, 200, { phone: updated });
    }

    if (sub === '' && req.method === 'DELETE') {
      await phones.deletePhone(phoneId);
      return sendJson(res, 200, { ok: true });
    }

    if (sub === '/start' && req.method === 'POST') {
      const summary = await phones.startPhone(phoneId);
      return sendJson(res, 200, { phone: summary });
    }

    if (sub === '/stop' && req.method === 'POST') {
      await phones.stopPhone(phoneId);
      return sendJson(res, 200, { phone: phones.getPhoneSummary(phoneId) });
    }

    if (sub === '/reboot' && req.method === 'POST') {
      const summary = await phones.rebootPhone(phoneId);
      return sendJson(res, 200, { phone: summary });
    }

    if (sub === '/sync-ip' && req.method === 'POST') {
      const geo = await phones.syncPhoneIpNow(phoneId);
      return sendJson(res, 200, { ok: true, geo });
    }

    if (sub === '/logs' && req.method === 'GET') {
      return sendJson(res, 200, { logs: phones.getPhoneLogs(phoneId) });
    }

    // --- Open AI / Automation Control APIs ---

    if (sub === '/screen-info' && req.method === 'GET') {
      const rt = await requireRunningAdb(phoneId, { wake: false });
      const info = await rt.adb.getScreenInfo();
      return sendJson(res, 200, { ...info, phone: phones.getPhoneSummary(phoneId) });
    }

    if (sub === '/screenshot' && req.method === 'GET') {
      const rt = await requireRunningAdb(phoneId);
      const png = await rt.adb.screenshot();
      if (url.searchParams.get('format') === 'base64') {
        const info = await rt.adb.getScreenInfo().catch(() => ({ width: 720, height: 1600 }));
        return sendJson(res, 200, {
          mime: 'image/png',
          width: info.width,
          height: info.height,
          base64: png.toString('base64'),
        });
      }
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Disposition': `attachment; filename="droidcloud-${phoneId}-${ts}.png"`,
        'Content-Length': png.length,
        'Cache-Control': 'no-store',
      });
      return res.end(png);
    }

    if (sub === '/ui-tree' && req.method === 'GET') {
      const rt = await requireRunningAdb(phoneId);
      const includeXml = url.searchParams.get('xml') === '1' || url.searchParams.get('xml') === 'true';
      const tree = await rt.adb.getUiTree({ includeXml });
      return sendJson(res, 200, tree);
    }

    if (sub === '/input/tap' && req.method === 'POST') {
      const rt = await requireRunningAdb(phoneId);
      const body = await readJsonBody(req);
      const pt = await resolveCoords(rt, body.x, body.y, Boolean(body.normalized));
      await rt.adb.inputTap(pt.x, pt.y);
      return sendJson(res, 200, { ok: true, x: pt.x, y: pt.y });
    }

    if (sub === '/input/long-press' && req.method === 'POST') {
      const rt = await requireRunningAdb(phoneId);
      const body = await readJsonBody(req);
      const pt = await resolveCoords(rt, body.x, body.y, Boolean(body.normalized));
      await rt.adb.inputLongPress(pt.x, pt.y, body.durationMs);
      return sendJson(res, 200, { ok: true, x: pt.x, y: pt.y });
    }

    if (sub === '/input/swipe' && req.method === 'POST') {
      const rt = await requireRunningAdb(phoneId);
      const body = await readJsonBody(req);
      const p1 = await resolveCoords(rt, body.x1, body.y1, Boolean(body.normalized));
      const p2 = await resolveCoords(rt, body.x2, body.y2, Boolean(body.normalized));
      await rt.adb.inputSwipe(p1.x, p1.y, p2.x, p2.y, body.durationMs);
      return sendJson(res, 200, { ok: true, from: p1, to: p2 });
    }

    if (sub === '/input/key' && req.method === 'POST') {
      const rt = await requireRunningAdb(phoneId);
      const body = await readJsonBody(req);
      await rt.adb.inputKey(body.key ?? body.keycode);
      return sendJson(res, 200, { ok: true });
    }

    if (sub === '/input/text' && req.method === 'POST') {
      const rt = await requireRunningAdb(phoneId);
      const body = await readJsonBody(req);
      const text = String(body.text || '');
      if (!text) return sendJson(res, 400, { error: 'text 不能为空' });

      if (/^[\x20-\x7e]+$/.test(text)) {
        if (rt.scrcpy?.isConnected) {
          rt.scrcpy.sendText(text);
        } else {
          await rt.adb.inputAsciiText(text);
        }
      } else {
        // Unicode / Chinese text via scrcpy clipboard-paste (auto-connects briefly if needed)
        const scrcpy = phones._ensureScrcpyStarted(phoneId);
        if (scrcpy && !scrcpy.isConnected) {
          await new Promise((r) => setTimeout(r, 1200));
        }
        if (scrcpy?.isConnected) {
          scrcpy.setClipboard(text, true);
        } else {
          throw Object.assign(new Error('输入中文需等待 scrcpy 控制通道就绪，请重试'), { statusCode: 503 });
        }
      }

      if (body.enter) {
        await new Promise((r) => setTimeout(r, 120));
        await rt.adb.inputKey('enter');
      }
      return sendJson(res, 200, { ok: true });
    }

    if (sub === '/shell' && req.method === 'POST') {
      const rt = await requireRunningAdb(phoneId, { wake: false });
      const body = await readJsonBody(req);
      const cmd = String(body.command || '').trim();
      if (!cmd) return sendJson(res, 400, { error: 'command 不能为空' });
      const timeout = Math.max(1000, Math.min(60000, Number(body.timeoutMs) || 15000));
      const stdout = await rt.adb.shell(cmd, { timeout });
      return sendJson(res, 200, { ok: true, stdout });
    }

    // --- Device Management & Files ---

    if (sub === '/apk/install' && req.method === 'POST') {
      const rt = await requireRunningAdb(phoneId, { wake: false });
      const rawName = decodeURIComponent(String(req.headers['x-filename'] || 'app.apk'));
      if (!rawName.toLowerCase().endsWith('.apk')) {
        return sendJson(res, 400, { error: '请上传 .apk 格式的安装包' });
      }
      const uploaded = await streamBodyToTempFile(req, 'apk');
      try {
        const result = await rt.adb.installApk(uploaded.tmpPath);
        return sendJson(res, 200, { ok: true, filename: rawName, result });
      } finally {
        await uploaded.cleanup();
      }
    }

    if (sub === '/apps' && req.method === 'GET') {
      const rt = await requireRunningAdb(phoneId, { wake: false });
      return sendJson(res, 200, await rt.adb.listApps());
    }

    if (sub === '/apps/launch' && req.method === 'POST') {
      const rt = await requireRunningAdb(phoneId);
      const body = await readJsonBody(req);
      await rt.adb.launchApp(body.packageName);
      return sendJson(res, 200, { ok: true });
    }

    if (sub === '/apps/uninstall' && req.method === 'POST') {
      const rt = await requireRunningAdb(phoneId, { wake: false });
      const body = await readJsonBody(req);
      const result = await rt.adb.uninstallApp(body.packageName);
      return sendJson(res, 200, { ok: true, result });
    }

    if (sub === '/files' && req.method === 'GET') {
      const rt = await requireRunningAdb(phoneId, { wake: false });
      const target = url.searchParams.get('path') || '/sdcard/Download';
      return sendJson(res, 200, await rt.adb.listFiles(target));
    }

    if (sub === '/files/upload' && req.method === 'POST') {
      const rt = await requireRunningAdb(phoneId, { wake: false });
      const targetDir = url.searchParams.get('path') || '/sdcard/Download';
      const rawName = decodeURIComponent(String(req.headers['x-filename'] || 'file.bin'));
      const uploaded = await streamBodyToTempFile(req, 'file');
      try {
        const remotePath = await rt.adb.pushFile(uploaded.tmpPath, targetDir, rawName);
        return sendJson(res, 200, { ok: true, remotePath, size: uploaded.size });
      } finally {
        await uploaded.cleanup();
      }
    }

    if (sub === '/files/download' && req.method === 'GET') {
      const rt = await requireRunningAdb(phoneId, { wake: false });
      const target = url.searchParams.get('path');
      if (!target) return sendJson(res, 400, { error: '缺少 path 参数' });
      const pulled = await rt.adb.pullToTempFile(target);
      const stat = await fs.promises.stat(pulled.tmpPath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(pulled.filename)}`,
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
      });
      const rs = fs.createReadStream(pulled.tmpPath);
      rs.on('close', () => pulled.cleanup());
      rs.on('error', () => pulled.cleanup());
      return rs.pipe(res);
    }

    if (sub === '/files' && req.method === 'DELETE') {
      const rt = await requireRunningAdb(phoneId, { wake: false });
      const target = url.searchParams.get('path');
      if (!target) return sendJson(res, 400, { error: '缺少 path 参数' });
      await rt.adb.deleteFile(target);
      return sendJson(res, 200, { ok: true });
    }

    if (sub === '/location' && req.method === 'POST') {
      const rt = await requireRunningAdb(phoneId, { wake: false });
      const body = await readJsonBody(req);
      await rt.adb.setLocation(body.lon, body.lat);
      return sendJson(res, 200, { ok: true });
    }

    if (sub === '/reconnect-stream' && req.method === 'POST') {
      const rt = await requireRunningAdb(phoneId);
      const scrcpy = phones._ensureScrcpyStarted(phoneId);
      if (scrcpy) await scrcpy.restart();
      return sendJson(res, 200, { ok: true });
    }

    if (sub === '/diagnose' && req.method === 'POST') {
      const result = await phones.diagnosePhone(phoneId);
      return sendJson(res, 200, result);
    }

    if (sub === '/fix-google' && req.method === 'POST') {
      const result = await phones.fixGoogleServices(phoneId);
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { error: 'API 路径不存在' });
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }

    let relPath = pathname === '/' ? '/index.html' : pathname;
    try {
      relPath = decodeURIComponent(relPath);
    } catch {
      res.writeHead(400);
      return res.end();
    }

    const fullPath = path.resolve(WEB_DIR, `.${relPath}`);
    if (!fullPath.startsWith(WEB_DIR)) {
      res.writeHead(403);
      return res.end();
    }

    fs.stat(fullPath, (err, stat) => {
      if (err || !stat.isFile()) {
        const indexHtml = path.join(WEB_DIR, 'index.html');
        fs.readFile(indexHtml, (e2, data) => {
          if (e2) {
            res.writeHead(404);
            return res.end('Not Found');
          }
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Content-Length': data.length,
          });
          res.end(req.method === 'HEAD' ? undefined : data);
        });
        return;
      }

      const ext = path.extname(fullPath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(fullPath).pipe(res);
    });
  }

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err.message || 'Internal Server Error' });
      }
    });
  });

  wss.attach(httpServer);

  let metricsTimer = null;

  function startBackgroundLoops() {
    phones.startBackgroundWatchers();
    metricsTimer = setInterval(async () => {
      if (wss.clients.size === 0) return;
      try {
        const m = await collectSystemMetrics();
        wss.broadcastJson({ type: 'metrics', ...m });
      } catch {
        // ignore
      }
    }, 3000);
    metricsTimer.unref?.();

    const autoStart = String(process.env.AUTO_START_PHONE || '').trim();
    if (autoStart) {
      const list = phones.listPhones();
      const target = autoStart === 'first' ? list[0] : list.find((p) => p.id === autoStart);
      if (target) {
        phones.startPhone(target.id).catch(() => {});
      }
    }
  }

  return {
    httpServer,
    wss,
    auth,
    phones,
    listen() {
      return new Promise((resolve) => {
        httpServer.listen(port, host, () => {
          if (enableBackgroundLoops) {
            startBackgroundLoops();
          }
          resolve(httpServer.address());
        });
      });
    },
    async close() {
      clearInterval(metricsTimer);
      await phones.stopAll();
      wss.closeAll();
      await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const srv = createDroidCloudServer();
  srv.listen().then((addr) => {
    const port = typeof addr === 'object' && addr ? addr.port : process.env.PORT || 6080;
    console.log(`[droidcloud] 多机云手机控制台已启动: http://0.0.0.0:${port}`);
    console.log('[droidcloud] 默认按需开机模式：所有云手机初始关机（零 CPU/内存占用），登录网页或调用 API 按需开启');
    if (srv.auth.generated) {
      console.log('============================================================');
      console.log(`[droidcloud] 未设置 ACCESS_PASSWORD，已自动生成访问密码:`);
      console.log(`[droidcloud] 密码: ${srv.auth.password}`);
      console.log('============================================================');
    }
  });

  const shutdown = async () => {
    console.log('[droidcloud] 正在安全关闭所有运行中的云手机…');
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => {
    console.error('[droidcloud] uncaughtException:', err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[droidcloud] unhandledRejection:', err);
  });
}
