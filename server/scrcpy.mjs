import crypto from 'node:crypto';
import net from 'node:net';
import { EventEmitter } from 'node:events';

// Exact wire constants verified against Genymobile/scrcpy v5.0.1
export const SCRCPY_VERSION = '5.0.1';

export const PACKET_FLAG_SESSION_HI = 0x80000000; // bit 63
export const PACKET_FLAG_CONFIG_HI = 0x40000000; // bit 62
export const PACKET_FLAG_KEYFRAME_HI = 0x20000000; // bit 61
export const PTS_HI_MASK = 0x1fffffff;

export const CONTROL_MSG = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  START_APP: 16,
  RESET_VIDEO: 17,
};

export const DEVICE_MSG = {
  CLIPBOARD: 0,
  ACK_CLIPBOARD: 1,
  UHID_OUTPUT: 2,
};

export const WS_FRAME_TYPE = {
  CONFIG: 0x01,
  KEYFRAME: 0x02,
  DELTA: 0x03,
};

export const QUALITY_PRESETS = {
  smooth: { label: '省流 (20 FPS)', maxSize: 720, maxFps: 20, bitRate: 1_500_000 },
  balanced: { label: '均衡 (30 FPS)', maxSize: 960, maxFps: 30, bitRate: 3_000_000 },
  ultra: { label: '高清 (60 FPS)', maxSize: 1280, maxFps: 60, bitRate: 6_000_000 },
};

// --- Exact scrcpy v5.0.1 control message encoders ---

export function encodeInjectKeycode(action, keycode, repeat = 0, metaState = 0) {
  const buf = Buffer.allocUnsafe(14);
  buf.writeUInt8(CONTROL_MSG.INJECT_KEYCODE, 0);
  buf.writeUInt8(action & 0xff, 1);
  buf.writeInt32BE(keycode | 0, 2);
  buf.writeInt32BE(repeat | 0, 6);
  buf.writeInt32BE(metaState | 0, 10);
  return buf;
}

export function encodeInjectText(text) {
  const textBuf = Buffer.from(String(text), 'utf8');
  const buf = Buffer.allocUnsafe(5 + textBuf.length);
  buf.writeUInt8(CONTROL_MSG.INJECT_TEXT, 0);
  buf.writeUInt32BE(textBuf.length, 1);
  textBuf.copy(buf, 5);
  return buf;
}

export function encodeInjectTouch({
  action,
  pointerId = 1n,
  x,
  y,
  screenWidth,
  screenHeight,
  pressure = 1.0,
  actionButton = 0,
  buttons = 0,
}) {
  const buf = Buffer.allocUnsafe(32);
  buf.writeUInt8(CONTROL_MSG.INJECT_TOUCH_EVENT, 0);
  buf.writeUInt8(action & 0xff, 1);
  buf.writeBigInt64BE(BigInt(pointerId), 2);
  buf.writeInt32BE(Math.round(x), 10);
  buf.writeInt32BE(Math.round(y), 14);
  buf.writeUInt16BE(Math.max(1, Math.min(65535, Math.round(screenWidth))), 18);
  buf.writeUInt16BE(Math.max(1, Math.min(65535, Math.round(screenHeight))), 20);
  const clampedP = Math.max(0, Math.min(1, Number(pressure)));
  const u16P = clampedP >= 1 ? 0xffff : Math.round(clampedP * 0x10000);
  buf.writeUInt16BE(u16P, 22);
  buf.writeInt32BE(actionButton | 0, 24);
  buf.writeInt32BE(buttons | 0, 28);
  return buf;
}

export function encodeInjectScroll({
  x,
  y,
  screenWidth,
  screenHeight,
  hScroll = 0,
  vScroll = 0,
  buttons = 0,
}) {
  // scrcpy v5.0.1 Binary.i16FixedPointToFloat(short) * 16 -> range [-16, 16]
  const toFixed16 = (v) => {
    const norm = Math.max(-1, Math.min(1, Number(v) / 16));
    if (norm >= 1) return 0x7fff;
    if (norm <= -1) return -0x8000;
    return Math.round(norm * 0x8000);
  };

  const buf = Buffer.allocUnsafe(21);
  buf.writeUInt8(CONTROL_MSG.INJECT_SCROLL_EVENT, 0);
  buf.writeInt32BE(Math.round(x), 1);
  buf.writeInt32BE(Math.round(y), 5);
  buf.writeUInt16BE(Math.max(1, Math.min(65535, Math.round(screenWidth))), 9);
  buf.writeUInt16BE(Math.max(1, Math.min(65535, Math.round(screenHeight))), 11);
  buf.writeInt16BE(toFixed16(hScroll), 13);
  buf.writeInt16BE(toFixed16(vScroll), 15);
  buf.writeInt32BE(buttons | 0, 17);
  return buf;
}

