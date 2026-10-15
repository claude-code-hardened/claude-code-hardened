/**
 * prepare-commit-msg hook installer — intentionally a no-op stub.
 *
 * ⚠ 官方语义待考，防止误造提交信息行为：该函数会写 git hook 文件，
 * 直接影响用户仓库中的提交流程。反编译语料中唯一的 prepare-commit-msg
 * 实体（docs/reverse-284/decompiled/0329-chunk-6s4zx6py/
 * module-005-uncategorized.js:57,87）属于 runner 沙箱的 `.runner/git-hooks`
 * 透传脚本，并非 Claude Code 的 attribution hook 安装逻辑；官方
 * attribution 模块（0054-chunk module-004:923）仅见 `armedTrailerFiles`
 * 状态字段，hook 脚本内容与安装条件不可 1:1 对齐。按"宁可少做不可做错"
 * 规约保持 noop；恢复实现前不得向用户仓库写入任何 hook 文件。
 *
 * Caller: src/utils/worktree.ts:606 — EnterWorktree 时对 worktree 安装
 * attribution 提交钩子（COMMIT_ATTRIBUTION feature）；调用方自带
 * import 失败与 promise 拒绝的兜底日志，noop 安全。
 */
export const installPrepareCommitMsgHook: (
  worktreePath: string,
  worktreeHooksDir?: string,
) => Promise<void> = async () => {}
