import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Recovered from the official distribution's embedded native modules
// (extracted from the Bun-compiled binary). Linux-only native clipboard:
// getLinuxClipboardText / setLinuxClipboardText (X11/Wayland, no external
// tools required). Silent fallback to null on any other platform or when
// the binary is absent — callers decide their own fallback strategy.

const nodeRequire = createRequire(import.meta.url)

function getVendorRoot(): string {
  const filePath = fileURLToPath(import.meta.url)
  const dir = dirname(filePath)
  const parts = dir.split(sep)
  const distIdx = parts.lastIndexOf('dist')
  if (distIdx !== -1) {
    return parts.slice(0, distIdx + 1).join(sep) + sep + 'vendor'
  }
  return resolve(dir, '..', '..', '..', 'vendor')
}

type ClipboardNapi = {
  getLinuxClipboardText(): string
  setLinuxClipboardText(text: string): void
}

let cachedModule: ClipboardNapi | null = null
let loadAttempted = false

function platformTriple(): string | null {
  if (process.platform !== 'linux') return null
  return process.arch === 'arm64'
    ? 'aarch64-unknown-linux-gnu'
    : 'x86_64-unknown-linux-gnu'
}

function loadModule(): ClipboardNapi | null {
  if (loadAttempted) return cachedModule
  loadAttempted = true

  const triple = platformTriple()
  if (triple === null) return null

  const candidate = resolve(
    getVendorRoot(),
    'clipboard',
    triple,
    'clipboard.node',
  )
  if (!existsSync(candidate)) return null
  try {
    const mod = nodeRequire(candidate) as ClipboardNapi
    if (
      typeof mod?.getLinuxClipboardText !== 'function' ||
      typeof mod?.setLinuxClipboardText !== 'function'
    ) {
      return null
    }
    cachedModule = mod
  } catch {
    cachedModule = null
  }
  return cachedModule
}

/** True when the native Linux clipboard module is loaded. */
export function isNativeClipboardAvailable(): boolean {
  return loadModule() !== null
}

/**
 * Read the system clipboard text. Returns null when the native module is
 * unavailable or the read fails.
 */
export function getClipboardText(): string | null {
  const mod = loadModule()
  if (mod === null) return null
  try {
    const text = mod.getLinuxClipboardText()
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

/**
 * Write text to the system clipboard. Returns false when unavailable.
 */
export function setClipboardText(text: string): boolean {
  const mod = loadModule()
  if (mod === null) return false
  try {
    mod.setLinuxClipboardText(text)
    return true
  } catch {
    return false
  }
}
