//! rg 兼容的 glob/type 归一（sanitize 层完整移植）。
//!
//! 对齐蓝本：omp crates/pi-natives/src/glob_util.rs（glob 合成、花括号补全、
//! 遍历深度界）与 omp grep.rs resolve_type_filter :545-585（内置 type 全表）。
//! BRE 桥取 ugrep -G（GNU grep BRE）兼容语义，供后续 argv0 spawn 场景，
//! v1 只落函数与测试。
//!
//! 已知边界（历史 grep 面契约）：早期 `src/grep.rs` 以单一
//! `GlobSet::is_match` 决定是否搜索，而 globset 无负 glob（v0 调用的
//! `Glob::negate`/`Glob::literal_separator` 实例方法在 0.4.x 不存在），
//! rg 的 "include ∧ ¬exclude" first-match 白/黑名单语义无法压进一个
//! GlobSet。所以旧层 `build_glob_set` 构成**正集**语义（include 模式 ⊕
//! type 合成 glob、丢弃 `!` 排除项）；完整取反语义由
//! [`GlobFilter::is_match`] 承接——find 面与迁移后的 grep 面均走
//! [`build_glob_filter`]（`build_glob_set` 降级为 cfg(test) 回归测试锚）。

use globset::{Glob, GlobBuilder, GlobSet, GlobSetBuilder};

// ---------------------------------------------------------------------------
// 内置 type 全表（omp grep.rs :552-582 蓝本）
// ---------------------------------------------------------------------------

/// rg `--type` 内置全表：别名组 →（扩展名集, 文件名集）。
/// docker/make 走文件名匹配（rg：Dockerfile*/[Mm]akefile 家族），其余按扩展名。
const TYPE_TABLE: &[(&[&str], &[&str], &[&str])] = &[
	(&["js", "javascript"], &["js", "jsx", "mjs", "cjs"], &[]),
	(&["ts", "typescript"], &["ts", "tsx", "mts", "cts"], &[]),
	(&["json"], &["json", "jsonc", "json5"], &[]),
	(&["yaml", "yml"], &["yaml", "yml"], &[]),
	(&["toml"], &["toml"], &[]),
	(&["md", "markdown"], &["md", "markdown", "mdx"], &[]),
	(&["py", "python"], &["py", "pyi"], &[]),
	(&["rs", "rust"], &["rs"], &[]),
	(&["go"], &["go"], &[]),
	(&["java"], &["java"], &[]),
	(&["kt", "kotlin"], &["kt", "kts"], &[]),
	(&["c"], &["c", "h"], &[]),
	(&["cpp", "cxx"], &["cpp", "cc", "cxx", "hpp", "hxx", "hh"], &[]),
	(&["cs", "csharp"], &["cs", "csx"], &[]),
	(&["php"], &["php", "phtml"], &[]),
	(&["rb", "ruby"], &["rb", "rake", "gemspec"], &[]),
	(&["sh", "bash"], &["sh", "bash", "zsh"], &[]),
	(&["zsh"], &["zsh"], &[]),
	(&["fish"], &["fish"], &[]),
	(&["html"], &["html", "htm"], &[]),
	(&["css"], &["css"], &[]),
	(&["scss"], &["scss"], &[]),
	(&["sass"], &["sass"], &[]),
	(&["less"], &["less"], &[]),
	(&["xml"], &["xml"], &[]),
	// 文件名匹配面（无扩展名）：Dockerfile / Makefile 家族
	(&["docker", "dockerfile"], &[], &["dockerfile"]),
	(&["make", "makefile"], &[], &["makefile"]),
];

/// 编译后的 type 过滤器：已知 type 按扩展名/文件名等值匹配，未知 type
/// 归为单一扩展名匹配（对齐 omp `TypeFilter::Custom`）。
#[derive(Clone, Debug)]
pub enum TypeFilter {
	Known {
		exts: &'static [&'static str],
		names: &'static [&'static str],
	},
	Custom(String),
}

impl TypeFilter {
	/// 扩展名等值（ASCII 大小写不敏感）。
	pub fn match_ext(&self, ext: &str) -> bool {
		match self {
			Self::Known { exts, .. } => exts.iter().any(|e| ext.eq_ignore_ascii_case(e)),
			Self::Custom(custom) => ext.eq_ignore_ascii_case(custom),
		}
	}

	/// 文件名等值（docker/make 面，ASCII 大小写不敏感）。
	pub fn match_name(&self, name: &str) -> bool {
		match self {
			Self::Known { names, .. } => names.iter().any(|n| name.eq_ignore_ascii_case(n)),
			Self::Custom(custom) => name.eq_ignore_ascii_case(custom),
		}
	}
}

