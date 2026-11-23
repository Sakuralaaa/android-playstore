// Dual-engine H.264 decoder:
// 1) WebCodecs VideoDecoder (primary, ~40ms glass-to-glass latency in HTTPS/localhost)
// 2) Pure-JS fMP4 MediaSource Extensions fallback (works even over plain HTTP LAN!)

export function splitAnnexBNals(data) {
  const nals = [];
  let i = 0;
  const len = data.length;
  let nalStart = -1;

  while (i < len) {
    let scLen = 0;
    if (i + 3 < len && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      scLen = 4;
    } else if (i + 2 < len && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      scLen = 3;
    }

    if (scLen > 0) {
      if (nalStart !== -1 && i > nalStart) {
        nals.push(data.subarray(nalStart, i));
      }
      i += scLen;
      nalStart = i;
    } else {
      i++;
    }
  }

  if (nalStart !== -1 && nalStart < len) {
    nals.push(data.subarray(nalStart, len));
  }
  return nals;
}

export function extractSpsPps(configAnnexB) {
  const nals = splitAnnexBNals(configAnnexB);
  let sps = null;
  let pps = null;
  for (const nal of nals) {
    if (nal.length === 0) continue;
    const type = nal[0] & 0x1f;
    if (type === 7) sps = nal;
    else if (type === 8) pps = nal;
  }
  return { sps, pps };
}

export function buildAvcCodecString(sps) {
  if (!sps || sps.length < 4) return 'avc1.42E01F';
  const hex = (b) => b.toString(16).padStart(2, '0');
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

function concatBytes(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// --- Minimal fMP4 Box Builder for MSE fallback ---
function mp4Box(type, ...parts) {
  let size = 8;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let offset = 8;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function u32(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0);
  return b;
}

function buildInitSegment(sps, pps, width, height) {
  const ftyp = mp4Box(
    'ftyp',
    new TextEncoder().encode('isom'),
    u32(0x200),
    new TextEncoder().encode('isomiso2avc1mp41')
  );

  // mvhd (v0, 96 bytes payload)
  const mvhd = new Uint8Array(96);
  const mdv = new DataView(mvhd.buffer);
  mdv.setUint32(12, 90000); // timescale
  mdv.setUint32(20, 0x00010000); // rate 1.0
  mdv.setUint16(24, 0x0100); // volume
  mdv.setUint32(36, 0x00010000); // unity matrix
  mdv.setUint32(52, 0x00010000);
  mdv.setUint32(68, 0x40000000);
  mdv.setUint32(92, 2); // next_track_id

  // tkhd (v0, 84 bytes payload)
  const tkhd = new Uint8Array(84);
  const tdv = new DataView(tkhd.buffer);
  tdv.setUint32(0, 0x00000003); // flags: enabled + in_movie
  tdv.setUint32(12, 1); // track_id
  tdv.setUint32(40, 0x00010000); // unity matrix
  tdv.setUint32(56, 0x00010000);
  tdv.setUint32(72, 0x40000000);
  tdv.setUint32(76, (width & 0xffff) << 16);
  tdv.setUint32(80, (height & 0xffff) << 16);

  // mdhd (v0, 24 bytes payload)
  const mdhd = new Uint8Array(24);
  new DataView(mdhd.buffer).setUint32(12, 90000);

  // hdlr
  const hdlr = concatBytes(
    new Uint8Array(8),
    new TextEncoder().encode('vide'),
    new Uint8Array(12),
    new TextEncoder().encode('VideoHandler\0')
  );

  const vmhd = new Uint8Array(12);
  vmhd[3] = 1;

  const dref = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 12, 117, 114, 108, 32, 0, 0, 0, 1]);
  const dinf = mp4Box('dinf', mp4Box('dref', dref));

  // avcC
  const avcC = new Uint8Array(11 + sps.length + pps.length);
  const cdv = new DataView(avcC.buffer);
  avcC[0] = 1;
  avcC[1] = sps[1];
  avcC[2] = sps[2];
  avcC[3] = sps[3];
  avcC[4] = 0xff; // 4-byte lengthSizeMinusOne = 3
  avcC[5] = 0xe1; // 1 SPS
  cdv.setUint16(6, sps.length);
  avcC.set(sps, 8);
  const ppsOff = 8 + sps.length;
  avcC[ppsOff] = 1; // 1 PPS
  cdv.setUint16(ppsOff + 1, pps.length);
  avcC.set(pps, ppsOff + 3);

  const avc1Head = new Uint8Array(78);
  const a1 = new DataView(avc1Head.buffer);
  a1.setUint16(6, 1); // data_reference_index
  a1.setUint16(24, width);
  a1.setUint16(26, height);
  a1.setUint32(28, 0x00480000);
  a1.setUint32(32, 0x00480000);
  a1.setUint16(40, 1);
  a1.setUint16(74, 0x0018);
  a1.setInt16(76, -1);

  const avc1 = mp4Box('avc1', avc1Head, mp4Box('avcC', avcC));
  const stsd = mp4Box('stsd', new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), avc1);
  const emptyTable = new Uint8Array(8);
  const stbl = mp4Box(
    'stbl',
    stsd,
    mp4Box('stts', emptyTable),
    mp4Box('stsc', emptyTable),
    mp4Box('stsz', new Uint8Array(12)),
    mp4Box('stco', emptyTable)
  );
  const minf = mp4Box('minf', mp4Box('vmhd', vmhd), dinf, stbl);
  const mdia = mp4Box('mdia', mp4Box('mdhd', mdhd), mp4Box('hdlr', hdlr), minf);
  const trak = mp4Box('trak', mp4Box('tkhd', tkhd), mdia);

  const trex = new Uint8Array(24);
  const trdv = new DataView(trex.buffer);
  trdv.setUint32(4, 1); // track_id
  trdv.setUint32(8, 1); // default_sample_description_index
  const mvex = mp4Box('mvex', mp4Box('trex', trex));

  const moov = mp4Box('moov', mp4Box('mvhd', mvhd), trak, mvex);
  return concatBytes(ftyp, moov);
}