export function encodeBackOrScreenOn(action) {
  const buf = Buffer.allocUnsafe(2);
  buf.writeUInt8(CONTROL_MSG.BACK_OR_SCREEN_ON, 0);
  buf.writeUInt8(action & 0xff, 1);
  return buf;
}

export function encodeSetClipboard(text, paste = false, sequence = 1n) {
  const textBuf = Buffer.from(String(text), 'utf8');
  const buf = Buffer.allocUnsafe(14 + textBuf.length);
  buf.writeUInt8(CONTROL_MSG.SET_CLIPBOARD, 0);
  buf.writeBigInt64BE(BigInt(sequence), 1);
  buf.writeUInt8(paste ? 1 : 0, 9);
  buf.writeUInt32BE(textBuf.length, 10);
  textBuf.copy(buf, 14);
  return buf;
}

export function encodeSetDisplayPower(on) {
  const buf = Buffer.allocUnsafe(2);
  buf.writeUInt8(CONTROL_MSG.SET_DISPLAY_POWER, 0);
  buf.writeUInt8(on ? 1 : 0, 1);
  return buf;
}

export function encodeEmptyControl(type) {
  return Buffer.from([type & 0xff]);
}

export function encodeStartApp(name) {
  const raw = Buffer.from(String(name), 'utf8').subarray(0, 255);
  const buf = Buffer.allocUnsafe(2 + raw.length);
  buf.writeUInt8(CONTROL_MSG.START_APP, 0);
  buf.writeUInt8(raw.length, 1);
  raw.copy(buf, 2);
  return buf;
}

// --- Stateful scrcpy v5.0.1 video stream demuxer ---

export class ScrcpyVideoParser extends EventEmitter {
  constructor() {
    super();
    this.stage = 'dummy'; // dummy -> device_meta -> codec_header -> packet_header -> packet_body
    this.buf = Buffer.alloc(0);
    this.deviceName = '';
    this.codecId = 0;
    this.width = 0;
    this.height = 0;
    this._pendingPacket = null;
  }

  push(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);

    while (true) {
      if (this.stage === 'dummy') {
        if (this.buf.length < 1) return;
        this.buf = this.buf.subarray(1);
        this.stage = 'device_meta';
        this.emit('dummy');
        continue;
      }

      if (this.stage === 'device_meta') {
        if (this.buf.length < 64) return;
        const nameSlice = this.buf.subarray(0, 64);
        const zeroIdx = nameSlice.indexOf(0);
        this.deviceName = nameSlice
          .subarray(0, zeroIdx === -1 ? 64 : zeroIdx)
          .toString('utf8')
          .trim();
        this.buf = this.buf.subarray(64);
        this.stage = 'codec_header';
        continue;
      }

      if (this.stage === 'codec_header') {
        if (this.buf.length < 4) return;
        this.codecId = this.buf.readUInt32BE(0);
        this.buf = this.buf.subarray(4);
        this.stage = 'packet_header';
        this.emit('codec', { codecId: this.codecId, deviceName: this.deviceName });
        continue;
      }

      if (this.stage === 'packet_header') {
        if (this.buf.length < 12) return;
        const hi = this.buf.readUInt32BE(0);
        const lo = this.buf.readUInt32BE(4);
        const arg3 = this.buf.readUInt32BE(8);
        this.buf = this.buf.subarray(12);

        if ((hi & PACKET_FLAG_SESSION_HI) !== 0) {
          this.width = lo;
          this.height = arg3;
          this.emit('session', {
            width: this.width,
            height: this.height,
            deviceName: this.deviceName,
            isClientResize: (hi & 1) !== 0,
          });
          continue;
        }

        const isConfig = (hi & PACKET_FLAG_CONFIG_HI) !== 0;
        const isKeyFrame = !isConfig && (hi & PACKET_FLAG_KEYFRAME_HI) !== 0;
        const pts = isConfig
          ? 0n
          : (BigInt(hi & PTS_HI_MASK) << 32n) | BigInt(lo);
        const size = arg3;

        if (size === 0) continue;
        this._pendingPacket = { isConfig, isKeyFrame, pts, size };
        this.stage = 'packet_body';
        continue;
      }

      if (this.stage === 'packet_body') {
        const pkt = this._pendingPacket;
        if (this.buf.length < pkt.size) return;
        const payload = Buffer.from(this.buf.subarray(0, pkt.size));
        this.buf = this.buf.subarray(pkt.size);
        this._pendingPacket = null;
        this.stage = 'packet_header';
        this.emit('packet', {
          isConfig: pkt.isConfig,
          isKeyFrame: pkt.isKeyFrame,
          pts: pkt.pts,
          data: payload,
        });
      }
    }
  }
}