/// `--type` 字段 → 过滤器；`None` 表示无 type 过滤。
/// 归一：trim、去前导 `.`、小写；未知 type 返回 [`TypeFilter::Custom`]。
pub fn resolve_type_filter(type_name: Option<&str>) -> Option<TypeFilter> {
	let normalized = type_name
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(|value| value.trim_start_matches('.').to_lowercase())?;
	for (names, exts, file_names) in TYPE_TABLE {
		if names.contains(&normalized.as_str()) {
			return Some(TypeFilter::Known { exts, names: file_names });
		}
	}
	Some(TypeFilter::Custom(normalized))
}

/// 路径（root 相对即可——恒按 basename 判定）是否落在 type 面内
/// （对齐 omp matches_type_filter：先文件名等值、再扩展名等值）。
pub fn matches_type_filter(path: &str, filter: &TypeFilter) -> bool {
	let base = path.rsplit('/').next().unwrap_or(path);
	if filter.match_name(base) {
		return true;
	}
	let ext = base.rsplit_once('.').map_or("", |(_, ext)| ext);
	!ext.is_empty() && filter.match_ext(ext)
}

// ---------------------------------------------------------------------------
// glob 合成（omp glob_util.rs 全量移植）
// ---------------------------------------------------------------------------

/// 归一化一个裸 glob：反斜杠归一为 `/`；recursive 且模式里没有 `/`
/// （也不是既带的 `**` / 精确花括号并集）时自动补 `**/` 前缀
/// （rg 的 basename-anywhere 语义）；最后补全未闭合的 `{`。
pub fn build_glob_pattern(glob: &str, recursive: bool) -> String {
	let normalized = glob.replace('\\', "/");
	let pattern = if !recursive
		|| normalized.contains('/')
		|| normalized.starts_with("**")
		|| is_exact_brace_union(&normalized)
	{
		normalized
	} else {
		format!("**/{normalized}")
	};
	fix_unclosed_braces(pattern)
}

/// 归一化模式的遍历深度界（bfs -maxdepth 等位），`usize::MAX` = 不设界。
///
/// 编译启用 `literal_separator(true)`，故 `*`/`?`/`[…]` 不跨 `/`：
/// N 个字面段的模式最多匹配 N 层深。`**` 与 `{...}`（分支可含 `/`）
/// 均不设界（对齐 glob_util.rs :79）。
pub fn walk_depth_bound(pattern: &str) -> usize {
	if pattern.contains("**") || pattern.contains('{') {
		return usize::MAX;
	}
	pattern
		.split('/')
		.filter(|seg| !seg.is_empty())
		.count()
		.max(1)
}

/// 统一 glob 编译出口：`literal_separator(true)` + 可选大小写开关
/// （bfs -iname 语义走此开关）。
pub(crate) fn compile_pattern(pattern: &str, insensitive: bool) -> Result<Glob, String> {
	GlobBuilder::new(pattern)
		.literal_separator(true)
		.case_insensitive(insensitive)
		.build()
		.map_err(|err| format!("bad glob {pattern:?}: {err}"))
}

/// 补全未闭合的 `{` 花括号并集（LLM 常漏闭 `*.{ts,js`——补上即可编译）。
fn fix_unclosed_braces(pattern: String) -> String {
	let opens = pattern.chars().filter(|&c| c == '{').count();
	let closes = pattern.chars().filter(|&c| c == '}').count();
	if opens > closes {
		let mut fixed = pattern;
		for _ in 0..(opens - closes) {
			fixed.push('}');
		}
		fixed
	} else {
		pattern
	}
}

/// 模式整体是一个"字面量花括号并集"（`{alpha.txt,beta.txt}`）时不加
/// `**/` 前缀——并集项若带元字符则照加（`{*.ts,*.tsx}`）。
fn is_exact_brace_union(pattern: &str) -> bool {
	if !(pattern.starts_with('{') && pattern.ends_with('}')) {
		return false;
	}
	let inner = &pattern[1..pattern.len() - 1];
	!inner.is_empty()
		&& !inner
			.chars()
			.any(|ch| matches!(ch, '*' | '?' | '[' | ']' | '{' | '}'))
}

