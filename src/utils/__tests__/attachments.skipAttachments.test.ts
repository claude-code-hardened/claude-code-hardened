/**
 * Tests for CCH #50/#52 skipAttachments 信封位的消费面（R1-低孤儿科目）。
 *
 * 官方 Trt（docs/reverse-284/0001-chunk-xrzcaagk/
 * module-006-uncategorized.js:2116）：skipAttachments===!0 的命令不参与
 * 附件收集；官方 resume/bulk 通知均带 skipAttachments:!0。CCH 消费点 =
 * getQueuedCommandAttachments：命中即跳过图片块/粘贴 id 收集，文本本体
 * 照进上下文。
 */
import { describe, expect, test } from 'bun:test'

import { getQueuedCommandAttachments } from '../attachments.js'
import { shouldSkipAttachmentsForCommand } from '../messageQueueManager.js'

// 1x1 PNG（最小合法 base64 载荷，供对照组走真实图片收集管线）
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function imagePasteds(): Record<number, never> {
  return {
    1: {
      id: 1,
      type: 'image',
      content: TINY_PNG,
      mediaType: 'image/png',
      filename: 'tiny.png',
    } as never,
  }
}

/** queued_command 附件面（Attachment 联合类型的窄化断言形）。 */
type QueuedCommandAttachment = {
  type: 'queued_command'
  prompt: string | Array<{ type: string; text?: string }>
  imagePasteIds?: number[]
  commandMode: string
}

describe('getQueuedCommandAttachments × skipAttachments（消费面）', () => {
  test('不带 skipAttachments：图片粘贴照常收集（imagePasteIds 在场）', async () => {
    expect(
      shouldSkipAttachmentsForCommand({ mode: 'task-notification' } as never),
    ).toBe(false)
    const [att] = (await getQueuedCommandAttachments([
      {
        value:
          '<task-notification><summary>bulk x</summary></task-notification>',
        mode: 'task-notification',
        pastedContents: imagePasteds(),
      } as never,
    ])) as QueuedCommandAttachment[]
    expect(att).toBeDefined()
    expect(att!.imagePasteIds).toEqual([1])
  })

  test('skipAttachments:!0：跳过附件收集，文本本体照进上下文', async () => {
    const [att] = (await getQueuedCommandAttachments([
      {
        value:
          '<task-notification><task-id>agnt_s</task-id><status>completed</status></task-notification>',
        mode: 'task-notification',
        skipAttachments: true,
        userResumeNotice: true,
        taskId: 'agnt_s',
        pastedContents: imagePasteds(),
      } as never,
    ])) as QueuedCommandAttachment[]
    expect(att).toBeDefined()
    expect(att!.imagePasteIds).toBeUndefined()
    expect(typeof att!.prompt).toBe('string')
    expect(att!.prompt as string).toContain('agnt_s')
  })
})
