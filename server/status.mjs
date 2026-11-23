import fs from 'node:fs';
import { EventEmitter } from 'node:events';

const MAX_LOG_LINES = 250;

export class BootStatusTracker extends EventEmitter {
  constructor({
    stateFile = process.env.STATE_FILE || '/tmp/droidcloud-state.json',
    logFile = process.env.BOOT_LOG_FILE || '/tmp/droidcloud-boot.log',
    pollMs = 1000,
  } = {}) {
    super();
    this.stateFile = stateFile;
    this.logFile = logFile;
    this.pollMs = pollMs;
    this._timer = null;
    this._logOffset = 0;
    this._logRemainder = '';
    this.logs = [];
    this.state = {
      stage: 'init',
      progress: 5,
      message: '正在初始化云手机环境…',
      ready: false,
      error: null,
      androidVersion: process.env.ANDROID_VERSION || '16',
      device: process.env.DEVICE || 'pixel_7',
      screenPreset: process.env.SCREEN_PRESET || 'balanced',
      updatedAt: Date.now(),
    };
  }

  start() {
    this._poll();
    if (this.pollMs > 0) {
      this._timer = setInterval(() => this._poll(), this.pollMs);
      this._timer.unref?.();
    }
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  setState(patch) {
    const next = { ...this.state, ...patch, updatedAt: Date.now() };
    const changed =
      next.stage !== this.state.stage ||
      next.progress !== this.state.progress ||
      next.message !== this.state.message ||
      next.ready !== this.state.ready ||
      next.error !== this.state.error;
    this.state = next;
    if (changed) {
      this.emit('status', this.state);
    }
  }

  appendLog(line) {
    const clean = String(line).replace(/\r/g, '').trimEnd();
    if (!clean) return;
    this.logs.push(clean);
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    }
    this.emit('log', clean);
  }

  getSnapshot() {
    return {
      ...this.state,
      logs: this.logs.slice(-120),
    };
  }

  _poll() {
    this._readStateFile();
    this._tailLogFile();
  }

  _readStateFile() {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const raw = fs.readFileSync(this.stateFile, 'utf8').trim();
      if (!raw) return;
      const parsed = JSON.parse(raw);
      this.setState(parsed);
    } catch {
      // ignore partial write
    }
  }

  _tailLogFile() {
    try {
      if (!fs.existsSync(this.logFile)) return;
      const stat = fs.statSync(this.logFile);
      if (stat.size < this._logOffset) {
        this._logOffset = 0;
        this._logRemainder = '';
      }
      if (stat.size === this._logOffset) return;

      const toRead = Math.min(stat.size - this._logOffset, 64 * 1024);
      const fd = fs.openSync(this.logFile, 'r');
      try {
        const buf = Buffer.allocUnsafe(toRead);
        const bytesRead = fs.readSync(fd, buf, 0, toRead, this._logOffset);
        this._logOffset += bytesRead;
        const text = this._logRemainder + buf.subarray(0, bytesRead).toString('utf8');
        const lines = text.split('\n');
        this._logRemainder = lines.pop() || '';
        for (const line of lines) {
          this.appendLog(line);
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // ignore
    }
  }
}