/// `--type` 合成 glob 面：(模式, 大小写不敏感) 对（rg default_types 记账：
/// 扩展名面 `**/*.ext`；docker/make 文件名面 `**/{name}*` 大小写不敏感；
/// make 面另含 `*.mk`/`*.mak` 家族）。
fn type_glob_faces(type_name: Option<&str>) -> Vec<(String, bool)> {
	let mut faces = Vec::new();
	if let Some(TypeFilter::Known { exts, names }) = resolve_type_filter(type_name) {
		for ext in exts {
			faces.push((build_glob_pattern(&format!("*.{ext}"), true), false));
		}
		for name in names {
			// 大小写不敏感覆盖 Dockerfile/Makefile 常见拼写与后缀变体。
			faces.push((build_glob_pattern(&format!("{name}*"), true), true));
		}
		if names.contains(&"makefile") {
			for ext in ["mk", "mak"] {
				faces.push((build_glob_pattern(&format!("*.{ext}"), true), false));
			}
		}
	}
	faces
}

// ---------------------------------------------------------------------------
// rg --glob 下的完整判定（include ∧ ¬exclude）
// ---------------------------------------------------------------------------

/// 单个已归一的过滤部件：取反标记 +（已补 `**/` 前缀/花括号的）glob 模式
/// + 大小写开关。
#[derive(Debug, Clone)]
struct FilterPart {
	negated: bool,
	pattern: String,
	insensitive: bool,
}

/// rg `--glob` 语义的完整判定器：**先 include 集合命中**（无 include ⇒
/// 全收，等价于 rg 全 `!` 排除语义），**再剔除 `!` 模式命中**（排除模式
/// 附带 `/**` 内容面：排除目录即排除其子树，gitignore 语义）。globset
/// 无负 glob，故拆双集合；find 面与迁移后的 grep 面全量过滤走这里。
#[derive(Debug)]
pub struct GlobFilter {
	includes: Option<GlobSet>,
	excludes: Option<GlobSet>,
	/// include 面的遍历深度界（各模式界取 min；无 include = 不设界）。
	depth_bound: usize,
}

impl GlobFilter {
	/// 部件组装出口：include 部件进采集面（计深度界），排除部件进剔除面
	/// （附内容面、不计深度界）。
	fn build(parts: Vec<FilterPart>) -> Result<Self, String> {
		let mut includes = GlobSetBuilder::new();
		let mut excludes = GlobSetBuilder::new();
		let mut any_include = false;
		let mut any_exclude = false;
		// include 并集语义：达到任一模式可达的最深处即可（max），
		// 任一模式不设界（`**`/`{`）则整体不设界。
		let mut depth = 0usize;
		for part in parts {
			if part.negated {
				// 排除模式不限深：只用于剔除，不参与遍历剪枝。
				excludes.add(compile_pattern(&part.pattern, part.insensitive)?);
				// 目录排除的内容面：`**/dir` 追加 `**/dir/**`，使 `!node_modules`
				// 命中 node_modules/x.rs（gitignore「目录排除即排除子树」）。
				if !part.pattern.ends_with("/**") {
					let contents = format!("{}/**", part.pattern);
					excludes.add(compile_pattern(&contents, part.insensitive)?);
				}
				any_exclude = true;
			} else {
				depth = depth.max(walk_depth_bound(&part.pattern));
				includes.add(compile_pattern(&part.pattern, part.insensitive)?);
				any_include = true;
			}
		}
		let build = |builder: GlobSetBuilder| builder.build().map_err(|e| e.to_string());
		Ok(Self {
			includes: if any_include { Some(build(includes)?) } else { None },
			excludes: if any_exclude { Some(build(excludes)?) } else { None },
			depth_bound: if any_include { depth } else { usize::MAX },
		})
	}

	/// 逗号分隔的多模式（每段可带 `!` 取反前缀）→ 过滤器。
	///
	/// 生产面（find/grep）已统一走 [`build_glob_filter`]，本构造器仅剩
	/// sanitize 回归测试在用 → cfg(test) 降级（对位 [`build_glob_set`]）。
	#[cfg(test)]
	pub fn from_expr(expr: &str, insensitive: bool) -> Result<Self, String> {
		let mut parts = Vec::new();
		for part in expr.split(',').flat_map(str::split_whitespace) {
			let (negated, body) = match part.strip_prefix('!') {
				Some(rest) => (true, rest),
				None => (false, part),
			};
			parts.push(FilterPart {
				negated,
				pattern: build_glob_pattern(body, true),
				insensitive,
			});
		}
		Self::build(parts)
	}

	/// 完整判定：include 命中 ∧ 未命中任何 `!` 排除模式。
	pub fn is_match(&self, path: &str) -> bool {
		let included = self.includes.as_ref().is_none_or(|inc| inc.is_match(path));
		included && !self.excludes.as_ref().is_some_and(|exc| exc.is_match(path))
	}

