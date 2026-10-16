//! 取消/超时心跳：会话级搜索令牌（omp CancelToken 的 std 化，无 tokio）。
//!
//! TS 侧契约：abortSignal → mod.searchCancel(key)（专属取消位）；
//! timeout_ms 双保险；管道每文件/每 batch 调 `SearchToken::cancelled()` 检查。
//!
//! v2 语义（CancelRegistry）：并发搜索互不踩踏——每个会话可携带专属 key，
//! `searchCancel(Some(key))` 只杀该 key 的会话；`searchCancel(None)` 推进
//! 全局代际（无 key 探针/旧调用的兼容面，v1 行为原样保留）。专属会话只受
//! 本 key 位与 deadline 管辖，跨会话互杀与全局代际推进均不波及。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};

use napi_derive::napi;

/// 0=空闲 1=有活动搜索
static ACTIVE: AtomicU8 = AtomicU8::new(0);
/// 无 key 会话的全局取消代：searchCancel(None) 推进；activate 只快照。
static CANCEL_GEN: AtomicU64 = AtomicU64::new(0);
/// 专属取消位注册表（CancelRegistry）：key → per-session flag。
/// 会话结束（deactivate）即摘除条目；`Mutex<Option<..>>` 仅为 const 构造。
static REGISTRY: Mutex<Option<HashMap<String, Arc<AtomicBool>>>> = Mutex::new(None);

fn registry() -> std::sync::MutexGuard<'static, Option<HashMap<String, Arc<AtomicBool>>>> {
	REGISTRY.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 活动搜索会话的令牌：有 key 挂专属取消位（槽位），无 key 快照全局代。
/// 并发会话互不失效（grepSearch/findGlob 是独立 AsyncTask；晚启动的搜索
/// 不算取消）；专属位与 deadline 是仅有的两个取消源。
#[derive(Clone)]
pub struct SearchToken {
	/// 专属取消位（`key: Some` 会话持有）；`None` = 全局代际快照（兼容面）。
	slot: Option<Arc<AtomicBool>>,
	key: Option<String>,
	global_gen: u64,
	deadline_ms: Option<std::time::Instant>,
}

impl SearchToken {
	pub fn activate(key: Option<String>, timeout_ms: Option<u32>) -> Self {
		ACTIVE.store(1, Ordering::SeqCst);
		let mut reg = registry();
		// 专属位：会话激活时确保持有本 key 的槽位（不存在则建——防御
		// searchCancel(key) 竞态先于 activate 到达的丢杀面）。
		let slot = key.as_ref().map(|k| {
			let map = reg.get_or_insert_with(HashMap::new);
			map.entry(k.clone()).or_default().clone()
		});
		Self {
			slot,
			key,
			global_gen: CANCEL_GEN.load(Ordering::SeqCst),
			deadline_ms: timeout_ms.map(|ms| {
				std::time::Instant::now() + std::time::Duration::from_millis(ms as u64)
			}),
		}
	}

	pub fn cancelled(&self) -> bool {
		match &self.slot {
			// 专属会话：只受本 key 位管辖（跨会话/全局代际互不踩踏）。
			Some(slot) => {
				if slot.load(Ordering::SeqCst) {
					return true; // searchCancel(key) 已显式取消
				}
			},
			None => {
				if self.global_gen != CANCEL_GEN.load(Ordering::SeqCst) {
					return true; // searchCancel()（旧探针用法）已显式取消
				}
			},
		}
		match self.deadline_ms {
			Some(deadline) => std::time::Instant::now() >= deadline,
			None => false,
		}
	}

	pub fn deactivate(&self) {
		if let Some(key) = &self.key
			&& let Some(map) = registry().as_mut()
		{
			map.remove(key);
		}
		ACTIVE.store(0, Ordering::SeqCst);
	}
}

/// TS abortSignal → searchCancel(key)：取消当前进行中的搜索。
/// 有 key 只杀该 key 的会话（会话粒度互不踩踏）；无 key 回退 v1 全局代际。
#[napi]
pub fn search_cancel(key: Option<String>) {
	match key {
		Some(k) => {
			if let Some(flag) = registry().as_ref().and_then(|map| map.get(&k)) {
				flag.store(true, Ordering::SeqCst);
			}
		},
		None => {
			CANCEL_GEN.fetch_add(1, Ordering::SeqCst);
		},
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// B 会话的专属取消不得杀掉 A 会话（评审实证的跨会话互踩 bug）。
	#[test]
	fn keyed_cancel_scopes_to_own_session() {
		let a = SearchToken::activate(Some("session-a".into()), None);
		let b = SearchToken::activate(Some("session-b".into()), None);
		search_cancel(Some("session-b".into()));
		assert!(b.cancelled(), "B 只杀自己");
		assert!(!a.cancelled(), "A 不被 B 的专属取消波及");
		a.deactivate();
		b.deactivate();
	}

	/// 专属会话不吃全局代际；无 key 探针会话仍被全局代际取消（v1 兼容）。
	#[test]
	fn global_cancel_hits_global_fallback_only() {
		let keyed = SearchToken::activate(Some("keyed".into()), None);
		let legacy = SearchToken::activate(None, None);
		search_cancel(None); // 旧契约无 key 用法
		assert!(legacy.cancelled(), "无 key 会话被全局代际取消");
		assert!(!keyed.cancelled(), "专属会话不被无 key 全局取消波及");
		keyed.deactivate();
		legacy.deactivate();
	}

	/// deadline=0 即刻取消面（timeout_ms 双保险原样保留）。
	#[test]
	fn timeout_deadline_still_cancels() {
		let token = SearchToken::activate(Some("t".into()), Some(0));
		assert!(token.cancelled(), "deadline=0 即刻取消");
		token.deactivate();
	}
}
