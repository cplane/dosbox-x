/**
 * How the text screen is drawn. "dos" reproduces the VGA output pixel for
 * pixel from the font the box sends; a styled renderer draws the same cells
 * with a web font and a colour theme instead (see textmode.ts). Styles are
 * data, so more can be added here without touching the renderer.
 */

export interface TextStyle {
  id: string
  label: string
  /** CSS font family list for the styled renderer; undefined = the VGA font. */
  font?: string
  /** Font size in CSS pixels (scaled by devicePixelRatio when drawing). */
  size?: number
  /** The 16 DOS attribute colours (black, blue, green, cyan, red, magenta, brown, light grey, then bright). */
  colors?: string[]
  /** Width:height of the cell as drawn, when the font's own metrics shouldn't decide. */
  lineHeight?: number
}

export const DOS_STYLE: TextStyle = { id: 'dos', label: 'DOS (VGA font)' }

/** A web monospace font with the Nord palette: easy on the eyes, still 16 colours. */
export const MODERN_STYLE: TextStyle = {
  id: 'modern',
  label: 'Modern (JetBrains Mono, Nord)',
  font: '"JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',
  size: 17,
  lineHeight: 1.3,
  colors: [
    '#2e3440', '#3b4f7a', '#8fa876', '#6f9fb0', '#a6555d', '#9d7aa0', '#c0845f', '#c5cdd9',
    '#4c566a', '#81a1c1', '#a3be8c', '#88c0d0', '#bf616a', '#b48ead', '#ebcb8b', '#eceff4',
  ],
}

/** A light theme for daylight: Solarized-ish on paper. */
export const PAPER_STYLE: TextStyle = {
  id: 'paper',
  label: 'Paper (light)',
  font: '"JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',
  size: 17,
  lineHeight: 1.3,
  colors: [
    '#fdf6e3', '#4f6fa8', '#859900', '#2aa198', '#dc322f', '#d33682', '#b58900', '#586e75',
    '#93a1a1', '#268bd2', '#5fa600', '#2bb3a5', '#e5484d', '#d85fa0', '#c9a000', '#073642',
  ],
}

export const TEXT_STYLES: TextStyle[] = [DOS_STYLE, MODERN_STYLE, PAPER_STYLE]

const STORAGE_KEY = 'dosbox.textStyle'

export function loadTextStyle(): TextStyle {
  try {
    const id = localStorage.getItem(STORAGE_KEY)
    return TEXT_STYLES.find((s) => s.id === id) ?? DOS_STYLE
  } catch {
    return DOS_STYLE
  }
}

export function saveTextStyle(s: TextStyle) {
  try { localStorage.setItem(STORAGE_KEY, s.id) } catch { /* private mode */ }
}

/** Resolves once the style's web font is usable (or at once for the VGA font). */
export function fontReady(s: TextStyle): Promise<void> {
  if (!s.font || !('fonts' in document)) return Promise.resolve()
  return document.fonts.load(`${s.size ?? 16}px ${s.font}`).then(() => undefined, () => undefined)
}

/**
 * CP437 as Unicode: the DOS glyphs for 00-1F (☺ ► ↑ …), ASCII, the
 * accented letters, box drawing and the Greek/maths block. (Other codepages
 * the box may load are shown through this table too for now.)
 */
export const CP437 =
  ' ☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼' +
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂' +
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
  'áíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '
