// Complete DOM KeyboardEvent.code -> Android KeyEvent.KEYCODE_* mapping

export const META_SHIFT_ON = 0x1;
export const META_ALT_ON = 0x2;
export const META_CTRL_ON = 0x1000;
export const META_META_ON = 0x10000;

export const KEYCODE_MAP = {
  // Navigation & editing
  Backspace: 67,
  Tab: 61,
  Enter: 66,
  NumpadEnter: 160,
  Escape: 111,
  Space: 62,
  Delete: 112,
  Insert: 124,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,

  // Digits
  Digit0: 7,
  Digit1: 8,
  Digit2: 9,
  Digit3: 10,
  Digit4: 11,
  Digit5: 12,
  Digit6: 13,
  Digit7: 14,
  Digit8: 15,
  Digit9: 16,

  // Letters
  KeyA: 29,
  KeyB: 30,
  KeyC: 31,
  KeyD: 32,
  KeyE: 33,
  KeyF: 34,
  KeyG: 35,
  KeyH: 36,
  KeyI: 37,
  KeyJ: 38,
  KeyK: 39,
  KeyL: 40,
  KeyM: 41,
  KeyN: 42,
  KeyO: 43,
  KeyP: 44,
  KeyQ: 45,
  KeyR: 46,
  KeyS: 47,
  KeyT: 48,
  KeyU: 49,
  KeyV: 50,
  KeyW: 51,
  KeyX: 52,
  KeyY: 53,
  KeyZ: 54,

  // Punctuation
  Comma: 55,
  Period: 56,
  Minus: 69,
  Equal: 70,
  BracketLeft: 71,
  BracketRight: 72,
  Backslash: 73,
  Semicolon: 74,
  Quote: 75,
  Slash: 76,
  Backquote: 68,

  // Numpad
  Numpad0: 144,
  Numpad1: 145,
  Numpad2: 146,
  Numpad3: 147,
  Numpad4: 148,
  Numpad5: 149,
  Numpad6: 150,
  Numpad7: 151,
  Numpad8: 152,
  Numpad9: 153,
  NumpadDivide: 154,
  NumpadMultiply: 155,
  NumpadSubtract: 156,
  NumpadAdd: 157,
  NumpadDecimal: 158,

  // Modifiers
  ShiftLeft: 59,
  ShiftRight: 60,
  ControlLeft: 113,
  ControlRight: 114,
  AltLeft: 57,
  AltRight: 58,
  CapsLock: 115,
};

export function getAndroidMetaState(e) {
  let meta = 0;
  if (e.shiftKey) meta |= META_SHIFT_ON;
  if (e.altKey) meta |= META_ALT_ON;
  if (e.ctrlKey) meta |= META_CTRL_ON;
  if (e.metaKey) meta |= META_META_ON;
  return meta;
}
