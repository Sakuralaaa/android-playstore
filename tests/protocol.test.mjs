import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { AuthManager } from '../server/auth.mjs';
import { sanitizeSdcardPath, validatePackageName } from '../server/adb.mjs';
import { localeForCountry, resolvePhoneLocale } from '../server/geo.mjs';
import {
  ScrcpyVideoParser,
  ScrcpyDeviceMessageParser,
  encodeInjectKeycode,
  encodeInjectText,
  encodeInjectTouch,
  encodeInjectScroll,
  encodeSetClipboard,
  packWsVideoFrame,
  CONTROL_MSG,
  WS_FRAME_TYPE,
  PACKET_FLAG_SESSION_HI,
  PACKET_FLAG_CONFIG_HI,
  PACKET_FLAG_KEYFRAME_HI,
} from '../server/scrcpy.mjs';
import { createDroidCloudServer } from '../server/index.mjs';
import { splitAnnexBNals, extractSpsPps, buildAvcCodecString } from '../web/js/decoder.js';

test('AuthManager verifies password, signs session token, and enforces rate limit', () => {
  const auth = new AuthManager({ password: 'SuperSecretPassword!2026' });
  assert.equal(auth.generated, false);
  assert.equal(auth.verifyPassword('SuperSecretPassword!2026'), true);
  assert.equal(auth.verifyPassword('wrong-password'), false);
  assert.equal(auth.verifyPassword(''), false);

  const token = auth.createToken();
  assert.equal(auth.verifyToken(token), true);
  assert.equal(auth.verifyToken(`${token}tampered`), false);
  assert.equal(auth.verifyToken('invalid'), false);

  const ip = '203.0.113.10';
  for (let i = 0; i < 10; i++) {
    assert.equal(auth.checkRateLimit(ip).allowed, true);
    auth.recordFailure(ip);
  }
  const blocked = auth.checkRateLimit(ip);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec > 0);

  auth.clearFailures(ip);
  assert.equal(auth.checkRateLimit(ip).allowed, true);
});

test('IP geo locale resolver defaults to zh-CN and supports auto_ip country mapping', () => {
  assert.equal(localeForCountry('US'), 'en-US');
  assert.equal(localeForCountry('JP'), 'ja-JP');
  assert.equal(localeForCountry('ES'), 'es-ES');
  assert.equal(localeForCountry('ZZ'), 'en-US');

  assert.equal(resolvePhoneLocale({ localeMode: 'zh-CN' }, { countryCode: 'ES', suggestedLocale: 'es-ES' }), 'zh-CN');
  assert.equal(resolvePhoneLocale({ localeMode: 'auto_ip' }, { countryCode: 'JP', suggestedLocale: 'ja-JP' }), 'ja-JP');
  assert.equal(resolvePhoneLocale({ localeMode: 'en-US' }, { countryCode: 'CN', suggestedLocale: 'zh-CN' }), 'en-US');
});

test('ADB path & package validators block traversal and injection', () => {
  assert.equal(sanitizeSdcardPath('/sdcard/Download/photo.jpg'), '/sdcard/Download/photo.jpg');
  assert.equal(sanitizeSdcardPath('DCIM/Camera'), '/sdcard/DCIM/Camera');
  assert.throws(() => sanitizeSdcardPath('/etc/passwd'));
  assert.throws(() => sanitizeSdcardPath('/sdcard/../../etc/shadow'));

  assert.equal(validatePackageName('com.android.vending'), 'com.android.vending');
  assert.throws(() => validatePackageName('com.foo; rm -rf /'));
  assert.throws(() => validatePackageName('../bad'));
});

