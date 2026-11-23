import { KEYCODE_MAP, getAndroidMetaState } from './keycodes.js';

const ACTION_DOWN = 0;
const ACTION_UP = 1;
const ACTION_MOVE = 2;

export class PhoneInputController {
  constructor({ viewport, imeSink, pinchDot1, pinchDot2, sendBinary, sendJson, onOpenImeModal }) {
    this.viewport = viewport;
    this.imeSink = imeSink;
    this.pinchDot1 = pinchDot1;
    this.pinchDot2 = pinchDot2;
    this.sendBinary = sendBinary;
    this.sendJson = sendJson;
    this.onOpenImeModal = onOpenImeModal;

    this._activePointers = new Map();
    this._pinching = false;
    this._pinchCenter = { x: 0.5, y: 0.5 };
    this._composing = false;

    this._bindPointerEvents();
    this._bindWheelEvents();
    this._bindKeyboardEvents();
  }

  _getNormalizedCoords(clientX, clientY) {
    const rect = this.viewport.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return { x, y };
  }

  _sendTouch(action, pointerId, normX, normY, pressure) {
    const buf = new ArrayBuffer(18);
    const dv = new DataView(buf);
    dv.setUint8(0, 0x10);
    dv.setUint8(1, action);
    dv.setInt32(2, pointerId | 0);
    dv.setFloat32(6, normX);
    dv.setFloat32(10, normY);
    dv.setFloat32(14, pressure);
    this.sendBinary(buf);
  }

  _sendScroll(normX, normY, hScroll, vScroll) {
    const buf = new ArrayBuffer(17);
    const dv = new DataView(buf);
    dv.setUint8(0, 0x11);
    dv.setFloat32(1, normX);
    dv.setFloat32(5, normY);
    dv.setFloat32(9, hScroll);
    dv.setFloat32(13, vScroll);
    this.sendBinary(buf);
  }

  _updatePinchDots(p1, p2, visible) {
    if (!visible) {
      this.pinchDot1.classList.add('hidden');
      this.pinchDot2.classList.add('hidden');
      return;
    }
    this.pinchDot1.classList.remove('hidden');
    this.pinchDot2.classList.remove('hidden');
    this.pinchDot1.style.left = `${p1.x * 100}%`;
    this.pinchDot1.style.top = `${p1.y * 100}%`;
    this.pinchDot2.style.left = `${p2.x * 100}%`;
    this.pinchDot2.style.top = `${p2.y * 100}%`;
  }

  _bindPointerEvents() {
    this.viewport.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    this.viewport.addEventListener('pointerdown', (e) => {
      // Focus hidden IME sink so keyboard & Chinese IME work immediately after tapping screen
      this.imeSink.focus({ preventScroll: true });

      // Right-click -> Back
      if (e.pointerType === 'mouse' && e.button === 2) {
        e.preventDefault();
        this.sendJson({ type: 'action', name: 'back' });
        return;
      }

      // Middle-click -> Home
      if (e.pointerType === 'mouse' && e.button === 1) {
        e.preventDefault();
        this.sendJson({ type: 'action', name: 'home' });
        return;
      }

      if (e.pointerType === 'mouse' && e.button !== 0) return;

      e.preventDefault();
      this.viewport.setPointerCapture(e.pointerId);
      const pos = this._getNormalizedCoords(e.clientX, e.clientY);

      // Alt + Left drag -> 2-finger pinch-to-zoom around screen center!
      if (e.pointerType === 'mouse' && e.altKey) {
        this._pinching = true;
        this._pinchCenter = { x: 0.5, y: 0.5 };
        const p2 = {
          x: Math.max(0, Math.min(1, 2 * this._pinchCenter.x - pos.x)),
          y: Math.max(0, Math.min(1, 2 * this._pinchCenter.y - pos.y)),
        };
        this._activePointers.set(e.pointerId, { pinch: true });
        this._sendTouch(ACTION_DOWN, 1, pos.x, pos.y, 1.0);
        this._sendTouch(ACTION_DOWN, 2, p2.x, p2.y, 1.0);
        this._updatePinchDots(pos, p2, true);
        return;
      }

      const androidPointerId = e.pointerType === 'touch' ? (e.pointerId % 10) + 1 : 1;
      this._activePointers.set(e.pointerId, { androidPointerId, pinch: false });
      this._sendTouch(ACTION_DOWN, androidPointerId, pos.x, pos.y, 1.0);
    });

    this.viewport.addEventListener('pointermove', (e) => {
      const info = this._activePointers.get(e.pointerId);
      if (!info) return;
      e.preventDefault();
      const pos = this._getNormalizedCoords(e.clientX, e.clientY);

      if (info.pinch) {
        const p2 = {
          x: Math.max(0, Math.min(1, 2 * this._pinchCenter.x - pos.x)),
          y: Math.max(0, Math.min(1, 2 * this._pinchCenter.y - pos.y)),
        };
        this._sendTouch(ACTION_MOVE, 1, pos.x, pos.y, 1.0);
        this._sendTouch(ACTION_MOVE, 2, p2.x, p2.y, 1.0);
        this._updatePinchDots(pos, p2, true);
      } else {
        this._sendTouch(ACTION_MOVE, info.androidPointerId, pos.x, pos.y, 1.0);
      }
    });

    const releasePointer = (e) => {
      const info = this._activePointers.get(e.pointerId);
      if (!info) return;
      this._activePointers.delete(e.pointerId);
      const pos = this._getNormalizedCoords(e.clientX, e.clientY);

      if (info.pinch) {
        const p2 = {
          x: Math.max(0, Math.min(1, 2 * this._pinchCenter.x - pos.x)),
          y: Math.max(0, Math.min(1, 2 * this._pinchCenter.y - pos.y)),
        };
        this._sendTouch(ACTION_UP, 1, pos.x, pos.y, 0.0);
        this._sendTouch(ACTION_UP, 2, p2.x, p2.y, 0.0);
        this._updatePinchDots(pos, p2, false);
        this._pinching = false;
      } else {
        this._sendTouch(ACTION_UP, info.androidPointerId, pos.x, pos.y, 0.0);
      }
    };

    this.viewport.addEventListener('pointerup', releasePointer);
    this.viewport.addEventListener('pointercancel', releasePointer);
  }