	/// include 面的遍历深度界（`usize::MAX` = 不设界）。
	pub fn depth_bound(&self) -> usize {
		self.depth_bound
	}
}

/// find 面与迁移后 grep 面共用的组合构造：glob 表达式（逗号/空格多模式，
/// `!` 取反，rg --glob 语义）⊕ `--type` 合成 include 面（并集，与 retired
/// build_glob_set 的正集构成一致，且 `!` 排除真实生效）。
/// 全空输入 → `None`（不过滤）。
pub fn build_glob_filter(
	glob_expr: Option<&str>,
	type_name: Option<&str>,
) -> Result<Option<GlobFilter>, String> {
	let mut parts = Vec::new();
	if let Some(expr) = glob_expr {
		for part in expr.split(',').flat_map(str::split_whitespace) {
			let (negated, body) = match part.strip_prefix('!') {
				Some(rest) => (true, rest),
				None => (false, part),
			};
			parts.push(FilterPart {
				negated,
				pattern: build_glob_pattern(body, true),
				insensitive: false,
			});
		}
	}
	for (pattern, insensitive) in type_glob_faces(type_name) {
		parts.push(FilterPart { negated: false, pattern, insensitive });
	}
	if parts.is_empty() {
		return Ok(None);
	}
	Ok(Some(GlobFilter::build(parts)?))
}

// ---------------------------------------------------------------------------
// retired grep 面：单一 GlobSet 契约（正集，测试锚）
// ---------------------------------------------------------------------------

/// 把 GrepTool 传来的 glob（逗号/空格多模式，`!` 取反）⊕ `--type` 合成
/// GlobSet——**retired 正集契约参考实现**：grep 面已迁移
/// [`build_glob_filter`]，本函数降级 cfg(test) 保留，供 sanitize 回归测试
/// 钉住单 GlobSet 正集语义边界：
/// - include 模式照 [`build_glob_pattern`] 合成（`**/` 补全等）；
/// - `--type` 走内置全表（扩展名 `**/*.ext`；docker/make 补 rg 的
///   `Makefile.*`/`*.mk`/`*.mak` 家族 glob，大小写不敏感）；
/// - `!` 排除与全排除表达式在单 GlobSet 契约内不可取反（mod doc）：
///   正集为空时返回 `None`（= 不过滤）。
#[cfg(test)]
pub(crate) fn build_glob_set(glob_expr: Option<&str>, type_name: Option<&str>) -> Result<Option<GlobSet>, String> {
	let mut builder = GlobSetBuilder::new();
	let mut any = false;
	if let Some(expr) = glob_expr {
		for part in expr.split(',').flat_map(str::split_whitespace) {
			if part.starts_with('!') {
				continue; // 单 GlobSet 内无法取反（mod doc），完整语义走 GlobFilter
			}
			let pattern = build_glob_pattern(part, true);
			builder.add(compile_pattern(&pattern, false)?);
			any = true;
		}
	}
	for (pattern, insensitive) in type_glob_faces(type_name) {
		builder.add(compile_pattern(&pattern, insensitive)?);
		any = true;
	}
	if !any {
		return Ok(None);
	}
	Ok(Some(builder.build().map_err(|e| e.to_string())?))
}

// ---------------------------------------------------------------------------
// BRE 桥（ugrep -G / GNU grep 兼容，供 argv0 spawn 场景）
// ---------------------------------------------------------------------------

