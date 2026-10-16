//! search-napi — CCH 进程内搜索 crate：rg 基座 + bfs 语义 find + ug 语义桥。
//!
//! 设计参考：omp crates/pi-natives/src/grep.rs（管道分层/心跳取消/自适应分派）。
//! v1 契约（冻结）：grepSearch / findGlob / searchCancel / isNativeSearch。
//! 流式 onMatches 留 v1.1（TSFN 首例后置）。

mod find;
mod grep;
mod heart;
mod sanitize;
mod types;
mod walk;

pub use find::*;
pub use grep::*;
pub use heart::*;
pub use types::*;

use napi::{bindgen_prelude::AsyncTask, Env, Error, Result, Task};
use napi_derive::napi;

/// 进程内是否具备原生搜索能力（wrapper validate 探针）。
#[napi]
pub fn is_native_search() -> bool {
	true
}

/// grepSearch 的 libuv 异步任务体：compute 在线程池跑 grep_search_sync，
/// 取消语义在 heart（TS abortSignal → searchCancel() 推进 CANCEL_GEN，
/// 管道每文件查 SearchToken::cancelled() 尽快返回；timeout_ms 双保险）。
/// v1 冻结契约（文件头）：错误以 Err(String) 出面 → JS 侧 reject。
pub struct GrepSearchTask(Option<GrepOptions>);

impl Task for GrepSearchTask {
	type Output = GrepResult;
	type JsValue = GrepResult;

	fn compute(&mut self) -> Result<Self::Output> {
		let opts = self
			.0
			.take()
			.ok_or_else(|| Error::from_reason("search task must not be reused"))?;
		grep_search_sync(opts).map_err(Error::from_reason)
	}

	fn resolve(&mut self, _env: Env, output: GrepResult) -> Result<Self::JsValue> {
		Ok(output)
	}
}

/// grepSearch —— 返回 Promise<GrepResult>（napi typegen：AsyncTask\<T\> → Promise）。
#[napi]
pub fn grep_search(opts: GrepOptions) -> AsyncTask<GrepSearchTask> {
	AsyncTask::new(GrepSearchTask(Some(opts)))
}

/// findGlob 的 libuv 异步任务体（bfs 语义文件发现，
/// `rg --files --glob --sort=modified --no-ignore --hidden`）。
pub struct FindGlobTask(Option<GlobOptions>);

impl Task for FindGlobTask {
	type Output = Vec<String>;
	type JsValue = Vec<String>;

	fn compute(&mut self) -> Result<Self::Output> {
		let opts = self
			.0
			.take()
			.ok_or_else(|| Error::from_reason("search task must not be reused"))?;
		find_glob_sync(opts).map_err(Error::from_reason)
	}

	fn resolve(&mut self, _env: Env, output: Vec<String>) -> Result<Self::JsValue> {
		Ok(output)
	}
}

/// findGlob —— 返回 Promise<string[]>。
#[napi]
pub fn find_glob(opts: GlobOptions) -> AsyncTask<FindGlobTask> {
	AsyncTask::new(FindGlobTask(Some(opts)))
}
