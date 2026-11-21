// Munder's terminal palettes, copied verbatim from the fork's PtyTerminalView so an agent's session
// reads the same in both apps. xterm takes literal colours and cannot read CSS variables.

export type PtyTheme = 'light' | 'dark';

// Light theme: cream paper. ANSI "white"/"yellow" and the bright slots are remapped to readable
// dark inks; `minimumContrastRatio` in the pool keeps coloured cells legible on top of that.
const lightTheme = {
  background: '#FCFAF0',
  foreground: '#1A1320',
  cursor: '#FFC24B',
  cursorAccent: '#FCFAF0',
  selectionBackground: '#FFEC99',
  selectionForeground: '#1A1320',
  black:        '#1A1320',
  red:          '#D1453B',
  green:        '#20904B',
  yellow:       '#9C6B00',
  blue:         '#2B6CB0',
  magenta:      '#8A5CF0',
  cyan:         '#1F9C94',
  white:        '#3A2F44',
  brightBlack:  '#6B5878',
  brightRed:    '#E0584E',
  brightGreen:  '#2E9E54',
  brightYellow: '#B8860B',
  brightBlue:   '#3B7DC4',
  brightMagenta:'#9B72F2',
  brightCyan:   '#2BA89F',
  brightWhite:  '#1A1320'
};

// Dark theme: muted-professional ANSI, brights one legible step up.
const darkTheme = {
  background: '#1A1A1F',
  foreground: '#DEDBD6',
  cursor: '#FFC24B',
  cursorAccent: '#1A1A1F',
  selectionBackground: '#37363F',
  selectionForeground: '#DEDBD6',
  black:        '#222229',
  red:          '#E08C82',
  green:        '#74C096',
  yellow:       '#CFAA57',
  blue:         '#6FB3C4',
  magenta:      '#A896E3',
  cyan:         '#6FB3C4',
  white:        '#DEDBD6',
  brightBlack:  '#96919F',
  brightRed:    '#EBA39C',
  brightGreen:  '#96CDA9',
  brightYellow: '#E5C87E',
  brightBlue:   '#8FC5D1',
  brightMagenta:'#C0B3EB',
  brightCyan:   '#8FC5D1',
  brightWhite:  '#EFEDE9'
};

export const TERMINAL_THEMES: Record<PtyTheme, typeof lightTheme> = { light: lightTheme, dark: darkTheme };


function sideAgentPalette(dark: boolean): typeof lightTheme {
  const background = dark ? '#0a0a0a' : '#ffffff';
  const foreground = dark ? '#ffffff' : '#0a0a0a';
  const muted = dark ? '#a3a3a3' : '#525252';
  const yellow = dark ? '#ffc24b' : '#a16207';
  return {
    background, foreground, cursor: yellow, cursorAccent: background,
    selectionBackground: '#ffc24b', selectionForeground: '#0a0a0a',
    black: background, red: yellow, green: foreground, yellow, blue: muted,
    magenta: muted, cyan: muted, white: foreground,
    brightBlack: muted, brightRed: yellow, brightGreen: foreground,
    brightYellow: yellow, brightBlue: muted, brightMagenta: muted,
    brightCyan: muted, brightWhite: foreground,
  };
}

export const SIDE_AGENT_TERMINAL_THEMES: typeof TERMINAL_THEMES = {
  light: sideAgentPalette(false),
  dark: sideAgentPalette(true),
};