/// GNU grep BRE → Rust regex 语法翻译（纯函数）。
///
/// v1 契约只落函数与测试（argv0 spawn 场景后置）：生产面无调用点 →
/// cfg(test) 降级（对位 [`build_glob_set`]），仅测试构建编译。
/// - `\|`→`|`、`\(`→`(`、`\)`→`)`、`\{n,m\}`→`{n,m}`（含 `\{n\}`/`\{n,\}`/
///   `\{,m\}`；区间内容非纯数字/逗号或未闭合 `\}` 时按字面量转义）；
/// - BRE 字面量的裸 `(`/`)`/`+`/`?`/`|`/`{`/`}` 是 Rust regex 元字符 →
///   反向转义为字面量（sanitize_braces 语义）；
/// - `\p{..}`/`\x{..}` 为 Rust regex 原生 Unicode/hex 类 → 整段原样直通；
/// - `[…]` 字符类内部原样（POSIX 类名两端语法一致）；未闭合的 `[` 在
///   BRE 里是字面量，转义为 `\[`。
#[cfg(test)]
pub fn bre_to_regex(pattern: &str) -> String {
	let chars: Vec<char> = pattern.chars().collect();
	let mut out = String::with_capacity(pattern.len() + 8);
	let mut in_class = false;
	let mut i = 0;
	while i < chars.len() {
		let c = chars[i];
		match c {
			'\\' => {
				let Some(&next) = chars.get(i + 1) else {
					out.push(c); // 尾部孤立反斜杠：原样保留（上游校验会报错）
					break;
				};
				if in_class {
					out.push(c);
					out.push(next);
					i += 2;
					continue;
				}
				match next {
					// BRE 转义的元语法 → Rust regex 元字符
					'|' | '(' | ')' => out.push(next),
					'{' => match find_interval_end(&chars, i + 2) {
						Some(end) => {
							out.push('{');
							// 区间体 [i+2, end)：end 处是闭合的 `\`，`}` 单独补出
							// —— `a\{3\}` → "a" + "{" + "3" + "}"（GNU grep 对位）。
							for &ch in &chars[i + 2..end] {
								out.push(ch);
							}
							out.push('}');
							i = end; // 循环尾 +=2 步进到 `\}` 之后（end 为闭合 `\`）
						}
						None => out.push_str("\\{"), // 伪区间：按字面量
					},
					// Rust regex 原生 Unicode/hex 类：整段直通（保护 `{..}`）
					'p' | 'P' | 'x' if chars.get(i + 2) == Some(&'{') => {
						out.push(c);
						out.push(next);
						i += 2;
						while let Some(&ch) = chars.get(i) {
							out.push(ch);
							i += 1;
							if ch == '}' {
								break;
							}
						}
						continue;
					}
					_ => {
						out.push(c);
						out.push(next);
					}
				}
				i += 2;
			}
			'[' if !in_class => {
				if !chars[i + 1..].contains(&']') {
					out.push_str("\\["); // BRE 未闭合类 = 字面量
				} else {
					out.push(c);
					in_class = true;
				}
				i += 1;
			}
			']' => {
				out.push(c);
				in_class = false;
				i += 1;
			}
			// BRE 字面元字符 → Rust regex 转义回字面量
			'|' | '(' | ')' | '+' | '?' | '{' | '}' if !in_class => {
				out.push('\\');
				out.push(c);
				i += 1;
			}
			_ => {
				out.push(c);
				i += 1;
			}
		}
	}
	out
}

/// `\{n,m\}` 闭合 `\}`（前一个反斜杠）所在下标；区间内容必须仅由
/// 数字/逗号/空白构成，否则视作字面量返回 `None`。仅 [`bre_to_regex`] 在用。
#[cfg(test)]
fn find_interval_end(chars: &[char], from: usize) -> Option<usize> {
	let mut idx = from;
	while idx < chars.len() {
		match chars[idx] {
			'0'..='9' | ',' | ' ' | '\t' => idx += 1,
			'\\' if chars.get(idx + 1) == Some(&'}') => return Some(idx),
			_ => return None,
		}
	}
	None
}

#[cfg(test)]
mod tests {
	use super::*;
	use grep_matcher::Matcher;

	// -- 内置 type 全表（28 语义项抽查） ------------------------------------

	#[test]
	fn type_table_cover_labeled_entries() {
		// (type 名, 面探针)
		type SurfaceProbe = fn(&TypeFilter) -> bool;
		let labeled: &[(&str, SurfaceProbe)] = &[
			("js", |f| f.match_ext("js")), ("ts", |f| f.match_ext("ts")),
			("json", |f| f.match_ext("json")), ("yaml", |f| f.match_ext("yaml")),
			("toml", |f| f.match_ext("toml")), ("md", |f| f.match_ext("md")),
			("py", |f| f.match_ext("py")), ("rs", |f| f.match_ext("rs")),
			("go", |f| f.match_ext("go")), ("java", |f| f.match_ext("java")),
			("kt", |f| f.match_ext("kt")), ("c", |f| f.match_ext("c")),
			("cpp", |f| f.match_ext("cpp")), ("cs", |f| f.match_ext("cs")),
			("php", |f| f.match_ext("php")), ("rb", |f| f.match_ext("rb")),
			("sh", |f| f.match_ext("sh")), ("zsh", |f| f.match_ext("zsh")),
			("fish", |f| f.match_ext("fish")), ("html", |f| f.match_ext("html")),
			("css", |f| f.match_ext("css")), ("scss", |f| f.match_ext("scss")),
			("sass", |f| f.match_ext("sass")), ("less", |f| f.match_ext("less")),
			("xml", |f| f.match_ext("xml")),
			("docker", |f| f.match_name("dockerfile")),
			("make", |f| f.match_name("makefile")),
		];
		for (name, probe) in labeled {
			let filter = resolve_type_filter(Some(name)).expect("known type resolves");
			assert!(matches!(filter, TypeFilter::Known { .. }), "{name} must be a known type");
			assert!(probe(&filter), "{name} surface probe failed");
		}
	}

