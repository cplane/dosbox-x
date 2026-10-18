// Browser keyboard -> PC set-1 scancodes (0x80|code for E0-extended keys),
// matching DOSBox-X src/gamelink/scancodes_windows.h and the stream
// sidecar's protocol ({"k":<scancode>,"d":down}).

/** KeyboardEvent.code -> scancode: physical keys, layout-independent. */
export const SC: Record<string, number> = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07,
  Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
  Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
  NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
  Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51,
  Numpad0: 0x52, NumpadDecimal: 0x53, IntlBackslash: 0x56, F11: 0x57, F12: 0x58,
  NumpadEnter: 0x9c, ControlRight: 0x9d, NumpadDivide: 0xb5, PrintScreen: 0xb7, AltRight: 0xb8, Pause: 0xc5,
  Home: 0xc7, ArrowUp: 0xc8, PageUp: 0xc9, ArrowLeft: 0xcb, ArrowRight: 0xcd, End: 0xcf,
  ArrowDown: 0xd0, PageDown: 0xd1, Insert: 0xd2, Delete: 0xd3, MetaLeft: 0xdb, MetaRight: 0xdc, ContextMenu: 0xdd,
}

export const SHIFT = 0x2a

/**
 * Fallback for events without KeyboardEvent.code (some virtual keyboards and
 * automation): KeyboardEvent.key -> [scancode, needs Shift] on a US layout.
 */
export const KEY: Record<string, [number, boolean]> = {
  Escape: [0x01, false], Enter: [0x1c, false], Tab: [0x0f, false], Backspace: [0x0e, false], ' ': [0x39, false],
  Shift: [0x2a, false], Control: [0x1d, false], Alt: [0x38, false], CapsLock: [0x3a, false],
  ArrowUp: [0xc8, false], ArrowDown: [0xd0, false], ArrowLeft: [0xcb, false], ArrowRight: [0xcd, false],
  Home: [0xc7, false], End: [0xcf, false], PageUp: [0xc9, false], PageDown: [0xd1, false],
  Insert: [0xd2, false], Delete: [0xd3, false],
}
for (let i = 1; i <= 12; i++) KEY['F' + i] = [SC['F' + i], false]
for (const [sc, plain, shifted] of [
  [0x02, '1234567890-=', '!@#$%^&*()_+'], [0x10, 'qwertyuiop[]', 'QWERTYUIOP{}'],
  [0x1e, "asdfghjkl;'`", 'ASDFGHJKL:"~'], [0x2c, 'zxcvbnm,./', 'ZXCVBNM<>?'], [0x2b, '\\', '|'],
] as [number, string, string][]) {
  ;[...plain].forEach((c, i) => { KEY[c] = [sc + i, false] })
  ;[...shifted].forEach((c, i) => { KEY[c] = [sc + i, true] })
}

/** The scancode for an event, and whether a Shift must be synthesized. */
export function scancodeFor(e: KeyboardEvent): [number, boolean] | undefined {
  const sc = SC[e.code]
  if (sc !== undefined) return [sc, false]
  if (e.code) return undefined
  return KEY[e.key] ?? KEY[(e.key || '').toLowerCase()]
}
