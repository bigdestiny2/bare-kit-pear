'use strict'

/**
 * Integrity helpers for pinning the hash of downloaded / mirrored binaries.
 *
 * Pure node — built-ins only (fs/promises + crypto). Exports:
 *   hashFile(absPath) → hex SHA-256 of a file
 *   hashDirectory(absPath) → SHA-256 over deterministic serialization of tree
 *   hashXcframework(absPath) → thin wrapper around hashDirectory
 *   verifyFile(absPath, expectedSha) → { ok, actual, expected }
 *
 * Directory hashing format (deterministic across macOS/Linux):
 *   Walk depth-first, sort each directory's entries by name, skip symlinks,
 *   skip .DS_Store. For every file encountered, append to the running hash:
 *
 *       <posix-relative-path>\0<hex-sha256-of-file>\0
 *
 *   Nothing else. No sizes, no mode bits, no directory markers — just the
 *   concatenation of (path, fileHash) pairs. Stable, reproducible.
 */

const crypto = require('crypto')
const fs = require('fs/promises')
const path = require('path')

const SKIP_NAMES = new Set(['.DS_Store'])

async function hashFile (absPath) {
  const buf = await fs.readFile(absPath)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

async function walkFiles (root) {
  const out = []
  async function visit (dirAbs, relDir) {
    const entries = await fs.readdir(dirAbs, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const ent of entries) {
      if (SKIP_NAMES.has(ent.name)) continue
      // Skip symlinks entirely — never follow, never record. xcframeworks
      // from the known-good sources don't contain symlinks; any found would
      // be a surprise worth failing visibly instead of silently hashing.
      if (ent.isSymbolicLink()) continue
      const abs = path.join(dirAbs, ent.name)
      const rel = relDir ? relDir + '/' + ent.name : ent.name
      if (ent.isDirectory()) {
        await visit(abs, rel)
      } else if (ent.isFile()) {
        out.push({ rel, abs })
      }
      // Other types (sockets, fifos, devices) are ignored — not expected
      // inside an xcframework.
    }
  }
  await visit(root, '')
  return out
}

async function hashDirectory (absPath) {
  const files = await walkFiles(absPath)
  const h = crypto.createHash('sha256')
  for (const f of files) {
    const fileHash = await hashFile(f.abs)
    h.update(f.rel)
    h.update('\0')
    h.update(fileHash)
    h.update('\0')
  }
  return h.digest('hex')
}

async function hashXcframework (absPath) {
  return hashDirectory(absPath)
}

async function verifyFile (absPath, expectedSha) {
  const actual = await hashFile(absPath)
  return {
    ok: actual === expectedSha,
    actual,
    expected: expectedSha
  }
}

module.exports = {
  hashFile,
  hashDirectory,
  hashXcframework,
  verifyFile
}
