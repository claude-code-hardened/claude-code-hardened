import { Box, type BoxProps } from './Box.js';

/**
 * 官方 Decorative 组件（2.1.283 导出面）——纯装饰容器：
 * 无交互语义（pointer-events 屏蔽 + aria-hidden 惯例），布局行为同 Box。
 * minified 原文未能独立定位——按官方组件族（BaseBox 变体）契约实现。
 */
export function Decorative(props: BoxProps): React.ReactNode {
  return (
    <Box
      {...props}
      /* 装饰语义：交互穿透 */
      pointerEvents="none"
    />
  );
}