// --- Stateful scrcpy v5.0.1 device->client message parser ---

export class ScrcpyDeviceMessageParser extends EventEmitter {
  constructor() {
    super();
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);

    while (this.buf.length >= 1) {
      const type = this.buf[0];
      if (type === DEVICE_MSG.CLIPBOARD) {
        if (this.buf.length < 5) return;
        const len = this.buf.readUInt32BE(1);
        if (this.buf.length < 5 + len) return;
        const text = this.buf.subarray(5, 5 + len).toString('utf8');
        this.buf = this.buf.subarray(5 + len);
        this.emit('clipboard', text);
      } else if (type === DEVICE_MSG.ACK_CLIPBOARD) {
        if (this.buf.length < 9) return;
        const seq = this.buf.readBigInt64BE(1);
        this.buf = this.buf.subarray(9);
        this.emit('ack_clipboard', seq);
      } else if (type === DEVICE_MSG.UHID_OUTPUT) {
        if (this.buf.length < 5) return;
        const id = this.buf.readUInt16BE(1);
        const len = this.buf.readUInt16BE(3);
        if (this.buf.length < 5 + len) return;
        const data = Buffer.from(this.buf.subarray(5, 5 + len));
        this.buf = this.buf.subarray(5 + len);
        this.emit('uhid_output', { id, data });
      } else {
        // Unknown message type — drop buffer to avoid deadlock
        this.buf = Buffer.alloc(0);
        return;
      }
    }
  }
}

export function packWsVideoFrame(packet) {
  if (packet.isConfig) {
    const out = Buffer.allocUnsafe(1 + packet.data.length);
    out.writeUInt8(WS_FRAME_TYPE.CONFIG, 0);
    packet.data.copy(out, 1);
    return out;
  }
  const out = Buffer.allocUnsafe(9 + packet.data.length);
  out.writeUInt8(packet.isKeyFrame ? WS_FRAME_TYPE.KEYFRAME : WS_FRAME_TYPE.DELTA, 0);
  out.writeBigUInt64BE(packet.pts, 1);
  packet.data.copy(out, 9);
  return out;
}

// --- Full Scrcpy Session Manager ---

export class ScrcpyManager extends EventEmitter {
  constructor({
    adb,
    serverJarPath = process.env.SCRCPY_SERVER_PATH || '/opt/scrcpy/scrcpy-server',
    localPort = Number(process.env.SCRCPY_PORT || 27183),
    preset = process.env.STREAM_PRESET || 'balanced',
  } = {}) {
    super();
    this.adb = adb;
    this.serverJarPath = serverJarPath;
    this.localPort = localPort;
    this.preset = QUALITY_PRESETS[preset] ? preset : 'balanced';

    this._running = false;
    this._starting = false;
    this._stopped = false;
    this._proc = null;
    this._videoSock = null;
    this._controlSock = null;
    this._reconnectTimer = null;
    this._clipSeq = 1n;

    this.meta = { width: 0, height: 0, deviceName: '', codec: 'h264', preset: this.preset };
    this.lastConfigFrame = null;
    this.lastKeyFrame = null;
    this._bytesWindow = 0;
    this.bitrateKbps = 0;

    this._bitrateTimer = setInterval(() => {
      this.bitrateKbps = Math.round((this._bytesWindow * 8) / 1000 / 2);
      this._bytesWindow = 0;
    }, 2000);
    this._bitrateTimer.unref?.();
  }

  get isConnected() {
    return this._running && Boolean(this._videoSock && !this._videoSock.destroyed);
  }

  async start() {
    if (this._running || this._starting || this._stopped) return;
    this._starting = true;
    try {
      await this._launchSession();
    } catch (err) {
      this.emit('log', `[scrcpy] 启动失败: ${err.message}`);
      this._scheduleReconnect(2500);
    } finally {
      this._starting = false;
    }
  }

  async setQualityPreset(presetName) {
    if (!QUALITY_PRESETS[presetName]) {
      throw new Error(`无效画质档位: ${presetName}`);
    }
    this.preset = presetName;
    this.meta.preset = presetName;
    if (this._running || this._starting) {
      await this.restart();
    }
  }

