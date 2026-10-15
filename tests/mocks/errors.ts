/**
 * Shared partial mock for src/utils/errors.ts.
 *
 * WHY: the AgentTool test files (agentToolUtils.test.ts and
 * spawnWindowCleanup.test.ts) both need src/utils/errors.ts mocked, each with
 * a different factory — a 17-export version vs a 4-export version. Bun's
 * mock.module is process-global (last-write-wins), so whichever file ran last
 * silently shrank the module for everyone after it (CI log
 * /tmp/test1c.log:2771, 2790, 2812, 2831, 2850 — the whole AgentTool double
 * file group went red in one CI pass).
 *
 * Both files must register THIS factory so the mock shape is identical no
 * matter which file executes first.
 */
export function errorsMock() {
  return {
    ClaudeError: class extends Error {},
    MalformedCommandError: class extends Error {},
    AbortError: class extends Error {},
    ConfigParseError: class extends Error {},
    ShellError: class extends Error {},
    TeleportOperationError: class extends Error {},
    TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS: class extends Error {},
    isAbortError: () => false,
    hasExactErrorMessage: () => false,
    toError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
    errorMessage: (e: unknown) => String(e),
    getErrnoCode: () => undefined,
    isENOENT: () => false,
    getErrnoPath: () => undefined,
    shortErrorStack: () => '',
    isFsInaccessible: () => false,
    classifyAxiosError: () => ({ category: 'unknown' }),
  }
}
