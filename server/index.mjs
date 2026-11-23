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

export function createDroidCloudServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 6080);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  const auth = options.auth ?? new AuthManager({ password: options.password, persistDir: options.persistDir });
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

  // Track which phoneId each WebSocket client is watching (null = dashboard overview)
  const clientScope = new Map(); // wsClient -> phoneId | null

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

  // Wire PhoneManager events -> WebSockets
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

    // Send fleet overview immediately
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

  function requireRunningAdb(phoneId) {
    const rt = phones.getRuntime(phoneId);
    if (!rt) throw Object.assign(new Error('找不到指定的云手机'), { statusCode: 404 });
    if (rt.status !== 'running' || !rt.adb) {
      throw Object.assign(new Error('该云手机尚未开机就绪'), { statusCode: 409 });
    }
    return rt;
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
        return sendJson(res, 401, { error: '未登录或会话已过期' });
      }
      return handleProtectedApi(req, res, url);
    }

    return serveStatic(req, res, pathname);
  }

  async function handleProtectedApi(req, res, url) {
    const pathname = url.pathname;
    try {
      // Fleet & Catalog endpoints
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

      // Per-phone routes: /api/phones/:id[/action...]
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

    // Running-device ADB routes
    if (sub === '/screenshot' && req.method === 'GET') {
      const rt = requireRunningAdb(phoneId);
      const png = await rt.adb.screenshot();
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Disposition': `attachment; filename="droidcloud-${phoneId}-${ts}.png"`,
        'Content-Length': png.length,
        'Cache-Control': 'no-store',
      });
      return res.end(png);
    }

    if (sub === '/apk/install' && req.method === 'POST') {
      const rt = requireRunningAdb(phoneId);
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
      const rt = requireRunningAdb(phoneId);
      return sendJson(res, 200, await rt.adb.listApps());
    }

    if (sub === '/apps/launch' && req.method === 'POST') {
      const rt = requireRunningAdb(phoneId);
      const body = await readJsonBody(req);
      await rt.adb.launchApp(body.packageName);
      return sendJson(res, 200, { ok: true });
    }

    if (sub === '/apps/uninstall' && req.method === 'POST') {
      const rt = requireRunningAdb(phoneId);
      const body = await readJsonBody(req);
      const result = await rt.adb.uninstallApp(body.packageName);
      return sendJson(res, 200, { ok: true, result });
    }

    if (sub === '/files' && req.method === 'GET') {
      const rt = requireRunningAdb(phoneId);
      const target = url.searchParams.get('path') || '/sdcard/Download';
      return sendJson(res, 200, await rt.adb.listFiles(target));
    }

    if (sub === '/files/upload' && req.method === 'POST') {
      const rt = requireRunningAdb(phoneId);
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
      const rt = requireRunningAdb(phoneId);
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
      const rt = requireRunningAdb(phoneId);
      const target = url.searchParams.get('path');
      if (!target) return sendJson(res, 400, { error: '缺少 path 参数' });
      await rt.adb.deleteFile(target);
      return sendJson(res, 200, { ok: true });
    }

    if (sub === '/location' && req.method === 'POST') {
      const rt = requireRunningAdb(phoneId);
      const body = await readJsonBody(req);
      await rt.adb.setLocation(body.lon, body.lat);
      return sendJson(res, 200, { ok: true });
    }

    if (sub === '/reconnect-stream' && req.method === 'POST') {
      const rt = requireRunningAdb(phoneId);
      if (rt.scrcpy) await rt.scrcpy.restart();
      return sendJson(res, 200, { ok: true });
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

    // Optional: auto-start a specific phone if user explicitly sets AUTO_START_PHONE=<id|first>
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
    console.log('[droidcloud] 默认按需开机模式：所有云手机初始关机（零 CPU/内存占用），登录网页按需开启');
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
}