  _bindWheelEvents() {
    this.viewport.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const pos = this._getNormalizedCoords(e.clientX, e.clientY);
        const scale = e.deltaMode === 1 ? 1.0 : 0.025;
        const hScroll = Math.max(-16, Math.min(16, -e.deltaX * scale));
        const vScroll = Math.max(-16, Math.min(16, -e.deltaY * scale));
        if (Math.abs(hScroll) > 0.01 || Math.abs(vScroll) > 0.01) {
          this._sendScroll(pos.x, pos.y, hScroll, vScroll);
        }
      },
      { passive: false }
    );
  }

  _bindKeyboardEvents() {
    // Capture seamless Chinese/CJK/Emoji IME input from hidden textarea
    this.imeSink.addEventListener('compositionstart', () => {
      this._composing = true;
    });

    this.imeSink.addEventListener('compositionend', (e) => {
      this._composing = false;
      const committed = e.data || this.imeSink.value;
      this.imeSink.value = '';
      if (committed) {
        this.sendJson({ type: 'text', text: committed });
      }
    });

    this.imeSink.addEventListener('input', () => {
      if (this._composing) return;
      const val = this.imeSink.value;
      this.imeSink.value = '';
      if (!val) return;
      // Non-ASCII characters (e.g. Chinese punctuation or pasted text) go straight through text/clipboard bridge
      if (!/^[\x20-\x7e]+$/.test(val)) {
        this.sendJson({ type: 'text', text: val });
      }
    });

    this.imeSink.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text');
      if (text) {
        e.preventDefault();
        this.sendJson({ type: 'clipboard_set', text, paste: true });
      }
    });

    const isFocusedOnPhone = () =>
      document.activeElement === this.imeSink || document.activeElement === this.viewport;

    window.addEventListener('keydown', (e) => {
      // Global shortcut Ctrl/Cmd + K -> Open Quick Chinese Input modal
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
        e.preventDefault();
        if (this.onOpenImeModal) this.onOpenImeModal();
        return;
      }

      if (!isFocusedOnPhone() || this._composing || e.isComposing || e.keyCode === 229) return;

      // Let Ctrl/Cmd+V trigger paste event on imeSink so browser clipboard syncs cleanly!
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') {
        return;
      }

      const keycode = KEYCODE_MAP[e.code];
      if (keycode === undefined) return;

      // Single printable ASCII characters with no Ctrl/Alt/Meta: inject directly as text for exact shift/symbol fidelity
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && /^[\x20-\x7e]$/.test(e.key)) {
        e.preventDefault();
        this.sendJson({ type: 'text', text: e.key });
        return;
      }

      e.preventDefault();
      this.sendJson({
        type: 'key',
        action: ACTION_DOWN,
        keycode,
        metaState: getAndroidMetaState(e),
        repeat: e.repeat ? 1 : 0,
      });
    });

    window.addEventListener('keyup', (e) => {
      if (!isFocusedOnPhone() || this._composing || e.isComposing) return;
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') return;
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && /^[\x20-\x7e]$/.test(e.key)) {
        return;
      }
      const keycode = KEYCODE_MAP[e.code];
      if (keycode === undefined) return;
      e.preventDefault();
      this.sendJson({
        type: 'key',
        action: ACTION_UP,
        keycode,
        metaState: getAndroidMetaState(e),
        repeat: 0,
      });
    });
  }
}