function annexBToAvccSample(annexB) {
  const nals = splitAnnexBNals(annexB).filter((n) => {
    const t = n[0] & 0x1f;
    return t !== 7 && t !== 8 && n.length > 0;
  });
  if (nals.length === 0) return null;
  let total = 0;
  for (const n of nals) total += 4 + n.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let off = 0;
  for (const n of nals) {
    dv.setUint32(off, n.length);
    out.set(n, off + 4);
    off += 4 + n.length;
  }
  return out;
}

function buildMediaSegment(seq, decodeTime, duration, sampleBytes, isKey) {
  const mfhd = new Uint8Array(8);
  new DataView(mfhd.buffer).setUint32(4, seq);

  const tfhd = new Uint8Array(8);
  const tfhdDv = new DataView(tfhd.buffer);
  tfhdDv.setUint32(0, 0x00020000); // default-base-is-moof
  tfhdDv.setUint32(4, 1); // track_id

  const tfdt = new Uint8Array(12);
  const tfdtDv = new DataView(tfdt.buffer);
  tfdtDv.setUint32(0, 0x01000000); // version 1
  tfdtDv.setBigUint64(4, BigInt(Math.max(0, Math.floor(decodeTime))));

  const trun = new Uint8Array(24);
  const trunDv = new DataView(trun.buffer);
  // flags: data_offset_present (0x1) | sample_duration (0x100) | sample_size (0x200) | sample_flags (0x400)
  trunDv.setUint32(0, 0x00000701);
  trunDv.setUint32(4, 1); // 1 sample
  trunDv.setUint32(8, 0); // patched below
  trunDv.setUint32(12, Math.max(1500, Math.min(9000, duration)));
  trunDv.setUint32(16, sampleBytes.length);
  trunDv.setUint32(20, isKey ? 0x02000000 : 0x01010000);

  const traf = mp4Box('traf', mp4Box('tfhd', tfhd), mp4Box('tfdt', tfdt), mp4Box('trun', trun));
  const moof = mp4Box('moof', mp4Box('mfhd', mfhd), traf);

  // Patch trun data_offset = moof.length + 8 (start of mdat payload)
  const trunOffsetInMoof = moof.length - 24;
  new DataView(moof.buffer).setUint32(trunOffsetInMoof + 8, moof.length + 8);

  const mdat = mp4Box('mdat', sampleBytes);
  return concatBytes(moof, mdat);
}