	#[test]
	fn type_table_multi_ext_and_alias_groups() {
		// 多扩展名组抽查
		let c = resolve_type_filter(Some("c")).unwrap();
		assert!(c.match_ext("c") && c.match_ext("h"));
		assert!(!c.match_ext("cpp"));

		let cpp = resolve_type_filter(Some("cpp")).unwrap();
		for ext in ["cpp", "cc", "cxx", "hpp", "hxx", "hh"] {
			assert!(cpp.match_ext(ext));
		}
		let py = resolve_type_filter(Some("py")).unwrap();
		assert!(py.match_ext("pyi"));
		let sh = resolve_type_filter(Some("sh")).unwrap();
		assert!(sh.match_ext("bash") && sh.match_ext("zsh"));
		let js = resolve_type_filter(Some("js")).unwrap();
		assert!(js.match_ext("jsx") && js.match_ext("mjs") && js.match_ext("cjs"));
		let ts = resolve_type_filter(Some("ts")).unwrap();
		assert!(ts.match_ext("tsx") && ts.match_ext("mts") && ts.match_ext("cts"));
		let json = resolve_type_filter(Some("json")).unwrap();
		assert!(json.match_ext("jsonc") && json.match_ext("json5"));
		let md = resolve_type_filter(Some("md")).unwrap();
		assert!(md.match_ext("markdown") && md.match_ext("mdx"));
		let rb = resolve_type_filter(Some("rb")).unwrap();
		assert!(rb.match_ext("rake") && rb.match_ext("gemspec"));
		let java = resolve_type_filter(Some("java")).unwrap();
		assert!(!java.match_ext("kt"));

		// 典型别名解析为同一 Known 面
		for (alias, canonical) in [
			("javascript", "js"), ("typescript", "ts"), ("yml", "yaml"),
			("markdown", "md"), ("python", "py"), ("rust", "rs"),
			("kotlin", "kt"), ("cxx", "cpp"), ("csharp", "cs"),
			("ruby", "rb"), ("bash", "sh"), ("dockerfile", "docker"),
			("makefile", "make"),
		] {
			let (a, b) = (resolve_type_filter(Some(alias)), resolve_type_filter(Some(canonical)));
			assert_eq!(format!("{a:?}"), format!("{b:?}"), "alias {alias} ≡ {canonical}");
		}
	}

	#[test]
	fn type_name_normalization_and_case_insensitive_match() {
		let filter = resolve_type_filter(Some(" .Python ")).expect("normalized");
		assert!(filter.match_ext("PYI") && filter.match_ext("py"));

		// 未知 type → Custom 单扩展名等值（omp 语义）
		let custom = resolve_type_filter(Some("odin")).unwrap();
		assert!(matches!(custom, TypeFilter::Custom(_)));
		assert!(matches_type_filter("src/main.odin", &custom));
		assert!(!matches_type_filter("src/main.rs", &custom));
	}

	#[test]
	fn type_file_name_surface_for_docker_make() {
		let docker = resolve_type_filter(Some("docker")).unwrap();
		assert!(matches_type_filter("sub/Dockerfile", &docker));
		assert!(matches_type_filter("dockerfile", &docker));
		assert!(!matches_type_filter("a/Dockerfile.ts", &docker)); // 扩展名不匹配
		// build_glob_set 文件名面：Dockerfile 家族（大小写不敏感 + 后缀变体）
		let set = build_glob_set(None, Some("docker")).unwrap().unwrap();
		for path in ["Dockerfile", "dockerfile", "a/b/Dockerfile.dev", "Dockerfile"] {
			assert!(set.is_match(path), "docker set must cover {path}");
		}
		assert!(!set.is_match("a/b/notdocker"));

		let make = resolve_type_filter(Some("make")).unwrap();
		assert!(matches_type_filter("Makefile", &make)); // 大小写不敏感等值
		let set = build_glob_set(None, Some("make")).unwrap().unwrap();
		for path in ["Makefile", "makefile", "Makefile.am", "lib/x.mk", "x.mak"] {
			assert!(set.is_match(path), "make set must cover {path}");
		}
		assert!(!set.is_match("a/b/lib.c")); // 扩展名面不重叠
	}

