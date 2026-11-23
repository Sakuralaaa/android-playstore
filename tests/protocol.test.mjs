import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { AuthManager } from '../server/auth.mjs';
import { sanitizeSdcardPath, validatePackageName } from '../server/adb.mjs';
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

  // Rate limit kicks in after 10 failures
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
  assert.equal(keyBuf.readUInt8(1), 0);
  assert.equal(keyBuf.readInt32BE(2), 66);
  assert.equal(keyBuf.readInt32BE(10), 1);

  const textBuf = encodeInjectText('hello');
  assert.equal(textBuf.length, 10);
  assert.equal(textBuf.readUInt8(0), CONTROL_MSG.INJECT_TEXT);
  assert.equal(textBuf.readUInt32BE(1), 5);
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
  assert.equal(touchBuf.readUInt8(0), CONTROL_MSG.INJECT_TOUCH_EVENT);
  assert.equal(touchBuf.readBigInt64BE(2), 1n);
  assert.equal(touchBuf.readInt32BE(10), 360);
  assert.equal(touchBuf.readInt32BE(14), 800);
  assert.equal(touchBuf.readUInt16BE(18), 720);
  assert.equal(touchBuf.readUInt16BE(20), 1600);
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
  assert.equal(scrollBuf.readUInt8(0), CONTROL_MSG.INJECT_SCROLL_EVENT);
  assert.equal(scrollBuf.readInt16BE(15), 16384); // 8 / 16 * 32768

  const clipBuf = encodeSetClipboard('你好世界', true, 42n);
  assert.equal(clipBuf.readUInt8(0), CONTROL_MSG.SET_CLIPBOARD);
  assert.equal(clipBuf.readBigInt64BE(1), 42n);
  assert.equal(clipBuf.readUInt8(9), 1);
  assert.equal(clipBuf.readUInt32BE(10), Buffer.byteLength('你好世界'));
  assert.equal(clipBuf.subarray(14).toString('utf8'), '你好世界');
});

test('ScrcpyVideoParser parses v5.0.1 dummy, device meta, codec, session, config & frames', () => {
  const parser = new ScrcpyVideoParser();
  const events = [];
  parser.on('dummy', () => events.push({ kind: 'dummy' }));
  parser.on('codec', (c) => events.push({ kind: 'codec', ...c }));
  parser.on('session', (s) => events.push({ kind: 'session', ...s }));
  parser.on('packet', (p) => events.push({ kind: 'packet', ...p }));

  const dummy = Buffer.from([0x00]);
  const devName = Buffer.alloc(64);
  devName.write('Pixel 7 Cloud', 'utf8');
  const codecHdr = Buffer.from('h264', 'ascii');

  // Session meta header (bit 63 set): width=720, height=1600
  const sessionHdr = Buffer.alloc(12);
  sessionHdr.writeUInt32BE(PACKET_FLAG_SESSION_HI, 0);
  sessionHdr.writeUInt32BE(720, 4);
  sessionHdr.writeUInt32BE(1600, 8);

  // Config packet (bit 62 set): SPS + PPS
  const spsPps = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x28, 0, 0, 0, 1, 0x68, 0xce, 0x38, 0x80]);
  const cfgHdr = Buffer.alloc(12);
  cfgHdr.writeUInt32BE(PACKET_FLAG_CONFIG_HI, 0);
  cfgHdr.writeUInt32BE(0, 4);
  cfgHdr.writeUInt32BE(spsPps.length, 8);

  // Keyframe packet (bit 61 set): PTS=123456
  const idrPayload = Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00]);
  const idrHdr = Buffer.alloc(12);
  idrHdr.writeUInt32BE(PACKET_FLAG_KEYFRAME_HI, 0);
  idrHdr.writeUInt32BE(123456, 4);
  idrHdr.writeUInt32BE(idrPayload.length, 8);

  // Feed in tiny fragmented slices to test TCP chunk reassembly
  const full = Buffer.concat([dummy, devName, codecHdr, sessionHdr, cfgHdr, spsPps, idrHdr, idrPayload]);
  for (let i = 0; i < full.length; i += 7) {
    parser.push(full.subarray(i, Math.min(full.length, i + 7)));
  }

  assert.equal(events.length, 5);
  assert.equal(events[0].kind, 'dummy');
  assert.equal(events[1].deviceName, 'Pixel 7 Cloud');
  assert.equal(events[2].width, 720);
  assert.equal(events[2].height, 1600);
  assert.equal(events[3].isConfig, true);
  assert.deepEqual(events[3].data, spsPps);
  assert.equal(events[4].isKeyFrame, true);
  assert.equal(events[4].pts, 123456n);

  const wsCfg = packWsVideoFrame(events[3]);
  assert.equal(wsCfg[0], WS_FRAME_TYPE.CONFIG);
  const wsIdr = packWsVideoFrame(events[4]);
  assert.equal(wsIdr[0], WS_FRAME_TYPE.KEYFRAME);
  assert.equal(wsIdr.readBigUInt64BE(1), 123456n);

  // Verify frontend Annex-B SPS/PPS parser against the same bytes
  const nals = splitAnnexBNals(new Uint8Array(spsPps));
  assert.equal(nals.length, 2);
  const { sps, pps } = extractSpsPps(new Uint8Array(spsPps));
  assert.ok(sps && pps);
  assert.equal(buildAvcCodecString(sps), 'avc1.42c028');
});

