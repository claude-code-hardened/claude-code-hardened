//! 取消/超时心跳：进程级搜索令牌（omp CancelToken 的 std 化，无 tokio）。
//!
//! TS 侧契约：abortSignal → mod.searchCancel()；timeout_ms 双保险。
//! 管道每文件/每 batch 调 `SearchToken::cancelled()` 检查。

use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};

use napi_derive::napi;

/// 0=空闲 1=有活动搜索
static ACTIVE: AtomicU8 = AtomicU8::new(0);
/// 显式取消代：searchCancel()（TS abortSignal）推进；activate 只快照。
static CANCEL_GEN: AtomicU64 = AtomicU64::new(0);

/// 活动搜索会话的令牌：持有激活时的取消代数，此后显式取消即失效。
/// 并发搜索互不失效（grepSearch/findGlob 是独立 AsyncTask；lib v1 契约只把
/// 取消语义接在 abortSignal → searchCancel() 上），晚启动的搜索不算取消。
#[derive(Clone, Copy)]
pub struct SearchToken {
	gen: u64,
	deadline_ms: Option<std::time::Instant>,
}

impl SearchToken {
	pub fn activate(timeout_ms: Option<u32>) -> Self {
		ACTIVE.store(1, Ordering::SeqCst);
		Self {
			gen: CANCEL_GEN.load(Ordering::SeqCst),
			deadline_ms: timeout_ms.map(|ms| {
				std::time::Instant::now() + std::time::Duration::from_millis(ms as u64)
			}),
		}
	}

	pub fn cancelled(&self) -> bool {
		if self.gen != CANCEL_GEN.load(Ordering::SeqCst) {
			return true; // search_cancel()（abortSignal）已显式取消
		}
		match self.deadline_ms {
			Some(deadline) => std::time::Instant::now() >= deadline,
			None => false,
		}
	}

	pub fn deactivate(&self) {
		ACTIVE.store(0, Ordering::SeqCst);
	}
}

/// TS abortSignal → searchCancel()：使当前进行中的搜索立即取消。
#[napi]
pub fn search_cancel() {
	CANCEL_GEN.fetch_add(1, Ordering::SeqCst);
}
