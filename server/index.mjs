import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuthManager, getClientIp } from './auth.mjs';
import { AdbClient } from './adb.mjs';
import { WebSocketServer } from './ws.mjs';
import { BootStatusTracker } from './status.mjs';
import { ScrcpyManager, QUALITY_PRESETS } from './scrcpy.mjs';
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
  const adb = options.adb ?? new AdbClient();
  const status = options.status ?? new BootStatusTracker();
  const scrcpy = options.scrcpy ?? new ScrcpyManager({ adb });
  const enableBackgroundLoops = options.enableBackgroundLoops ?? true;

  const wss = new WebSocketServer({
    path: '/ws',
    verifyClient: (req) => auth.isAuthenticated(req),
  });

  // Wire scrcpy events to WebSocket clients
  scrcpy.on('meta', (meta) => {
    wss.broadcastJson({ type: 'video_meta', ...meta });
  });

  scrcpy.on('frame', ({ frame, isConfig, isKeyFrame }) => {
    wss.broadcastBinary(frame, { droppable: !isConfig && !isKeyFrame });
  });

  scrcpy.on('clipboard', (text) => {
    wss.broadcastJson({ type: 'clipboard', text });
  });

  scrcpy.on('log', (line) => {
    status.appendLog(line);
  });

  status.on('status', (st) => {
    wss.broadcastJson({ type: 'status', ...st, streamConnected: scrcpy.isConnected });
    if (st.ready && !scrcpy.isConnected && enableBackgroundLoops) {
      scrcpy.start();
    }
  });

  status.on('log', (line) => {
    wss.broadcastJson({ type: 'log', line });
  });

  wss.on('connection', (client) => {
    // Immediately send current status & recent logs
    client.sendJson({
      type: 'status',
      ...status.getSnapshot(),
      streamConnected: scrcpy.isConnected,
      presets: QUALITY_PRESETS,
      preset: scrcpy.preset,
    });

    if (scrcpy.isConnected && scrcpy.meta.width > 0) {
      client.sendJson({ type: 'video_meta', ...scrcpy.meta });
      if (scrcpy.lastConfigFrame) {
        client.sendBinary(scrcpy.lastConfigFrame);
      }
      if (scrcpy.lastKeyFrame) {
        client.sendBinary(scrcpy.lastKeyFrame);
      }
      // Ask scrcpy-server for a fresh IDR keyframe so new viewer starts smoothly
      scrcpy.requestKeyFrame();
    } else if (status.state.ready && enableBackgroundLoops) {
      scrcpy.start();
    }

    client.on('message', (data, isBinary) => {
      if (isBinary) {
        handleBinaryControl(data);
      } else {
        handleJsonControl(client, data);
      }
    });
  });

  function handleBinaryControl(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 2) return;
    const type = buf[0];
    // Compact browser->server binary control packets:
    // 0x10 = touch: [u8 0x10, u8 action, i32 pointerId, f32 normX, f32 normY, f32 pressure] (18 bytes)
    if (type === 0x10 && buf.length >= 18) {
      const action = buf.readUInt8(1);
      const pointerId = BigInt(buf.readInt32BE(2));
      const normX = buf.readFloatBE(6);
      const normY = buf.readFloatBE(10);
      const pressure = buf.readFloatBE(14);
      const w = scrcpy.meta.width || 720;
      const h = scrcpy.meta.height || 1600;
      const x = Math.max(0, Math.min(w - 1, Math.round(normX * w)));
      const y = Math.max(0, Math.min(h - 1, Math.round(normY * h)));
      scrcpy.sendTouch({
        action,
        pointerId,
        x,
        y,
        screenWidth: w,
        screenHeight: h,
        pressure,
      });
      return;
    }

    // 0x11 = scroll: [u8 0x11, f32 normX, f32 normY, f32 hScroll, f32 vScroll] (17 bytes)
    if (type === 0x11 && buf.length >= 17) {
      const normX = buf.readFloatBE(1);
      const normY = buf.readFloatBE(5);
      const hScroll = buf.readFloatBE(9);
      const vScroll = buf.readFloatBE(13);
      const w = scrcpy.meta.width || 720;
      const h = scrcpy.meta.height || 1600;
      const x = Math.max(0, Math.min(w - 1, Math.round(normX * w)));
      const y = Math.max(0, Math.min(h - 1, Math.round(normY * h)));
      scrcpy.sendScroll({
        x,
        y,
        screenWidth: w,
        screenHeight: h,
        hScroll,
        vScroll,
      });
    }
  }

  async function handleJsonControl(client, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

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
          wss.broadcastJson({
            type: 'toast',
            level: 'success',
            message: `画质已切换为 ${QUALITY_PRESETS[msg.preset].label}`,
          });
        } catch (err) {
          client.sendJson({ type: 'toast', level: 'error', message: err.message });
        }
        break;
      case 'ping':
        client.sendJson({ type: 'pong', ts: msg.ts });
        break;
      default:
        break;
    }
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');

    // Public health check
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        stage: status.state.stage,
        ready: status.state.ready,
        streamConnected: scrcpy.isConnected,
      });
    }

    // Auth endpoints
    if (pathname === '/api/auth/status' && req.method === 'GET') {
      return sendJson(res, 200, {
        authenticated: auth.isAuthenticated(req),
        androidVersion: status.state.androidVersion,
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
      return sendJson(
        res,
        200,
        { ok: true },
        { 'Set-Cookie': auth.buildLogoutCookie(req) }
      );
    }

    // Protected API routes
    if (pathname.startsWith('/api/')) {
      if (!auth.isAuthenticated(req)) {
        return sendJson(res, 401, { error: '未登录或会话已过期' });
      }
      return handleProtectedApi(req, res, url);
    }

    // Static frontend assets
    return serveStatic(req, res, pathname);
  }

  async function handleProtectedApi(req, res, url) {
    const pathname = url.pathname;
    try {
      if (pathname === '/api/status' && req.method === 'GET') {
        const [metrics, deviceInfo] = await Promise.all([
          collectSystemMetrics(),
          status.state.ready ? adb.getDeviceInfo() : Promise.resolve(null),
        ]);
        return sendJson(res, 200, {
          ...status.getSnapshot(),
          streamConnected: scrcpy.isConnected,
          videoMeta: scrcpy.meta,
          preset: scrcpy.preset,
          presets: QUALITY_PRESETS,
          metrics: {
            ...metrics,
            clients: wss.clients.size,
            streamBitrateKbps: scrcpy.bitrateKbps,
          },
          deviceInfo,
        });
      }

      if (pathname === '/api/screenshot' && req.method === 'GET') {
        const png = await adb.screenshot();
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Disposition': `attachment; filename="droidcloud-${ts}.png"`,
          'Content-Length': png.length,
          'Cache-Control': 'no-store',
        });
        return res.end(png);
      }

      if (pathname === '/api/apk/install' && req.method === 'POST') {
        const rawName = decodeURIComponent(String(req.headers['x-filename'] || 'app.apk'));
        if (!rawName.toLowerCase().endsWith('.apk')) {
          return sendJson(res, 400, { error: '请上传 .apk 格式的安装包' });
        }
        const uploaded = await streamBodyToTempFile(req, 'apk');
        try {
          const result = await adb.installApk(uploaded.tmpPath);
          return sendJson(res, 200, { ok: true, filename: rawName, result });
        } finally {
          await uploaded.cleanup();
        }
      }

      if (pathname === '/api/apps' && req.method === 'GET') {
        const apps = await adb.listApps();
        return sendJson(res, 200, apps);
      }

      if (pathname === '/api/apps/launch' && req.method === 'POST') {
        const body = await readJsonBody(req);
        await adb.launchApp(body.packageName);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/apps/uninstall' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = await adb.uninstallApp(body.packageName);
        return sendJson(res, 200, { ok: true, result });
      }

      if (pathname === '/api/files' && req.method === 'GET') {
        const target = url.searchParams.get('path') || '/sdcard/Download';
        const listing = await adb.listFiles(target);
        return sendJson(res, 200, listing);
      }

      if (pathname === '/api/files/upload' && req.method === 'POST') {
        const targetDir = url.searchParams.get('path') || '/sdcard/Download';
        const rawName = decodeURIComponent(String(req.headers['x-filename'] || 'file.bin'));
        const uploaded = await streamBodyToTempFile(req, 'file');
        try {
          const remotePath = await adb.pushFile(uploaded.tmpPath, targetDir, rawName);
          return sendJson(res, 200, { ok: true, remotePath, size: uploaded.size });
        } finally {
          await uploaded.cleanup();
        }
      }

      if (pathname === '/api/files/download' && req.method === 'GET') {
        const target = url.searchParams.get('path');
        if (!target) return sendJson(res, 400, { error: '缺少 path 参数' });
        const pulled = await adb.pullToTempFile(target);
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

      if (pathname === '/api/files' && req.method === 'DELETE') {
        const target = url.searchParams.get('path');
        if (!target) return sendJson(res, 400, { error: '缺少 path 参数' });
        await adb.deleteFile(target);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/device/location' && req.method === 'POST') {
        const body = await readJsonBody(req);
        await adb.setLocation(body.lon, body.lat);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/device/reconnect-stream' && req.method === 'POST') {
        await scrcpy.restart();
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/device/reboot' && req.method === 'POST') {
        await adb.shell('svc power reboot', { timeout: 5000 }).catch(() => {});
        status.setState({
          stage: 'booting',
          progress: 65,
          message: '正在重启 Android 系统…',
          ready: false,
        });
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { error: 'API 路径不存在' });
    } catch (err) {
      return sendJson(res, err.statusCode || 500, { error: err.message || '服务器内部错误' });
    }
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
        // SPA fallback to index.html for unknown non-asset paths
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
  let healthPollTimer = null;

  function startBackgroundLoops() {
    status.start();

    metricsTimer = setInterval(async () => {
      if (wss.clients.size === 0) return;
      try {
        const m = await collectSystemMetrics();
        wss.broadcastJson({
          type: 'metrics',
          ...m,
          clients: wss.clients.size,
          streamBitrateKbps: scrcpy.bitrateKbps,
        });
      } catch {
        // ignore
      }
    }, 3000);
    metricsTimer.unref?.();

    // Watch ADB boot readiness & keep scrcpy running whenever device is ready
    healthPollTimer = setInterval(async () => {
      if (!status.state.ready) {
        const bootOk = await adb.isDeviceReady();
        if (bootOk && status.state.stage === 'booting') {
          status.setState({
            stage: 'ready',
            progress: 100,
            message: 'Android 已就绪',
            ready: true,
          });
        }
      } else if (!scrcpy.isConnected) {
        scrcpy.start();
      }
    }, 3000);
    healthPollTimer.unref?.();
  }

  return {
    httpServer,
    wss,
    auth,
    adb,
    status,
    scrcpy,
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
      clearInterval(healthPollTimer);
      status.stop();
      scrcpy.stop();
      wss.closeAll();
      await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}

// Run directly when executed as main module
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const srv = createDroidCloudServer();
  srv.listen().then((addr) => {
    const port = typeof addr === 'object' && addr ? addr.port : process.env.PORT || 6080;
    console.log(`[droidcloud] Web 控制台已启动: http://0.0.0.0:${port}`);
    if (srv.auth.generated) {
      console.log('============================================================');
      console.log(`[droidcloud] 未设置 ACCESS_PASSWORD，已自动生成访问密码:`);
      console.log(`[droidcloud] 密码: ${srv.auth.password}`);
      console.log('============================================================');
    } else {
      console.log('[droidcloud] 已启用密码保护 (ACCESS_PASSWORD)');
    }
  });

  const shutdown = async () => {
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