test('scrcpy v5.0.1 control encoders produce exact wire bytes', () => {
  const keyBuf = encodeInjectKeycode(0, 66, 0, 0x1);
  assert.equal(keyBuf.length, 14);
  assert.equal(keyBuf.readUInt8(0), CONTROL_MSG.INJECT_KEYCODE);
  assert.equal(keyBuf.readInt32BE(2), 66);

  const textBuf = encodeInjectText('hello');
  assert.equal(textBuf.length, 10);
  assert.equal(textBuf.subarray(5).toString('utf8'), 'hello');

  const touchBuf = encodeInjectTouch({
    action: 0,
    pointerId: 1n,
    x: 360,
    y: 800,
    screenWidth: 720,
    screenHeight: 1600,
    pressure: 1.0,
  });
  assert.equal(touchBuf.length, 32);
  assert.equal(touchBuf.readBigInt64BE(2), 1n);
  assert.equal(touchBuf.readUInt16BE(22), 0xffff);

  const scrollBuf = encodeInjectScroll({
    x: 360,
    y: 800,
    screenWidth: 720,
    screenHeight: 1600,
    hScroll: 0,
    vScroll: 8,
  });
  assert.equal(scrollBuf.length, 21);
  assert.equal(scrollBuf.readInt16BE(15), 16384);

  const clipBuf = encodeSetClipboard('你好世界', true, 42n);
  assert.equal(clipBuf.readBigInt64BE(1), 42n);
  assert.equal(clipBuf.readUInt8(9), 1);
  assert.equal(clipBuf.subarray(14).toString('utf8'), '你好世界');
});

test('ScrcpyVideoParser & ScrcpyDeviceMessageParser handle v5.0.1 streams', () => {
  const parser = new ScrcpyVideoParser();
  const events = [];
  parser.on('dummy', () => events.push({ kind: 'dummy' }));
  parser.on('codec', (c) => events.push({ kind: 'codec', ...c }));
  parser.on('session', (s) => events.push({ kind: 'session', ...s }));
  parser.on('packet', (p) => events.push({ kind: 'packet', ...p }));

  const dummy = Buffer.from([0x00]);
  const devName = Buffer.alloc(64);
  devName.write('Pixel 8 Cloud', 'utf8');
  const codecHdr = Buffer.from('h264', 'ascii');

  const sessionHdr = Buffer.alloc(12);
  sessionHdr.writeUInt32BE(PACKET_FLAG_SESSION_HI, 0);
  sessionHdr.writeUInt32BE(720, 4);
  sessionHdr.writeUInt32BE(1600, 8);

  const spsPps = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x28, 0, 0, 0, 1, 0x68, 0xce, 0x38, 0x80]);
  const cfgHdr = Buffer.alloc(12);
  cfgHdr.writeUInt32BE(PACKET_FLAG_CONFIG_HI, 0);
  cfgHdr.writeUInt32BE(0, 4);
  cfgHdr.writeUInt32BE(spsPps.length, 8);

  const idrPayload = Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00]);
  const idrHdr = Buffer.alloc(12);
  idrHdr.writeUInt32BE(PACKET_FLAG_KEYFRAME_HI, 0);
  idrHdr.writeUInt32BE(123456, 4);
  idrHdr.writeUInt32BE(idrPayload.length, 8);

  const full = Buffer.concat([dummy, devName, codecHdr, sessionHdr, cfgHdr, spsPps, idrHdr, idrPayload]);
  for (let i = 0; i < full.length; i += 7) {
    parser.push(full.subarray(i, Math.min(full.length, i + 7)));
  }

  assert.equal(events.length, 5);
  assert.equal(events[2].width, 720);
  assert.equal(events[3].isConfig, true);
  assert.equal(events[4].isKeyFrame, true);
  assert.equal(packWsVideoFrame(events[3])[0], WS_FRAME_TYPE.CONFIG);
  assert.equal(packWsVideoFrame(events[4])[0], WS_FRAME_TYPE.KEYFRAME);

  const { sps, pps } = extractSpsPps(new Uint8Array(spsPps));
  assert.ok(sps && pps);
  assert.equal(buildAvcCodecString(sps), 'avc1.42c028');
  assert.equal(splitAnnexBNals(new Uint8Array(spsPps)).length, 2);

  const devParser = new ScrcpyDeviceMessageParser();
  const clips = [];
  devParser.on('clipboard', (t) => clips.push(t));
  const msgText = Buffer.from('验证码 839201', 'utf8');
  const frame = Buffer.alloc(5 + msgText.length);
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(msgText.length, 1);
  msgText.copy(frame, 5);
  devParser.push(frame);
  assert.deepEqual(clips, ['验证码 839201']);
});