  async restart() {
    this._cleanupSockets();
    this._killProc();
    this._running = false;
    await new Promise((r) => setTimeout(r, 350));
    if (!this._stopped) {
      await this.start();
    }
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._bitrateTimer);
    this._cleanupSockets();
    this._killProc();
    this._running = false;
  }

  requestKeyFrame() {
    this.sendControl(encodeEmptyControl(CONTROL_MSG.RESET_VIDEO));
  }

  sendControl(buf) {
    if (!this._controlSock || this._controlSock.destroyed) return false;
    try {
      this._controlSock.write(buf);
      return true;
    } catch {
      return false;
    }
  }

  sendTouch(ev) {
    const w = ev.screenWidth || this.meta.width || 720;
    const h = ev.screenHeight || this.meta.height || 1600;
    return this.sendControl(
      encodeInjectTouch({
        ...ev,
        screenWidth: w,
        screenHeight: h,
      })
    );
  }

  sendScroll(ev) {
    const w = ev.screenWidth || this.meta.width || 720;
    const h = ev.screenHeight || this.meta.height || 1600;
    return this.sendControl(
      encodeInjectScroll({
        ...ev,
        screenWidth: w,
        screenHeight: h,
      })
    );
  }

  sendKey(action, keycode, metaState = 0, repeat = 0) {
    return this.sendControl(encodeInjectKeycode(action, keycode, repeat, metaState));
  }

  sendText(text) {
    if (!text) return false;
    const str = String(text);
    // Pure printable ASCII can use INJECT_TEXT; any Unicode/CJK/Emoji uses SET_CLIPBOARD + paste!
    if (/^[\x20-\x7e]+$/.test(str)) {
      return this.sendControl(encodeInjectText(str));
    }
    return this.setClipboard(str, true);
  }

  setClipboard(text, paste = false) {
    const seq = this._clipSeq++;
    return this.sendControl(encodeSetClipboard(text, paste, seq));
  }

  performAction(name) {
    switch (name) {
      case 'back':
        this.sendControl(encodeBackOrScreenOn(0));
        return this.sendControl(encodeBackOrScreenOn(1));
      case 'home':
        this.sendKey(0, 3);
        return this.sendKey(1, 3);
      case 'recents':
        this.sendKey(0, 187);
        return this.sendKey(1, 187);
      case 'power':
        this.sendKey(0, 26);
        return this.sendKey(1, 26);
      case 'vol_up':
        this.sendKey(0, 24);
        return this.sendKey(1, 24);
      case 'vol_down':
        this.sendKey(0, 25);
        return this.sendKey(1, 25);
      case 'rotate':
        return this.sendControl(encodeEmptyControl(CONTROL_MSG.ROTATE_DEVICE));
      case 'notifications':
        return this.sendControl(encodeEmptyControl(CONTROL_MSG.EXPAND_NOTIFICATION_PANEL));
      case 'settings':
        return this.sendControl(encodeEmptyControl(CONTROL_MSG.EXPAND_SETTINGS_PANEL));
      case 'collapse':
        return this.sendControl(encodeEmptyControl(CONTROL_MSG.COLLAPSE_PANELS));
      case 'wake':
        return this.sendControl(encodeSetDisplayPower(true));
      case 'sleep':
        return this.sendControl(encodeSetDisplayPower(false));
      case 'reset_video':
        return this.sendControl(encodeEmptyControl(CONTROL_MSG.RESET_VIDEO));
      default:
        return false;
    }
  }

  async _launchSession() {
    const ready = await this.adb.isDeviceReady();
    if (!ready) {
      throw new Error('Android 模拟器尚未完成开机');
    }

    await this.adb.pushServer(this.serverJarPath, '/data/local/tmp/scrcpy-server.jar');
    const scid = crypto.randomInt(1, 0x7fffffff).toString(16).padStart(8, '0');
    const socketName = `scrcpy_${scid}`;

    await this.adb.removeForward(this.localPort);
    await this.adb.forwardPort(this.localPort, socketName);

    const cfg = QUALITY_PRESETS[this.preset] || QUALITY_PRESETS.balanced;
    const serverCmd = [
      'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      SCRCPY_VERSION,
      `scid=${scid}`,
      'log_level=info',
      'video=true',
      'audio=false',
      'control=true',
      'tunnel_forward=true',
      'video_codec=h264',
      `video_bit_rate=${cfg.bitRate}`,
      `max_fps=${cfg.maxFps}`,
      `max_size=${cfg.maxSize}`,
      'stay_awake=true',
      'clipboard_autosync=true',
      'power_on=true',
      'cleanup=true',
      'send_dummy_byte=true',
      'send_device_meta=true',
      'send_stream_meta=true',
      'send_frame_meta=true',
    ].join(' ');

    this.emit('log', `[scrcpy] 启动视频流 (${cfg.label}, ${cfg.maxSize}px, ${(cfg.bitRate / 1e6).toFixed(1)}Mbps)`);

    const proc = this.adb.spawnShell([serverCmd]);
    this._proc = proc;

    proc.stdout.on('data', (d) => {
      for (const line of d.toString('utf8').split('\n')) {
        if (line.trim()) this.emit('log', `[scrcpy] ${line.trim()}`);
      }
    });
    proc.stderr.on('data', (d) => {
      for (const line of d.toString('utf8').split('\n')) {
        if (line.trim()) this.emit('log', `[scrcpy] ${line.trim()}`);
      }
    });
    proc.on('exit', (code) => {
      if (this._proc === proc) {
        this._proc = null;
        this._cleanupSockets();
        this._running = false;
        this.emit('disconnected');
        if (!this._stopped) {
          this.emit('log', `[scrcpy] 进程退出 (code=${code})，准备自动重连…`);
          this._scheduleReconnect(2000);
        }
      }
    });

    // Connect video socket and wait for dummy byte with retries (tunnel_forward)
    const videoSock = await this._connectWithDummyByte(this.localPort, 10000);
    const controlSock = await this._connectTcp(this.localPort, 5000);

    this._videoSock = videoSock;
    this._controlSock = controlSock;
    this._running = true;

    const videoParser = new ScrcpyVideoParser();
    // Dummy byte was already consumed during handshake
    videoParser.stage = 'device_meta';

    videoParser.on('session', ({ width, height, deviceName }) => {
      this.meta = {
        width,
        height,
        deviceName: deviceName || this.meta.deviceName || 'Pixel Cloud',
        codec: 'h264',
        preset: this.preset,
      };
      this.lastKeyFrame = null;
      this.emit('meta', this.meta);
    });

    videoParser.on('packet', (packet) => {
      this._bytesWindow += packet.data.length;
      const wsFrame = packWsVideoFrame(packet);
      if (packet.isConfig) {
        this.lastConfigFrame = wsFrame;
        this.emit('frame', { frame: wsFrame, isConfig: true, isKeyFrame: false });
      } else if (packet.isKeyFrame) {
        this.lastKeyFrame = wsFrame;
        this.emit('frame', { frame: wsFrame, isConfig: false, isKeyFrame: true });
      } else {
        this.emit('frame', { frame: wsFrame, isConfig: false, isKeyFrame: false });
      }
    });

    videoSock.on('data', (chunk) => videoParser.push(chunk));
    videoSock.on('close', () => {
      if (this._videoSock === videoSock) {
        this._running = false;
        this._cleanupSockets();
        this.emit('disconnected');
        if (!this._stopped) this._scheduleReconnect(2000);
      }
    });
    videoSock.on('error', () => {
      videoSock.destroy();
    });

    const devParser = new ScrcpyDeviceMessageParser();
    devParser.on('clipboard', (text) => this.emit('clipboard', text));
    controlSock.on('data', (chunk) => devParser.push(chunk));
    controlSock.on('error', () => {
      controlSock.destroy();
    });

    this.emit('connected');
  }

  async _connectWithDummyByte(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this._stopped) {
      try {
        const sock = await this._connectTcp(port, 1500);
        const firstByte = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            sock.destroy();
            reject(new Error('dummy timeout'));
          }, 1200);
          sock.once('data', (chunk) => {
            clearTimeout(timer);
            resolve(chunk);
          });
          sock.once('close', () => {
            clearTimeout(timer);
            reject(new Error('closed before dummy byte'));
          });
          sock.once('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });

        // If extra bytes arrived in same TCP packet after dummy byte, unshift them!
        if (firstByte.length > 1) {
          sock.unshift(firstByte.subarray(1));
        }
        return sock;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error('等待 scrcpy-server 建立视频通道超时');
  }

  _connectTcp(port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port });
      sock.setNoDelay(true);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('tcp connect timeout'));
      }, timeoutMs);
      sock.once('connect', () => {
        clearTimeout(timer);
        resolve(sock);
      });
      sock.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  _scheduleReconnect(delayMs) {
    if (this._stopped) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this.start();
    }, delayMs);
    this._reconnectTimer.unref?.();
  }

  _cleanupSockets() {
    if (this._videoSock) {
      this._videoSock.removeAllListeners();
      this._videoSock.destroy();
      this._videoSock = null;
    }
    if (this._controlSock) {
      this._controlSock.removeAllListeners();
      this._controlSock.destroy();
      this._controlSock = null;
    }
  }

  _killProc() {
    if (this._proc) {
      try {
        this._proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      this._proc = null;
    }
  }
}
