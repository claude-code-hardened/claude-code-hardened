/**
 * Tests for the CCH #52/#50/#46 passive gate in UserAgentNotificationMessage.
 *
 * Headless-safe：不做 Ink 渲染，直接以 props 调用函数组件——
 * passive 标记（官方复活通知 userResumeNotice 的 CCH 信使文本形态）判定
 * 在 extractTag 之前，命中即返回 null（静默不弹提示，消息本体照常投递）。
 */
import { describe, expect, test } from 'bun:test';

import { UserAgentNotificationMessage } from '../UserAgentNotificationMessage.js';

const passiveNotice = [
  '<task-notification passive="true">',
  '<task-id>agnt_p1</task-id>',
  '<summary>The agent "scout" was resumed by the user</summary>',
  '<note>The user resumed this agent from its transcript view; it is running again.</note>',
  '</task-notification>',
].join('\n');

const activeNotice = [
  '<task-notification>',
  '<task-id>agnt_p2</task-id>',
  '<status>completed</status>',
  '<summary>Agent "scout" completed</summary>',
  '</task-notification>',
].join('\n');

function render(text: string): unknown {
  return UserAgentNotificationMessage({
    addMargin: false,
    param: { type: 'text', text },
  } as never);
}

describe('UserAgentNotificationMessage passive gate', () => {
  test('passive 标记 → 静默（null）', () => {
    expect(render(passiveNotice)).toBeNull();
  });

  test('无 passive 标记 → 正常渲染（非 null）', () => {
    expect(render(activeNotice)).not.toBeNull();
  });

  test('缺 summary 的普通通知 → 依旧 null（原有短路保持）', () => {
    expect(render('<task-notification><task-id>agnt_p3</task-id></task-notification>')).toBeNull();
  });
});