	#[test]
	fn type_matches_by_basename_only() {
		let filter = resolve_type_filter(Some("rs")).unwrap();
		assert!(matches_type_filter("deep/nested/lib.rs", &filter));
		// 目录段带 .rs 不影响 basename 判定
		assert!(matches_type_filter("lib.rs.dir/helper.rs", &filter));
		assert!(!matches_type_filter("deep/nested/dir.rs/readme", &filter));
	}

	// -- glob 合成 ----------------------------------------------------------

	#[test]
	fn glob_simple_pattern_gets_recursive_prefix() {
		assert_eq!(build_glob_pattern("*.ts", true), "**/*.ts");
	}

	#[test]
	fn glob_pattern_with_path_stays_as_is() {
		assert_eq!(build_glob_pattern("src/*.ts", true), "src/*.ts");
		// 绝对路径模式不加前缀
		assert_eq!(build_glob_pattern("/abs/**/*.log", true), "/abs/**/*.log");
	}

	#[test]
	fn glob_backslashes_normalized() {
		assert_eq!(build_glob_pattern("src\\**\\*.ts", true), "src/**/*.ts");
	}

	#[test]
	fn glob_unclosed_braces_completed() {
		assert_eq!(build_glob_pattern("*.{ts,tsx,js", true), "**/*.{ts,tsx,js}");
		assert_eq!(build_glob_pattern("{a,{b,c}", true), "**/{a,{b,c}}");
		assert_eq!(build_glob_pattern("*.{ts,js}", true), "**/*.{ts,js}");
	}

	#[test]
	fn glob_exact_brace_union_without_meta_keeps_root_semantics() {
		assert_eq!(build_glob_pattern("{alpha.txt,beta.txt}", true), "{alpha.txt,beta.txt}");
		assert_eq!(build_glob_pattern("{*.ts,*.tsx}", true), "**/{*.ts,*.tsx}");
	}

	#[test]
	fn glob_compiled_set_respects_prefix_and_separator() {
		let set = build_glob_set(Some("*.rs"), None).unwrap().unwrap();
		assert!(set.is_match("lib.rs"));
		assert!(set.is_match("src/nested/lib.rs"));
		assert!(!set.is_match("src/lib.ts"));
	}

	#[test]
	fn walk_depth_bound_counts_segments_and_unbounds_recursion() {
		assert_eq!(walk_depth_bound("*"), 1);
		assert_eq!(walk_depth_bound("*.json"), 1);
		assert_eq!(walk_depth_bound("dir/*.ts"), 2);
		assert_eq!(walk_depth_bound("a/*/c.txt"), 3);
		assert_eq!(walk_depth_bound("**/*"), usize::MAX);
		assert_eq!(walk_depth_bound("src/**/*.ts"), usize::MAX);
		assert_eq!(walk_depth_bound("{a/b,c}/d.txt"), usize::MAX);
	}

	#[test]
	fn glob_filter_include_then_exclude_semantics() {
		let filter = GlobFilter::from_expr("*.rs,*.json,!*.test.rs,!node_modules", false).unwrap();
		assert!(filter.is_match("lib.rs"));
		assert!(filter.is_match("a/b/pkg.json"));
		// 先 include 命中，再被 `!` 剔除
		assert!(!filter.is_match("app.test.rs"));
		assert!(!filter.is_match("node_modules/x.rs"));
		// 未命中 include 集合 → 排除
		assert!(!filter.is_match("notes.txt"));
	}

	#[test]
	fn glob_filter_exclude_only_means_default_include() {
		let filter = GlobFilter::from_expr("!*.ts", false).unwrap();
		assert!(filter.is_match("lib.rs"));
		assert!(!filter.is_match("lib.ts"));
		assert!(!filter.is_match("src/deep/lib.ts"));
		// 深度界：排除面不参与剪枝（无 include ⇒ 不设界）
		assert_eq!(filter.depth_bound(), usize::MAX);
	}

	#[test]
	fn glob_filter_depth_bound_is_max_of_include_bounds() {
		// include 并集：走到最深可达面（字面段最深的那个）
		let filter = GlobFilter::from_expr("src/*.ts,a/b/c", false).unwrap();
		assert_eq!(filter.depth_bound(), 3);
		// 任一 include 不设界（`**`/前缀补全）⇒ 整体不设界
		let mixed = GlobFilter::from_expr("src/*.ts,**/b", false).unwrap();
		assert_eq!(mixed.depth_bound(), usize::MAX);
		let bare = GlobFilter::from_expr("*.ts", false).unwrap();
		assert_eq!(bare.depth_bound(), usize::MAX); // `**/*.ts`
	}

