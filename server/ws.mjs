import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024; // 4 MiB guard

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = data.length;
  let header;

  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return len === 0 ? header : Buffer.concat([header, data]);
}

export class WebSocketClient extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.closed = false;
    this.isAlive = true;
    this._buffer = Buffer.alloc(0);
    this._fragOpcode = null;
    this._fragChunks = [];
    this._fragLength = 0;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => {
      if (!this.closed) {
        this.emit('error', err);
        this._cleanup(1006, 'socket error');
      }
    });
    socket.on('close', () => this._cleanup(1006, 'closed'));
  }

  get bufferedAmount() {
    return this.socket.writableLength || 0;
  }

  sendText(text) {
    if (this.closed || this.socket.destroyed) return false;
    const payload = Buffer.from(String(text), 'utf8');
    return this._writeRaw(encodeFrame(OPCODE.TEXT, payload));
  }

  sendJson(obj) {
    return this.sendText(JSON.stringify(obj));
  }

  sendBinary(buffer) {
    if (this.closed || this.socket.destroyed) return false;
    return this._writeRaw(encodeFrame(OPCODE.BINARY, buffer));
  }

  ping() {
    if (this.closed || this.socket.destroyed) return false;
    return this._writeRaw(encodeFrame(OPCODE.PING));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBuf = Buffer.from(reason, 'utf8').subarray(0, 123);
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this._writeRaw(encodeFrame(OPCODE.CLOSE, payload));
    this._cleanup(code, reason);
    try {
      this.socket.end();
    } catch {
      // ignore
    }
  }

  _writeRaw(buf) {
    try {
      return this.socket.write(buf);
    } catch {
      this._cleanup(1006, 'write error');
      return false;
    }
  }

  _cleanup(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this._buffer = Buffer.alloc(0);
    this._fragChunks = [];
    this.emit('close', code, reason);
  }

  _onData(chunk) {
    if (this.closed) return;
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);

    while (this._buffer.length >= 2) {
      const b0 = this._buffer[0];
      const b1 = this._buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (rsv !== 0) {
        this.close(1002, 'unexpected RSV bits');
        return;
      }

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return;
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return;
        const bigLen = this._buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(MAX_PAYLOAD_BYTES)) {
          this.close(1009, 'message too big');
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > MAX_PAYLOAD_BYTES) {
        this.close(1009, 'message too big');
        return;
      }

      const maskLen = masked ? 4 : 0;
      const totalLen = offset + maskLen + payloadLen;
      if (this._buffer.length < totalLen) return;

      let payload;
      if (masked) {
        const maskKey = this._buffer.subarray(offset, offset + 4);
        const raw = this._buffer.subarray(offset + 4, totalLen);
        payload = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          payload[i] = raw[i] ^ maskKey[i & 3];
        }
      } else {
        payload = Buffer.from(this._buffer.subarray(offset, totalLen));
      }

      this._buffer = this._buffer.subarray(totalLen);
      this.isAlive = true;

      if (opcode === OPCODE.CLOSE) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        this.close(code, reason);
        return;
      }

      if (opcode === OPCODE.PING) {
        this._writeRaw(encodeFrame(OPCODE.PONG, payload));
        continue;
      }

      if (opcode === OPCODE.PONG) {
        this.isAlive = true;
        continue;
      }

      if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
        if (fin) {
          this._dispatchMessage(opcode, payload);
        } else {
          this._fragOpcode = opcode;
          this._fragChunks = [payload];
          this._fragLength = payload.length;
        }
      } else if (opcode === OPCODE.CONTINUATION) {
        if (this._fragOpcode === null) {
          this.close(1002, 'unexpected continuation');
          return;
        }
        this._fragLength += payload.length;
        if (this._fragLength > MAX_PAYLOAD_BYTES) {
          this.close(1009, 'fragmented message too big');
          return;
        }
        this._fragChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(this._fragChunks, this._fragLength);
          const msgOp = this._fragOpcode;
          this._fragOpcode = null;
          this._fragChunks = [];
          this._fragLength = 0;
          this._dispatchMessage(msgOp, full);
        }
      } else {
        this.close(1002, 'unsupported opcode');
        return;
      }
    }
  }

  _dispatchMessage(opcode, payload) {
    if (opcode === OPCODE.TEXT) {
      this.emit('message', payload.toString('utf8'), false);
    } else if (opcode === OPCODE.BINARY) {
      this.emit('message', payload, true);
    }
  }
}

export class WebSocketServer extends EventEmitter {
  constructor({ path = '/ws', verifyClient = null, heartbeatMs = 25000 } = {}) {
    super();
    this.path = path;
    this.verifyClient = verifyClient;
    this.clients = new Set();
    this._heartbeatTimer = null;

    if (heartbeatMs > 0) {
      this._heartbeatTimer = setInterval(() => {
        for (const client of this.clients) {
          if (!client.isAlive) {
            client.close(1001, 'heartbeat timeout');
            this.clients.delete(client);
            continue;
          }
          client.isAlive = false;
          client.ping();
        }
      }, heartbeatMs);
      this._heartbeatTimer.unref?.();
    }
  }

  attach(httpServer) {
    httpServer.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });
  }

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== this.path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    const key = req.headers['sec-websocket-key'];
    if (upgrade !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (this.verifyClient && !this.verifyClient(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash('sha1')
      .update(key + WS_MAGIC_GUID)
      .digest('base64');

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n');

    socket.write(headers);

    const client = new WebSocketClient(socket, req);
    this.clients.add(client);
    client.on('close', () => {
      this.clients.delete(client);
    });

    if (head && head.length > 0) {
      client._onData(head);
    }

    this.emit('connection', client, req);
  }

  broadcastJson(obj) {
    const frame = encodeFrame(OPCODE.TEXT, Buffer.from(JSON.stringify(obj), 'utf8'));
    for (const client of this.clients) {
      if (!client.closed && !client.socket.destroyed) {
        client._writeRaw(frame);
      }
    }
  }

  broadcastBinary(buffer, { droppable = false, maxBuffered = 384 * 1024 } = {}) {
    if (this.clients.size === 0) return;
    const frame = encodeFrame(OPCODE.BINARY, buffer);
    for (const client of this.clients) {
      if (client.closed || client.socket.destroyed) continue;
      if (droppable && client.bufferedAmount > maxBuffered) {
        continue;
      }
      client._writeRaw(frame);
    }
  }

  closeAll(code = 1001, reason = 'server shutdown') {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    for (const client of this.clients) {
      client.close(code, reason);
    }
    this.clients.clear();
  }
}
