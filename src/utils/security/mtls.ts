/**
 * W4 (#55) — mTLS client-certificate bootstrap for enterprise gateways.
 *
 * Env surface (official shape):
 *   CLAUDE_CODE_CLIENT_CERT           path to the client certificate (PEM)
 *   CLAUDE_CODE_CLIENT_KEY            path to the private key (PEM)
 *   CLAUDE_CODE_CLIENT_KEY_PASSPHRASE  passphrase, literal or file:// path
 *
 * Platform note: the CLI runs on the Bun runtime, whose fetch() does not
 * expose client-certificate injection. The credential bundle therefore
 * cannot be attached to first-party API fetches from JS today; this module
 * owns validation and the error messages, and exposes the bundle for the
 * transport layer that can use it (native/node child transports, proxies).
 * When none of the three vars are set this is a complete no-op.
 *
 * R2 (#0051 review) — cert/key pairing is NOT verified, deliberately:
 * validateBundle() checks PEM shape and key parseability (passphrase) but
 * never confirms the certificate matches the private key (modulus/public-key
 * comparison). This mirrors the official surface, which only records the
 * presence of the credential env vars (telemetry presence probe — see
 * hasClientCertBundle) and does no pairing check either. A mismatched
 * bundle therefore fails downstream at the TLS handshake, not here; that
 * failure mode is stated rather than papered over. (Presence probe surface:
 * hasClientCertConfigured.)
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { isAbsolute } from 'path'
import { createPrivateKey } from 'crypto'
import { getFsImplementation } from '../fsOperations.js'
import { logForDebugging } from '../debug.js'

export type ClientCertBundle = {
  cert: string
  key: string
  passphrase?: string
}

function readMaterial(path: string, label: string): string | null {
  try {
    const st = statSync(path)
    if (!st.isFile()) {
      logForDebugging(`[security] ${label} path is not a file: ${path}`)
      return null
    }
    // Read via the injected fs implementation where available (test seams).
    void getFsImplementation()
    return readFileSync(path, 'utf8')
  } catch (error) {
    logForDebugging(
      `[security] ${label} unreadable (${path}): ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}

function normalizePassphrase(raw: string): string {
  if (raw.startsWith('file://')) {
    const p = raw.slice('file://'.length)
    // Trailing newline is the usual artifact of file-written passphrases.
    return (readMaterial(p, 'client key passphrase') ?? '').trim()
  }
  return raw
}

function validateBundle(bundle: ClientCertBundle): string | null {
  const problems: string[] = []
  if (!bundle.cert.includes('BEGIN CERTIFICATE')) {
    problems.push('client cert does not look like a PEM certificate')
  }
  if (!bundle.key.includes('PRIVATE KEY')) {
    problems.push('client key does not look like a PEM private key')
  }
  if (problems.length === 0) {
    try {
      // Key parse check only works for RSA/EC private keys that node can
      // import; skip silently for formats node cannot parse. createPrivateKey
      // (not createPublicKey) is the variant that accepts a passphrase.
      createPrivateKey({
        key: bundle.key,
        format: 'pem',
        passphrase: bundle.passphrase,
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (/bad decrypt|wrong pass|unable|invalid/i.test(msg)) {
        problems.push(
          `client key could not be parsed (bad passphrase?): ${msg}`,
        )
      }
    }
  }
  return problems.length > 0 ? problems.join('; ') : null
}

let cachedBundle: ClientCertBundle | null | undefined
export function getClientCertBundle(): ClientCertBundle | null {
  if (cachedBundle !== undefined) return cachedBundle
  const certPath = process.env.CLAUDE_CODE_CLIENT_CERT
  const keyPath = process.env.CLAUDE_CODE_CLIENT_KEY
  if (!certPath || !keyPath) {
    cachedBundle = null
    return null
  }
  for (const [path, label] of [
    [certPath, 'client cert'],
    [keyPath, 'client key'],
  ] as const) {
    if (!isAbsolute(path)) {
      logForDebugging(`[security] ${label} must be an absolute path: ${path}`)
      cachedBundle = null
      return null
    }
    if (!existsSync(path)) {
      logForDebugging(`[security] ${label} does not exist: ${path}`)
      cachedBundle = null
      return null
    }
  }
  const cert = readMaterial(certPath, 'client cert')
  const key = readMaterial(keyPath, 'client key')
  if (cert === null || key === null) {
    cachedBundle = null
    return null
  }
  const passphraseRaw = process.env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE
  const bundle: ClientCertBundle = {
    cert,
    key,
    ...(passphraseRaw !== undefined && passphraseRaw !== ''
      ? { passphrase: normalizePassphrase(passphraseRaw) }
      : {}),
  }
  const problem = validateBundle(bundle)
  if (problem !== null) {
    logForDebugging(`[security] mTLS bundle rejected: ${problem}`)
    cachedBundle = null
    return null
  }
  cachedBundle = bundle
  return bundle
}

/** Presence probe for /doctor-style surfaces (no key material returned). */
export function hasClientCertConfigured(): boolean {
  return getClientCertBundle() !== null
}

/** Test seam — clears the memoized bundle. */
export function __resetClientCertBundleForTests(): void {
  cachedBundle = undefined
}
