'use strict'

/**
 * Tiny log helper. Prefixes every line with [bare-kit-pear:<tag>] so
 * output interleaved from parallel npm scripts stays legible.
 */
function make (tag) {
  const prefix = `[bare-kit-pear:${tag}]`
  return {
    info: (msg) => console.log(`${prefix} ${msg}`),
    warn: (msg) => console.warn(`${prefix} ⚠ ${msg}`),
    error: (msg) => console.error(`${prefix} ${msg}`),
    bail: (msg, code = 1) => {
      console.error(`${prefix} ${msg}`)
      process.exit(code)
    }
  }
}

module.exports = { make }
