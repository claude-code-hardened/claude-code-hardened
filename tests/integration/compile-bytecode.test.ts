import { describe, expect, test } from 'bun:test'
import { resolveBytecodeEnabled } from '../../scripts/compileFlags.ts'

// Pure-function tests for the compile-time bytecode A/B switch.
// No module mocks: resolveBytecodeEnabled reads only the env object
// passed as an argument (defaulting to process.env).

describe('resolveBytecodeEnabled', () => {
  test('is disabled by default when the variable is absent', () => {
    expect(resolveBytecodeEnabled({})).toBe(false)
  })

  test('is disabled when the variable is undefined', () => {
    expect(resolveBytecodeEnabled({ CCB_COMPILE_BYTECODE: undefined })).toBe(
      false,
    )
  })

  test("is enabled by '1'", () => {
    expect(resolveBytecodeEnabled({ CCB_COMPILE_BYTECODE: '1' })).toBe(true)
  })

  test("is enabled by 'true'", () => {
    expect(resolveBytecodeEnabled({ CCB_COMPILE_BYTECODE: 'true' })).toBe(true)
  })

  test("is enabled by uppercase 'TRUE'", () => {
    expect(resolveBytecodeEnabled({ CCB_COMPILE_BYTECODE: 'TRUE' })).toBe(true)
  })

  test("is enabled by mixed-case 'True'", () => {
    expect(resolveBytecodeEnabled({ CCB_COMPILE_BYTECODE: 'True' })).toBe(true)
  })

  test("is disabled by '0'", () => {
    expect(resolveBytecodeEnabled({ CCB_COMPILE_BYTECODE: '0' })).toBe(false)
  })

  test("is disabled by 'false'", () => {
    expect(resolveBytecodeEnabled({ CCB_COMPILE_BYTECODE: 'false' })).toBe(
      false,
    )
  })

  test("is disabled by uppercase 'FALSE'", () => {
    expect(resolveBytecodeEnabled({ CCB_COMPILE_BYTECODE: 'FALSE' })).toBe(
      false,
    )
  })

  test('is disabled by empty string', () => {
    expect(resolveBytecodeEnabled({ CCB_COMPILE_BYTECODE: '' })).toBe(false)
  })

  test('is disabled by garbage strings', () => {
    for (const garbage of ['yes', '2', 'on', ' true', 'true ', '1.0']) {
      expect(
        resolveBytecodeEnabled({ CCB_COMPILE_BYTECODE: garbage }),
      ).toBe(false)
    }
  })

  test('reads process.env without mutating it', () => {
    // CI/local default: the variable is not set.
    expect(process.env.CCB_COMPILE_BYTECODE).toBeUndefined()
    expect(resolveBytecodeEnabled()).toBe(false)
    expect(process.env.CCB_COMPILE_BYTECODE).toBeUndefined()
  })
})