test('ScrcpyDeviceMessageParser decodes device clipboard UTF-8', () => {
  const parser = new ScrcpyDeviceMessageParser();
  const clips = [];
  parser.on('clipboard', (t) => clips.push(t));

  const msgText = Buffer.from('验证码 839201', 'utf8');
  const frame = Buffer.alloc(5 + msgText.length);
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(msgText.length, 1);
  msgText.copy(frame, 5);

  parser.push(frame.subarray(0, 4));
  parser.push(frame.subarray(4));
  assert.deepEqual(clips, ['验证码 839201']);
});

test('End-to-end HTTP Auth + Protected API + RFC6455 WebSocket handshake', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'droidcloud-test-'));
  const srv = createDroidCloudServer({
    port: 0,
    host: '127.0.0.1',
    password: 'test-pass-123',
    persistDir: tmpDir,
    enableBackgroundLoops: false,
  });

  const addr = await srv.listen();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Health endpoint is public
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    // 2. Protected API returns 401 when unauthenticated
    const unauth = await fetch(`${baseUrl}/api/status`);
    assert.equal(unauth.status, 401);

    // 3. Wrong password returns 401
    const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(badLogin.status, 401);

    // 4. Correct password issues HttpOnly session cookie
    const goodLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-pass-123' }),
    });
    assert.equal(goodLogin.status, 200);
    const setCookie = goodLogin.headers.get('set-cookie');
    assert.ok(setCookie && setCookie.includes('droidcloud_session='));
    const cookieHeader = setCookie.split(';')[0];

    // 5. Protected API succeeds with cookie
    const statusRes = await fetch(`${baseUrl}/api/status`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.stage, 'init');

    // 6. WebSocket without cookie is rejected with 401
    const wsKey = crypto.randomBytes(16).toString('base64');
    const unauthWsResp = await new Promise((resolve) => {
      const sock = net.createConnection({ host: '127.0.0.1', port: addr.port }, () => {
        sock.write(
          `GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      sock.once('data', (d) => {
        sock.destroy();
        resolve(d.toString('utf8'));
      });
    });
    assert.ok(unauthWsResp.startsWith('HTTP/1.1 401'));

    // 7. WebSocket with valid session cookie upgrades to 101 and receives initial status frame
    const authWsData = await new Promise((resolve, reject) => {
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
        if (hdrEnd !== -1 && combined.length > hdrEnd + 6) {
          sock.destroy();
          resolve(combined);
        }
      });
      sock.on('error', reject);
      setTimeout(() => {
        sock.destroy();
        reject(new Error('WS timeout'));
      }, 3000);
    });
    const hdrText = authWsData.toString('utf8');
    assert.ok(hdrText.startsWith('HTTP/1.1 101'));
    assert.ok(hdrText.includes('"type":"status"'));
  } finally {
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