	#[test]
	fn glob_filter_case_insensitive_switch() {
		let filter = GlobFilter::from_expr("*.RS", true).unwrap();
		assert!(filter.is_match("src/lib.rs"));
		let sensitive = GlobFilter::from_expr("*.RS", false).unwrap();
		assert!(!sensitive.is_match("src/lib.rs"));
	}

	#[test]
	fn glob_set_exclusions_degrade_to_positive_only_contract() {
		// frozen grep 面的文档化边界：`!` 排除在单 GlobSet 契约内不生效
		let set = build_glob_set(Some("*.rs,!*.test.rs"), None).unwrap().unwrap();
		assert!(set.is_match("lib.rs"));
		assert!(set.is_match("app.test.rs")); // 正集无法取反（mod doc）

		// 全排除表达式 → 正集为空 → None（不过滤）
		let none = build_glob_set(Some("!*.ts"), None).unwrap();
		assert!(none.is_none());

		// type ⊕ glob 组合正集
		let set = build_glob_set(Some("*.rs"), Some("json")).unwrap().unwrap();
		assert!(set.is_match("a/b.rs") && set.is_match("a/b.jsonc") && set.is_match("a/b.json5"));
		assert!(!set.is_match("a/b.ts"));
	}

	// -- BRE 桥 -------------------------------------------------------------

	#[test]
	fn bre_alternation_translation() {
		assert_eq!(bre_to_regex(r"foo\|bar"), "foo|bar");
	}

	#[test]
	fn bre_group_and_alternation_translation() {
		assert_eq!(bre_to_regex(r"\(ab\)\|cd"), "(ab)|cd");
	}

	#[test]
	fn bre_interval_forms_translation() {
		assert_eq!(bre_to_regex(r"a\{3\}b\{2,\}c\{,4\}"), "a{3}b{2,}c{,4}");
		assert_eq!(bre_to_regex(r"x\{1,3\}"), "x{1,3}");
	}

	#[test]
	fn bre_bare_braces_escaped_as_literals() {
		assert_eq!(bre_to_regex("a{2}b}c{"), r"a\{2\}b\}c\{");
	}

	#[test]
	fn bre_unicode_and_hex_classes_protected() {
		assert_eq!(bre_to_regex(r"\p{L}\x{263A}{"), r"\p{L}\x{263A}\{");
	}

	#[test]
	fn bre_bare_regex_meta_escaped() {
		// BRE 里裸 ( ) | + ? 是字面量，Rust regex 是元字符
		assert_eq!(bre_to_regex("a(b|c)+d?e[f]g"), r"a\(b\|c\)\+d\?e[f]g");
	}

	#[test]
	fn bre_unclosed_bare_bracket_escaped() {
		assert_eq!(bre_to_regex("a[b"), r"a\[b");
		assert_eq!(bre_to_regex("x[a-z]y"), "x[a-z]y"); // 完整类直通
	}

	#[test]
	fn bre_plain_text_left_alone() {
		assert_eq!(bre_to_regex("hello.txt*"), "hello.txt*");
		assert_eq!(bre_to_regex(r"end of \. escape \$ ok"), r"end of \. escape \$ ok");
	}

	#[test]
	fn bre_translations_stay_semantically_gnu_grep() {
		// 翻译产物直接喂 grep-regex（rg 同源引擎），锚点对齐 GNU grep 实测：
		// `grep -E '\(ab\)\{1,2\}\|cd'` ≡ Rust regex "(ab){1,2}|cd"。
		let cases: &[(&str, &[&str], &[&str])] = &[
			(r"foo\|bar", &["xfoo", "abar"], &["baz"]),
			(r"\(ab\)\{1,2\}\|cd", &["abab", "xcd"], &["a"]),
			(r"a\{2,4\}", &["aa", "xaaa"], &["a", "banana"]),
			(r"\(cat\)\|\(dog\)s", &["cats", "dogss"], &["dog"]),
		];
		for (bre, positives, negatives) in cases {
			let regex = bre_to_regex(bre);
			let matcher = grep_regex::RegexMatcher::new(&regex)
				.unwrap_or_else(|e| panic!("translated {bre:?} -> {regex:?} must compile: {e}"));
			for positive in *positives {
				assert!(
					matcher.is_match(positive.as_bytes()).unwrap(),
					"{bre:?} -> {regex:?} must match {positive:?}"
				);
			}
			for negative in *negatives {
				assert!(
					!matcher.is_match(negative.as_bytes()).unwrap(),
					"{bre:?} -> {regex:?} must not match {negative:?}"
				);
			}
		}
	}
}
