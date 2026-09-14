import { registerBuiltinPlugin } from '../builtinPlugins.js'
import { buildCliLaunch } from '../../utils/cliLaunch.js'

export function registerWeixinBuiltinPlugin(): void {
  const launch = buildCliLaunch(['weixin', 'serve'])

  registerBuiltinPlugin({
    name: 'weixin',
    description:
      'WeChat channel integration. Enables inbound WeChat messages via channels and provides reply/send_typing MCP tools. Configure with `ccb weixin login` and enable for a session with `--channels plugin:weixin@builtin`.',
    version: MACRO.VERSION,
    // 默认关闭（用户裁定 2026-09-15）：weixin serve 需要微信通道配置才
    // 有意义，默认开启会让每次启动都 spawn MCP server——未配置环境
    // （proot/无网络）连接失败拖慢启动 50-72s。按需启用：
    // --channels plugin:weixin@builtin 或 settings 显式开启。
    defaultEnabled: false,
    mcpServers: {
      weixin: {
        type: 'stdio',
        command: launch.execPath,
        args: launch.args,
      },
    },
  })
}