export class VideoStreamRenderer {
  constructor({ canvas, videoEl, onFirstFrame, onFps, onEngineChange }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.videoEl = videoEl;
    this.onFirstFrame = onFirstFrame;
    this.onFps = onFps;
    this.onEngineChange = onEngineChange;

    this.width = 720;
    this.height = 1600;
    this.configAnnexB = null;
    this.sps = null;
    this.pps = null;
    this.codecString = 'avc1.42E01F';
    this.firstFrameRendered = false;

    this.useWebCodecs = typeof window.VideoDecoder === 'function' && typeof window.EncodedVideoChunk === 'function';
    this.engine = this.useWebCodecs ? 'WebCodecs' : 'MSE';

    // WebCodecs state
    this._decoder = null;
    this._configured = false;
    this._waitingKeyFrame = true;
    this._pendingFrame = null;
    this._rafId = null;

    // MSE fallback state
    this._mse = null;
    this._sb = null;
    this._mseQueue = [];
    this._mseSeq = 1;
    this._mseTime = 0;
    this._mseInitialized = false;

    // FPS counter
    this._framesInWindow = 0;
    this._fpsTimer = setInterval(() => {
      if (this.onFps) this.onFps(this._framesInWindow);
      this._framesInWindow = 0;
    }, 1000);

    if (this.onEngineChange) this.onEngineChange(this.engine);
    this._applyElementsVisibility();
  }

  _applyElementsVisibility() {
    if (this.useWebCodecs) {
      this.canvas.classList.remove('hidden');
      this.videoEl.classList.add('hidden');
    } else {
      this.canvas.classList.add('hidden');
      this.videoEl.classList.remove('hidden');
    }
  }

  setDimensions(width, height) {
    if (!width || !height) return;
    this.width = width;
    this.height = height;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this._waitingKeyFrame = true;
    if (!this.useWebCodecs) {
      this._resetMse();
    }
  }

  feedConfig(annexBBytes) {
    this.configAnnexB = new Uint8Array(annexBBytes);
    const { sps, pps } = extractSpsPps(this.configAnnexB);
    if (sps) {
      this.sps = sps;
      this.codecString = buildAvcCodecString(sps);
    }
    if (pps) this.pps = pps;

    if (this.useWebCodecs) {
      this._configureWebCodecs();
    } else {
      this._initMseIfReady();
    }
  }

  feedVideoFrame(isKeyFrame, ptsUs, payloadBytes) {
    if (this.useWebCodecs) {
      this._feedWebCodecs(isKeyFrame, ptsUs, payloadBytes);
    } else {
      this._feedMse(isKeyFrame, payloadBytes);
    }
  }

  _configureWebCodecs() {
    try {
      if (this._decoder && this._decoder.state !== 'closed') {
        this._decoder.close();
      }
      this._configured = false;
      this._waitingKeyFrame = true;

      this._decoder = new VideoDecoder({
        output: (frame) => this._handleDecodedFrame(frame),
        error: () => {
          this._waitingKeyFrame = true;
          this._configured = false;
        },
      });

      this._decoder.configure({
        codec: this.codecString,
        codedWidth: this.width,
        codedHeight: this.height,
        hardwareAcceleration: 'prefer-hardware',
        optimizeForLatency: true,
      });
      this._configured = true;
    } catch {
      // Fallback to MSE if WebCodecs fails
      this.useWebCodecs = false;
      this.engine = 'MSE';
      if (this.onEngineChange) this.onEngineChange(this.engine);
      this._applyElementsVisibility();
      this._initMseIfReady();
    }
  }

  _feedWebCodecs(isKeyFrame, ptsUs, payloadBytes) {
    if (!this._decoder || this._decoder.state === 'closed' || !this._configured) {
      if (this.configAnnexB) this._configureWebCodecs();
      else return;
    }

    if (this._waitingKeyFrame) {
      if (!isKeyFrame) return;
      this._waitingKeyFrame = false;
    }

    // If decoder queue grows too large, skip delta frame to stay ultra-low-latency
    if (!isKeyFrame && this._decoder.decodeQueueSize > 3) {
      return;
    }

    let chunkData = payloadBytes;
    if (isKeyFrame && this.configAnnexB) {
      chunkData = concatBytes(this.configAnnexB, payloadBytes);
    }

    try {
      const chunk = new EncodedVideoChunk({
        type: isKeyFrame ? 'key' : 'delta',
        timestamp: Number(ptsUs),
        data: chunkData,
      });
      this._decoder.decode(chunk);
    } catch {
      this._waitingKeyFrame = true;
    }
  }

