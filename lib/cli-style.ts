/**
 * cli-style — Shared ANSI color constants and styled output helpers.
 *
 * Consolidates the color definitions duplicated across cli/ensemble.ts,
 * cli/monitor.ts, and scripts/collab-launch.mjs into a single module.
 */

// ─────────────────────────── ANSI primitives ────────────────────────────

const ESC = '\x1b'
const CSI = `${ESC}[`

// ─────────────────────────── Color constants ────────────────────────────

/** Comprehensive ANSI color map — superset of all project usages. */
export const color = {
  // Modifiers
  reset:     `${CSI}0m`,
  bold:      `${CSI}1m`,
  dim:       `${CSI}2m`,
  italic:    `${CSI}3m`,
  underline: `${CSI}4m`,

  // Foreground
  black:   `${CSI}30m`,
  red:     `${CSI}31m`,
  green:   `${CSI}32m`,
  yellow:  `${CSI}33m`,
  blue:    `${CSI}34m`,
  magenta: `${CSI}35m`,
  cyan:    `${CSI}36m`,
  white:   `${CSI}37m`,
  gray:    `${CSI}90m`,

  // Bright foreground
  brightRed:     `${CSI}91m`,
  brightGreen:   `${CSI}92m`,
  brightYellow:  `${CSI}93m`,
  brightBlue:    `${CSI}94m`,
  brightMagenta: `${CSI}95m`,
  brightCyan:    `${CSI}96m`,
  brightWhite:   `${CSI}97m`,

  // Background
  bgBlack:      `${CSI}40m`,
  bgRed:        `${CSI}41m`,
  bgGreen:      `${CSI}42m`,
  bgYellow:     `${CSI}43m`,
  bgBlue:       `${CSI}44m`,
  bgMagenta:    `${CSI}45m`,
  bgCyan:       `${CSI}46m`,
  bgWhite:      `${CSI}47m`,
  bgGray:       `${CSI}100m`,
  bgBrightBlue: `${CSI}104m`,
} as const

// ─────────────────────────── Styled helpers ─────────────────────────────

/**
 * Logs a line with a styled icon prefix.
 *
 * @example styledLog('\u2713', 'Server started')   //  ✓ Server started
 * @example styledLog('\u2717', 'Port conflict')    //  ✗ Port conflict
 */
export function styledLog(icon: string, message: string): void {
  console.log(`  ${color.brightGreen}${icon}${color.reset} ${message}`)
}

/**
 * Returns the branded `◈ agent-forge` header string.
 *
 * @example console.log(styledHeader('agent-forge'))
 */
export function styledHeader(title: string): string {
  return `\n  ${color.brightCyan}\u25C8 ${color.bold}${title}${color.reset}`
}

/**
 * Returns a spinner-style status string (static, does not animate).
 *
 * @example console.log(styledSpinner('Waiting for agents...'))
 */
export function styledSpinner(message: string): string {
  return `  ${color.cyan}\u25CF${color.reset} ${message}`
}

/**
 * Returns a key-value status line for aligned output blocks.
 *
 * @example console.log(styledStatus('Port', '23000'))
 *          //    Port  23000
 */
export function styledStatus(label: string, value: string): string {
  return `    ${color.dim}${label}${color.reset}  ${value}`
}
