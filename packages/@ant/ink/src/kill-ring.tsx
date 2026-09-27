import { createContext, useContext, useMemo, type ReactNode } from 'react';

/**
 * KillRing —— 官方 ink 的输入剪贴板环（binary @152674000-152679000 区段，
 * minified 原文反混淆）。
 *
 * 官方错误契约（原文）：useKillRing cannot be called outside of a
 * <KillRingProvider /> (mounted around every Ink root by src/ink.ts)
 *
 * 模块结构（原文实证）：
 *   Wvn  createKillRingStore —— { get state, dispatch }（reducer 环状 yank）
 *   VJe  KillRingProvider    —— 外部 handle 注入优先，否则默认工厂
 *   __t  useKillRing         —— Context 必需
 *   pqt/fqt                   —— yank/yank-pop 类动作（action creator）
 *
 * state 形状（(mode.index+1)%ring.length 反推）：
 *   { ring: string[], mode: { index: number, start: number, length: number } }
 */

export interface KillRingMode {
  /** 当前 yank 环位置。 */
  index: number;
  /** 插入起点（列）。 */
  start: number;
  /** 插入长度。 */
  length: number;
}

export interface KillRingState {
  ring: string[];
  mode: KillRingMode;
}

export interface KillRingAction {
  type: 'push' | 'yank' | 'yankPop' | 'reset';
  text?: string;
  start?: number;
  length?: number;
}

export interface KillRingStore {
  readonly state: KillRingState;
  dispatch: (action: KillRingAction) => void;
}

/** 官方 h：reducer——环状 yank 语义。 */
function killRingReducer(state: KillRingState, action: KillRingAction): KillRingState {
  switch (action.type) {
    case 'push': {
      const text = action.text ?? '';
      if (!text || text === state.ring[0]) return state;
      const ring = [text, ...state.ring].slice(0, 32);
      return { ring, mode: { index: 0, start: action.start ?? 0, length: action.length ?? 0 } };
    }
    case 'yank': {
      return { ...state, mode: { index: 0, start: action.start ?? 0, length: action.length ?? 0 } };
    }
    case 'yankPop': {
      // 官方原文：(mode.index+1)%ring.length
      const index = state.ring.length > 0 ? (state.mode.index + 1) % state.ring.length : 0;
      return { ...state, mode: { ...state.mode, index } };
    }
    case 'reset':
    default:
      return { ring: [], mode: { index: 0, start: 0, length: 0 } };
  }
}

const INITIAL: KillRingState = { ring: [], mode: { index: 0, start: 0, length: 0 } };

/** 官方 Wvn：createKillRingStore。 */
export function createKillRingStore(initialState: KillRingState = INITIAL): KillRingStore {
  let current = initialState;
  return {
    get state() {
      return current;
    },
    dispatch(action: KillRingAction) {
      current = killRingReducer(current, action);
    },
  };
}

/** 官方 yank 结果：按 mode 取环内文本。 */
export function yankResult(state: KillRingState): { text: string; start: number; length: number } {
  const i = state.mode.index;
  return { text: state.ring[i] ?? '', start: state.mode.start, length: state.mode.length };
}

const KillRingContext = createContext<KillRingStore | undefined>(undefined);

/** 官方 VJe：KillRingProvider——外部 handle 注入优先，否则默认工厂。 */
export function KillRingProvider({ handle, children }: { handle?: KillRingStore; children: ReactNode }): ReactNode {
  const fallback = useMemo(() => createKillRingStore(), []);
  const store = handle ?? fallback;
  return <KillRingContext.Provider value={store}>{children}</KillRingContext.Provider>;
}

/** 官方 __t：useKillRing——Context 必需（错误契约原文）。 */
export function useKillRing(): KillRingStore {
  const store = useContext(KillRingContext);
  if (!store) {
    throw new ReferenceError(
      'useKillRing cannot be called outside of a <KillRingProvider /> (mounted around every Ink root by src/ink.ts)',
    );
  }
  return store;
}