  _handleDecodedFrame(frame) {
    if (this._pendingFrame) {
      this._pendingFrame.close();
    }
    this._pendingFrame = frame;
    this._framesInWindow++;

    if (!this._rafId) {
      this._rafId = requestAnimationFrame(() => {
        this._rafId = null;
        const f = this._pendingFrame;
        this._pendingFrame = null;
        if (!f) return;
        try {
          if (this.canvas.width !== f.displayWidth || this.canvas.height !== f.displayHeight) {
            this.canvas.width = f.displayWidth;
            this.canvas.height = f.displayHeight;
          }
          this.ctx.drawImage(f, 0, 0, this.canvas.width, this.canvas.height);
          if (!this.firstFrameRendered) {
            this.firstFrameRendered = true;
            if (this.onFirstFrame) this.onFirstFrame();
          }
        } finally {
          f.close();
        }
      });
    }
  }

  // --- MSE Fallback implementation ---
  _resetMse() {
    this._mseInitialized = false;
    this._mseQueue = [];
    this._mseSeq = 1;
    this._mseTime = 0;
    this._waitingKeyFrame = true;
    if (this._mse && this._mse.readyState === 'open') {
      try {
        this._mse.endOfStream();
      } catch {
        // ignore
      }
    }
    this._mse = null;
    this._sb = null;
    if (this.sps && this.pps) {
      this._initMseIfReady();
    }
  }

  _initMseIfReady() {
    if (this._mseInitialized || !this.sps || !this.pps || typeof MediaSource === 'undefined') return;
    this._mseInitialized = true;
    const mime = `video/mp4; codecs="${this.codecString}"`;
    if (!MediaSource.isTypeSupported(mime)) return;

    this._mse = new MediaSource();
    this.videoEl.src = URL.createObjectURL(this._mse);
    this._mse.addEventListener('sourceopen', () => {
      try {
        this._sb = this._mse.addSourceBuffer(mime);
        this._sb.mode = 'segments';
        this._sb.addEventListener('updateend', () => this._flushMseQueue());
        const initSeg = buildInitSegment(this.sps, this.pps, this.width, this.height);
        this._mseQueue.push(initSeg);
        this._flushMseQueue();
        this.videoEl.play().catch(() => {});
      } catch {
        // ignore
      }
    });
  }

  _feedMse(isKeyFrame, payloadBytes) {
    if (!this._mseInitialized) this._initMseIfReady();
    if (!this._sb) return;
    if (this._waitingKeyFrame) {
      if (!isKeyFrame) return;
      this._waitingKeyFrame = false;
    }
    const avcc = annexBToAvccSample(payloadBytes);
    if (!avcc) return;
    const duration = 3000; // ~30fps nominal in 90kHz timescale
    const seg = buildMediaSegment(this._mseSeq++, this._mseTime, duration, avcc, isKeyFrame);
    this._mseTime += duration;
    this._mseQueue.push(seg);
    this._framesInWindow++;
    this._flushMseQueue();

    if (!this.firstFrameRendered) {
      this.firstFrameRendered = true;
      if (this.onFirstFrame) this.onFirstFrame();
    }
  }

  _flushMseQueue() {
    if (!this._sb || this._sb.updating) return;
    if (this._mseQueue.length > 15) {
      this._mseQueue.splice(0, this._mseQueue.length - 1);
    }
    const next = this._mseQueue.shift();
    if (next) {
      try {
        this._sb.appendBuffer(next);
      } catch {
        this._resetMse();
      }
    }
    // Pin video playback to live edge
    try {
      const b = this.videoEl.buffered;
      if (b.length > 0) {
        const end = b.end(b.length - 1);
        if (end - this.videoEl.currentTime > 0.25) {
          this.videoEl.currentTime = Math.max(0, end - 0.04);
        }
      }
    } catch {
      // ignore
    }
  }

  reset() {
    this._waitingKeyFrame = true;
    this.firstFrameRendered = false;
    if (this._pendingFrame) {
      this._pendingFrame.close();
      this._pendingFrame = null;
    }
    if (this._decoder && this._decoder.state !== 'closed') {
      try {
        this._decoder.close();
      } catch {
        // ignore
      }
    }
    this._decoder = null;
    this._configured = false;
    if (!this.useWebCodecs) this._resetMse();
  }

  destroy() {
    clearInterval(this._fpsTimer);
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this.reset();
  }
}
