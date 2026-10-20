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
  /** Cell height as a multiple of the font's line box (1 = box-drawing glyphs join exactly). */
  lineHeight?: number
}

export const DOS_STYLE: TextStyle = { id: 'dos', label: 'DOS (VGA font)' }

/** A web monospace font with the Nord palette: easy on the eyes, still 16 colours. */
export const MODERN_STYLE: TextStyle = {
  id: 'modern',
  label: 'Modern (JetBrains Mono, Nord)',
  font: '"JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',
  size: 17,
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

/**
 * FNV-1a of each glyph (16 scanlines) of the VGA ROM font for CP437, as
 * DOSBox-X publishes it at boot. A cell whose glyph differs from this is
 * one the program redefined (Norton Commander 5 draws its 3-D frame with
 * reshaped box characters, for instance): the styled renderer then draws
 * the bitmap itself instead of the Unicode glyph the code would map to.
 */
export const ROM_FONT_HASH: number[] = [
  1768495365, 1325033053, 1757013733, 2580767797, 3912087915, 8073704, 2650263343, 442629629, 2155480845, 639928981, 470056469, 2130147333, 2676528795, 464460448, 2830082796, 3439214208,
  3995393931, 3036686699, 3573864765, 295708515, 113252671, 164986185, 796335877, 246384451, 3184789823, 3943096567, 3953205963, 4158547995, 603689531, 785106699, 3980591069, 4267401645,
  1768495365, 3108272041, 3122790983, 3455409617, 1834403077, 3882102421, 3716986941, 1046881749, 1147720781, 2906178109, 2745371680, 1834346315, 3513921101, 2382316027, 2169706213, 2437158517,
  3885671181, 3013384051, 656907245, 3596388103, 3926453053, 1586528419, 1114382629, 2841228041, 1040379527, 3977094787, 1468830197, 3977778629, 523938101, 3075152901, 2643473459, 3031386661,
  3681786079, 4132089391, 2142288231, 889854693, 1198331373, 365906149, 1941181511, 3107810631, 1265551853, 178882621, 1095863795, 3256215245, 798281559, 1933222637, 998229597, 1586833853,
  2665262435, 1430630071, 259384727, 203481559, 2032052475, 2498718503, 2876308367, 2806244743, 1817948693, 2562295325, 1323213317, 2242224829, 1006815571, 3794208861, 873601559, 2658331312,
  2488950861, 2098146071, 152872613, 1811130133, 491492719, 3349617067, 1470638285, 2993730891, 3836905697, 631541393, 3731419463, 3439053915, 838151513, 2781877337, 3411719201, 1711974771,
  99750339, 4178601021, 1774016481, 2042975993, 3629284307, 2808406219, 1578288471, 2454295785, 3033778333, 28616433, 91808455, 613916381, 2824592845, 1155446947, 4239717335, 574464409,
  3919899235, 3548237399, 698760407, 3035682123, 2206625675, 772573679, 1593821963, 3323578731, 1940029783, 3172385341, 2731290323, 742534231, 2328742659, 930128665, 3050143559, 77949621,
  1599271961, 3474505089, 2640728055, 1785024879, 531438501, 3660214731, 1935322967, 3059741315, 1726526839, 432671733, 35894679, 4284043237, 234711183, 1719278417, 2631222193, 2602723118,
  2991505855, 3701297645, 3991242235, 89540691, 1456456403, 342589753, 1551952873, 2071535361, 2296564625, 3153772923, 2834166619, 764411989, 1747130493, 3385853857, 4147626445, 3423247139,
  3549889765, 3912708917, 163808069, 1337570565, 489835749, 4029586053, 1389178949, 2778668795, 253218557, 584620245, 1547467269, 2956138763, 2490485741, 1957893341, 1341533317, 167023021,
  3330539616, 2482804800, 3198621512, 3677938720, 1823899912, 2830203904, 999090573, 2405218818, 2914272035, 466760853, 2845611411, 2532856869, 3482986427, 851238333, 456509611, 1609487029,
  1399477226, 299689917, 2381421304, 1557765546, 2269912973, 4131370053, 2539709624, 3052057434, 933320077, 2096750309, 4046356328, 906459637, 1461544960, 3812783109, 3335507605, 3944084752,
  2509722013, 3601820975, 4212243243, 2694226551, 678545949, 2733341411, 3779795495, 3070538983, 1650835571, 3089171259, 3395074289, 1958648493, 2929111032, 1105962067, 2702983745, 4169603841,
  2432403451, 2373723570, 2157942253, 2046398059, 1059898421, 4267751549, 2849336971, 3475384365, 2715159917, 1933977813, 713688093, 308781416, 2532898865, 3169347917, 2583939745, 1768495365,
]

/** FNV-1a of glyph ch in a font of cellH scanlines per glyph. */
export function glyphHash(font: Uint8Array, ch: number, cellH: number): number {
  let h = 0x811c9dc5
  for (let i = 0; i < cellH; i++) { h ^= font[ch * cellH + i]; h = Math.imul(h, 0x01000193) >>> 0 }
  return h
}
