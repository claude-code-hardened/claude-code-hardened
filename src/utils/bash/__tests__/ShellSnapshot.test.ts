import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// getClaudeConfigHomeDir() memoizes on first call — point it at a throwaway
// config root BEFORE the module under test (and its envUtils dependency) is
// imported. Must run before the dynamic import below.
const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
const configRoot = mkdtempSync(join(tmpdir(), 'ccb-snapshot-test-'))
process.env.CLAUDE_CONFIG_DIR = configRoot

const { createAndSaveSnapshot } = await import(
  'src/utils/bash/ShellSnapshot.js'
)

const snapshotsDir = join(configRoot, 'shell-snapshots')

afterAll(() => {
  if (prevConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = prevConfigDir
  }
  rmSync(configRoot, { recursive: true, force: true })
})

describe('createAndSaveSnapshot permissions', () => {
  test.skipIf(!existsSync('/bin/bash'))(
    'snapshot dir is 0700 and snapshot file is 0600',
    async () => {
      const snapshotPath = await createAndSaveSnapshot('/bin/bash')

      // Snapshot creation itself succeeded (file exists before the chmod).
      expect(snapshotPath).toBeDefined()
      const path = snapshotPath as string
      expect(existsSync(path)).toBe(true)
      // Random name untouched: timestamp + random id, still .sh.
      expect(path.startsWith(join(snapshotsDir, 'snapshot-bash-'))).toBe(
        true,
      )

      // File must be owner-read/write only.
      const fileMode = statSync(path).mode & 0o777
      expect(fileMode).toBe(0o600)

      // Directory mode: only asserted when the memoized config home really
      // is our temp root (envUtils memoization may have been seeded earlier
      // in the same test process by another file).
      if (dirname(path) === snapshotsDir) {
        const dirMode = statSync(snapshotsDir).mode & 0o777
        expect(dirMode).toBe(0o700)
      }
    },
  )
})