test('End-to-end Multi-Phone Fleet CRUD + Auth + WebSocket overview', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'droidcloud-fleet-'));
  const srv = createDroidCloudServer({
    port: 0,
    host: '127.0.0.1',
    password: 'test-pass-123',
    persistDir: tmpDir,
    avdHome: tmpDir,
    sdkRoot: path.join(tmpDir, 'sdk'),
    enableBackgroundLoops: false,
    geoDetector: async () => ({
      ip: '1.2.3.4',
      countryCode: 'US',
      country: 'United States',
      city: 'Los Angeles',
      timezone: 'America/Los_Angeles',
      lat: 34.0522,
      lon: -118.2437,
      isp: 'Test ISP',
      suggestedLocale: 'en-US',
    }),
  });

  const addr = await srv.listen();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Health check shows 1 default stopped phone (zero idle boot)
    const health = await (await fetch(`${baseUrl}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.totalPhones, 1);
    assert.equal(health.runningPhones, 0);

    // 2. Unauthenticated blocked
    assert.equal((await fetch(`${baseUrl}/api/phones`)).status, 401);

    // 3. Login
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-pass-123' }),
    });
    assert.equal(login.status, 200);
    const cookieHeader = login.headers.get('set-cookie').split(';')[0];

    // 4. Create second phone (Android 15, Pixel 9, auto_ip language, 15m idle stop)
    const createRes = await fetch(`${baseUrl}/api/phones`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '美区注册机',
        androidVersion: '15',
        device: 'pixel_9',
        screenPreset: 'smooth',
        localeMode: 'auto_ip',
        autoIpEnv: true,
        idleStopMinutes: 15,
      }),
    });
    assert.equal(createRes.status, 201);
    const { phone: created } = await createRes.json();
    assert.equal(created.name, '美区注册机');
    assert.equal(created.androidVersion, '15');
    assert.equal(created.device, 'pixel_9');
    assert.equal(created.status, 'stopped');

    // 5. Update phone config
    const patchRes = await fetch(`${baseUrl}/api/phones/${created.id}`, {
      method: 'PATCH',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '美区主力机', localeMode: 'zh-CN' }),
    });
    assert.equal(patchRes.status, 200);
    const { phone: patched } = await patchRes.json();
    assert.equal(patched.name, '美区主力机');
    assert.equal(patched.localeMode, 'zh-CN');

    // 6. Sync IP geo via mock detector
    const syncRes = await fetch(`${baseUrl}/api/phones/${created.id}/sync-ip`, {
      method: 'POST',
      headers: { Cookie: cookieHeader },
    });
    assert.equal(syncRes.status, 200);
    const syncJson = await syncRes.json();
    assert.equal(syncJson.geo.timezone, 'America/Los_Angeles');

    // 7. List phones shows 2 phones
    const listData = await (await fetch(`${baseUrl}/api/phones`, { headers: { Cookie: cookieHeader } })).json();
    assert.equal(listData.phones.length, 2);

    // 8. WebSocket upgrade receives fleet list
    const wsKey = crypto.randomBytes(16).toString('base64');
    const wsData = await new Promise((resolve, reject) => {
      const chunks = [];
      const sock = net.createConnection({ host: '127.0.0.1', port: addr.port }, () => {
        sock.write(
          `GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${cookieHeader}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      sock.on('data', (d) => {
        chunks.push(d);
        const combined = Buffer.concat(chunks);
        const hdrEnd = combined.indexOf('\r\n\r\n');
        if (hdrEnd !== -1 && combined.length > hdrEnd + 10) {
          sock.destroy();
          resolve(combined.toString('utf8'));
        }
      });
      sock.on('error', reject);
      setTimeout(() => { sock.destroy(); reject(new Error('WS timeout')); }, 3000);
    });
    assert.ok(wsData.startsWith('HTTP/1.1 101'));
    assert.ok(wsData.includes('"type":"phones"'));

    // 9. Delete second phone
    const delRes = await fetch(`${baseUrl}/api/phones/${created.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookieHeader },
    });
    assert.equal(delRes.status, 200);
    const listAfter = await (await fetch(`${baseUrl}/api/phones`, { headers: { Cookie: cookieHeader } })).json();
    assert.equal(listAfter.phones.length, 1);
  } finally {
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
