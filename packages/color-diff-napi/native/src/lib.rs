//! Rust restoration of the original color-diff native module
//! (vendor/color-diff-src was lost; the TypeScript port in ../src was a
//! stand-in using highlight.js). This crate restores the original design:
//! syntect for syntax tokenization (stateful — multi-line strings/comments
//! highlight correctly, unlike hljs line-by-line), a line-for-line Rust port
//! of jsdiff 8.0.4's tokenizers + Myers engine for the line/word diffs
//! (byte-identical to the `diff` npm package, see ../src/jsDiff.ts), and the
//! measured scope-color tables so the output colors match what the original
//! produced.
//!
//! The transform pipeline (markers, backgrounds, wrapping, line numbers,
//! dimming) is a line-for-line port of the TS port, which itself was
//! verified output-identical in structure to the original native module.

use std::sync::OnceLock;

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use syntect::parsing::{ParseState, ScopeStack, SyntaxSet};
use unicode_width::UnicodeWidthChar;
use unicode_width::UnicodeWidthStr;

// ── Color / ANSI escape helpers (port of TS helpers) ─────────────

#[derive(Clone, Copy, PartialEq, Eq)]
struct Color {
  r: u8,
  g: u8,
  b: u8,
  a: u8,
}

const RESET: &str = "\x1b[0m";
const DIM: &str = "\x1b[2m";
const UNDIM: &str = "\x1b[22m";

const fn rgb(r: u8, g: u8, b: u8) -> Color {
  Color { r, g, b, a: 255 }
}

const fn ansi_idx(index: u8) -> Color {
  Color { r: index, g: 0, b: 0, a: 0 }
}

/// Sentinel: a=1 means "terminal default" (bat convention)
const DEFAULT_BG: Color = Color { r: 0, g: 0, b: 0, a: 1 };

#[derive(Clone, Copy, PartialEq, Eq)]
enum ColorMode {
  Truecolor,
  Color256,
  Ansi,
}

fn detect_color_mode(theme: &str) -> ColorMode {
  if theme.contains("ansi") {
    return ColorMode::Ansi;
  }
  let ct = std::env::var("COLORTERM").unwrap_or_default();
  if ct == "truecolor" || ct == "24bit" {
    ColorMode::Truecolor
  } else {
    ColorMode::Color256
  }
}

/// Port of ansi_colours::ansi256_from_rgb — approximates RGB to the xterm-256
/// palette (6x6x6 cube + 24 greys). Mirrors the TS implementation exactly.
const CUBE_LEVELS: [u8; 6] = [0, 95, 135, 175, 215, 255];

fn ansi256_from_rgb(r: u8, g: u8, b: u8) -> u8 {
  let q = |c: u8| -> u8 {
    if c < 48 {
      0
    } else if c < 115 {
      1
    } else if c < 155 {
      2
    } else if c < 195 {
      3
    } else if c < 235 {
      4
    } else {
      5
    }
  };
  let qr = q(r);
  let qg = q(g);
  let qb = q(b);
  let cube_idx = 16 + 36 * qr + 6 * qg + qb;
  let grey = (u16::from(r) + u16::from(g) + u16::from(b)) / 3;
  if grey < 5 {
    return 16;
  }
  if grey > 244 && qr == qg && qg == qb {
    return cube_idx;
  }
  let grey_level = ((grey - 8) / 10).min(23) as u8;
  let grey_idx = 232 + grey_level;
  let grey_rgb = 8 + grey_level * 10;
  let cr = CUBE_LEVELS[qr as usize];
  let cg = CUBE_LEVELS[qg as usize];
  let cb = CUBE_LEVELS[qb as usize];
  let dr = i32::from(r) - i32::from(cr);
  let dg = i32::from(g) - i32::from(cg);
  let db = i32::from(b) - i32::from(cb);
  let d_cube = dr * dr + dg * dg + db * db;
  let dgr = i32::from(r) - i32::from(grey_rgb);
  let dgg = i32::from(g) - i32::from(grey_rgb);
  let dgb = i32::from(b) - i32::from(grey_rgb);
  let d_grey = dgr * dgr + dgg * dgg + dgb * dgb;
  if d_grey < d_cube {
    grey_idx
  } else {
    cube_idx
  }
}

fn color_to_escape(c: Color, fg: bool, mode: ColorMode) -> String {
  // alpha=0: palette index encoded in .r (bat's ansi-theme convention)
  if c.a == 0 {
    let idx = c.r;
    if idx < 8 {
      return format!("\x1b[{}m", (if fg { 30 } else { 40 }) + i16::from(idx));
    }
    if idx < 16 {
      return format!(
        "\x1b[{}m",
        (if fg { 90 } else { 100 }) + i16::from(idx - 8)
      );
    }
    return format!("\x1b[{};5;{}m", if fg { 38 } else { 48 }, idx);
  }
  // alpha=1: terminal default
  if c.a == 1 {
    return if fg { "\x1b[39m" } else { "\x1b[49m" }.to_string();
  }

  let code_type = if fg { 38 } else { 48 };
  match mode {
    ColorMode::Truecolor => {
      format!("\x1b[{code_type};2;{};{};{}m", c.r, c.g, c.b)
    }
    _ => format!(
      "\x1b[{code_type};5;{}m",
      ansi256_from_rgb(c.r, c.g, c.b)
    ),
  }
}

// ── Theme ────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum Marker {
  Add,
  Del,
  Ctx,
}

type Style = (Color, Color); // (foreground, background)
type Block = (Style, String);

struct ScopeTable {
  map: &'static [(&'static str, Color)],
}

struct Theme {
  add_line: Color,
  add_word: Color,
  add_decoration: Color,
  delete_line: Color,
  delete_word: Color,
  delete_decoration: Color,
  foreground: Color,
  background: Color,
  scopes: &'static ScopeTable,
}

// Scope → syntect-token color tables (values measured from the original
// Rust module's output so colors match it exactly).
const MONOKAI_SCOPES: ScopeTable = ScopeTable {
  map: &[
    ("keyword", rgb(249, 38, 114)),
    ("_storage", rgb(102, 217, 239)),
    ("built_in", rgb(166, 226, 46)),
    ("type", rgb(166, 226, 46)),
    ("literal", rgb(190, 132, 255)),
    ("number", rgb(190, 132, 255)),
    ("string", rgb(230, 219, 116)),
    ("title", rgb(166, 226, 46)),
    ("title.function", rgb(166, 226, 46)),
    ("title.class", rgb(166, 226, 46)),
    ("title.class.inherited", rgb(166, 226, 46)),
    ("params", rgb(253, 151, 31)),
    ("comment", rgb(117, 113, 94)),
    ("meta", rgb(117, 113, 94)),
    ("attr", rgb(166, 226, 46)),
    ("attribute", rgb(166, 226, 46)),
    ("variable", rgb(255, 255, 255)),
    ("variable.language", rgb(255, 255, 255)),
    ("property", rgb(255, 255, 255)),
    ("operator", rgb(249, 38, 114)),
    ("punctuation", rgb(248, 248, 242)),
    ("symbol", rgb(190, 132, 255)),
    ("regexp", rgb(230, 219, 116)),
    ("subst", rgb(248, 248, 242)),
  ],
};

const GITHUB_SCOPES: ScopeTable = ScopeTable {
  map: &[
    ("keyword", rgb(167, 29, 93)),
    ("_storage", rgb(167, 29, 93)),
    ("built_in", rgb(0, 134, 179)),
    ("type", rgb(0, 134, 179)),
    ("literal", rgb(0, 134, 179)),
    ("number", rgb(0, 134, 179)),
    ("string", rgb(24, 54, 145)),
    ("title", rgb(121, 93, 163)),
    ("title.function", rgb(121, 93, 163)),
    ("title.class", rgb(0, 0, 0)),
    ("title.class.inherited", rgb(0, 0, 0)),
    ("params", rgb(0, 134, 179)),
    ("comment", rgb(150, 152, 150)),
    ("meta", rgb(150, 152, 150)),
    ("attr", rgb(0, 134, 179)),
    ("attribute", rgb(0, 134, 179)),
    ("variable", rgb(0, 134, 179)),
    ("variable.language", rgb(0, 134, 179)),
    ("property", rgb(0, 134, 179)),
    ("operator", rgb(167, 29, 93)),
    ("punctuation", rgb(51, 51, 51)),
    ("symbol", rgb(0, 134, 179)),
    ("regexp", rgb(24, 54, 145)),
    ("subst", rgb(51, 51, 51)),
  ],
};

const ANSI_SCOPES: ScopeTable = ScopeTable {
  map: &[
    ("keyword", ansi_idx(13)),
    ("_storage", ansi_idx(14)),
    ("built_in", ansi_idx(14)),
    ("type", ansi_idx(14)),
    ("literal", ansi_idx(12)),
    ("number", ansi_idx(12)),
    ("string", ansi_idx(10)),
    ("title", ansi_idx(11)),
    ("title.function", ansi_idx(11)),
    ("title.class", ansi_idx(11)),
    ("comment", ansi_idx(8)),
    ("meta", ansi_idx(8)),
  ],
};

fn build_theme(theme_name: &str, mode: ColorMode) -> Theme {
  let is_dark = theme_name.contains("dark");
  let is_ansi = theme_name.contains("ansi");
  let is_daltonized = theme_name.contains("daltonized");
  let tc = matches!(mode, ColorMode::Truecolor);

  if is_ansi {
    return Theme {
      add_line: DEFAULT_BG,
      add_word: DEFAULT_BG,
      add_decoration: ansi_idx(10),
      delete_line: DEFAULT_BG,
      delete_word: DEFAULT_BG,
      delete_decoration: ansi_idx(9),
      foreground: ansi_idx(7),
      background: DEFAULT_BG,
      scopes: &ANSI_SCOPES,
    };
  }

  if is_dark {
    let fg = rgb(248, 248, 242);
    let delete_line = rgb(61, 1, 0);
    let delete_word = rgb(92, 2, 0);
    let delete_decoration = rgb(220, 90, 90);
    if is_daltonized {
      return Theme {
        add_line: if tc { rgb(0, 27, 41) } else { ansi_idx(17) },
        add_word: if tc { rgb(0, 48, 71) } else { ansi_idx(24) },
        add_decoration: rgb(81, 160, 200),
        delete_line,
        delete_word,
        delete_decoration,
        foreground: fg,
        background: DEFAULT_BG,
        scopes: &MONOKAI_SCOPES,
      };
    }
    return Theme {
      add_line: if tc { rgb(2, 40, 0) } else { ansi_idx(22) },
      add_word: if tc { rgb(4, 71, 0) } else { ansi_idx(28) },
      add_decoration: rgb(80, 200, 80),
      delete_line,
      delete_word,
      delete_decoration,
      foreground: fg,
      background: DEFAULT_BG,
      scopes: &MONOKAI_SCOPES,
    };
  }

  // light
  let fg = rgb(51, 51, 51);
  let delete_line = rgb(255, 220, 220);
  let delete_word = rgb(255, 199, 199);
  let delete_decoration = rgb(207, 34, 46);
  if is_daltonized {
    return Theme {
      add_line: rgb(219, 237, 255),
      add_word: rgb(179, 217, 255),
      add_decoration: rgb(36, 87, 138),
      delete_line,
      delete_word,
      delete_decoration,
      foreground: fg,
      background: DEFAULT_BG,
      scopes: &GITHUB_SCOPES,
    };
  }
  Theme {
    add_line: rgb(220, 255, 220),
    add_word: rgb(178, 255, 178),
    add_decoration: rgb(36, 138, 61),
    delete_line,
    delete_word,
    delete_decoration,
    foreground: fg,
    background: DEFAULT_BG,
    scopes: &GITHUB_SCOPES,
  }
}

fn default_style(theme: &Theme) -> Style {
  (theme.foreground, theme.background)
}

fn line_background(marker: Marker, theme: &Theme) -> Color {
  match marker {
    Marker::Add => theme.add_line,
    Marker::Del => theme.delete_line,
    Marker::Ctx => theme.background,
  }
}

fn word_background(marker: Marker, theme: &Theme) -> Color {
  match marker {
    Marker::Add => theme.add_word,
    Marker::Del => theme.delete_word,
    Marker::Ctx => theme.background,
  }
}

fn decoration_color(marker: Marker, theme: &Theme) -> Color {
  match marker {
    Marker::Add => theme.add_decoration,
    Marker::Del => theme.delete_decoration,
    Marker::Ctx => theme.foreground,
  }
}

fn as_terminal_escaped(
  blocks: &[Block],
  mode: ColorMode,
  skip_background: bool,
  dim: bool,
) -> String {
  let mut out = if dim {
    String::from(RESET) + DIM
  } else {
    String::from(RESET)
  };
  for (style, text) in blocks {
    out.push_str(&color_to_escape(style.0, true, mode));
    if !skip_background {
      out.push_str(&color_to_escape(style.1, false, mode));
    }
    out.push_str(text);
  }
  out + RESET
}

// ── Language detection (syntect-backed) ──────────────────────────

fn syntax_set() -> &'static SyntaxSet {
  static SS: OnceLock<SyntaxSet> = OnceLock::new();
  SS.get_or_init(SyntaxSet::load_defaults_newlines)
}

/// Filename-based hints (approximates bat's SyntaxMapping for well-known
/// filenames that syntect's extension lookup misses).
fn filename_language(base: &str) -> Option<&str> {
  let ss = syntax_set();
  match base {
    "Dockerfile" => Some("dockerfile"),
    "Makefile" | "makefile" | "GNUmakefile" | "Makefile.am" | "Makefile.in" => {
      Some("makefile")
    }
    "Rakefile" | "Gemfile" => Some("ruby"),
    "CMakeLists.txt" => Some("cmake"),
    _ => {
      // fall back to syntect name lookup for known filename syntaxes
      let stem = base.split('.').next()?;
      ss.find_syntax_by_name(base)
        .or_else(|| ss.find_syntax_by_name(stem))
        .map(|_| base)
    }
  }
}

/// Resolve a language hint string to a syntect syntax reference.
fn find_syntax(hint: &str) -> Option<&'static syntect::parsing::SyntaxReference> {
  let ss = syntax_set();
  ss.find_syntax_by_token(hint)
    .or_else(|| ss.find_syntax_by_extension(hint))
    .or_else(|| ss.find_syntax_by_name(hint))
}

fn detect_language(
  file_path: &str,
  first_line: Option<&str>,
) -> Option<&'static syntect::parsing::SyntaxReference> {
  let ss = syntax_set();
  let base = file_path.rsplit(['/', '\\']).next().unwrap_or(file_path);
  let ext = base.rsplit('.').next().unwrap_or("");

  if let Some(lang) = filename_language(base) {
    if let Some(syn) = find_syntax(lang) {
      return Some(syn);
    }
  }
  if ext != base {
    if let Some(syn) = ss.find_syntax_by_extension(ext) {
      return Some(syn);
    }
  }
  // Shebang / first-line detection (syntect-native, strips BOM internally)
  if let Some(line) = first_line {
    let line = line.strip_prefix('\u{feff}').unwrap_or(line);
    if let Some(syn) = ss.find_syntax_by_first_line(line) {
      return Some(syn);
    }
  }
  None
}

// ── Custom .tmTheme support (BAT_THEME) ──────────────────────────

/// Load the alternate syntect theme selected via BAT_THEME /
/// CLAUDE_CODE_SYNTAX_HIGHLIGHT (path to a .tmTheme file). Returns the
/// parsed theme plus its display name. Cached process-wide.
fn custom_theme() -> Option<&'static (syntect::highlighting::Theme, String)> {
  static CACHE: OnceLock<Option<(syntect::highlighting::Theme, String)>> =
    OnceLock::new();
  CACHE
    .get_or_init(|| {
      let path = std::env::var("CLAUDE_CODE_SYNTAX_HIGHLIGHT")
        .ok()
        .filter(|p| !p.is_empty())
        .or_else(|| std::env::var("BAT_THEME").ok().filter(|p| !p.is_empty()))?;
      let bytes = std::fs::read(&path).ok()?;
      let theme = syntect::highlighting::ThemeSet::load_from_reader(
        &mut std::io::Cursor::new(bytes),
      )
      .ok()?;
      let name = theme.name.clone().unwrap_or_else(|| {
        std::path::Path::new(&path)
          .file_stem()
          .map(|s| s.to_string_lossy().into_owned())
          .unwrap_or_default()
      });
      Some((theme, name))
    })
    .as_ref()
}

/// Resolve a scope stack against a syntect theme file: the most specific
/// matching selector wins (same power ranking syntect uses internally).
fn syntect_theme_color(
  theme: &syntect::highlighting::Theme,
  stack: &ScopeStack,
) -> Option<Color> {
  let mut best: Option<(f64, Color)> = None;
  for item in &theme.scopes {
    if let Some(m) = item.scope.does_match(stack.as_slice()) {
      if best.as_ref().map_or(true, |(bm, _)| m.0 > *bm) {
        if let Some(fg) = item.style.foreground {
          best = Some((m.0, Color { r: fg.r, g: fg.g, b: fg.b, a: 255 }));
        }
      }
    }
  }
  best.map(|(_, c)| c)
}

// ── Scope → theme bucket resolution ──────────────────────────────

/// Map a syntect scope path to a theme-table bucket key. Ordered by
/// specificity — callers walk the scope stack innermost-first and take the
/// first hit, which reproduces hljs's scope ?? scope.split('.')[0] lookup
/// while gaining syntect's accurate token boundaries.
fn scope_bucket(scope_str: &str) -> Option<&'static str> {
  if scope_str.starts_with("comment") {
    return Some("comment");
  }
  if scope_str.starts_with("string.regexp") || scope_str.starts_with("source.regexp") {
    return Some("regexp");
  }
  if scope_str.starts_with("string") {
    return Some("string");
  }
  if scope_str.starts_with("constant.numeric") {
    return Some("number");
  }
  if scope_str.starts_with("constant") {
    return Some("literal");
  }
  if scope_str.starts_with("storage") {
    return Some("_storage");
  }
  if scope_str.starts_with("keyword") {
    return Some("keyword");
  }
  if scope_str.starts_with("entity.name.function")
    || scope_str.starts_with("entity.name.method")
  {
    return Some("title.function");
  }
  if scope_str.starts_with("entity.name.type")
    || scope_str.starts_with("entity.name.class")
    || scope_str.starts_with("entity.name.struct")
    || scope_str.starts_with("entity.name.interface")
    || scope_str.starts_with("entity.name.enum")
  {
    return Some("title.class");
  }
  if scope_str.starts_with("entity.other.attribute-name") {
    return Some("attribute");
  }
  if scope_str.starts_with("entity.name") || scope_str.starts_with("entity") {
    return Some("title");
  }
  if scope_str.starts_with("variable.parameter") {
    return Some("params");
  }
  if scope_str.starts_with("variable.language") {
    return Some("variable.language");
  }
  if scope_str.starts_with("variable") {
    return Some("variable");
  }
  if scope_str.starts_with("support") {
    return Some("built_in");
  }
  if scope_str.starts_with("meta") {
    return Some("meta");
  }
  if scope_str.starts_with("punctuation") {
    return Some("punctuation");
  }
  if scope_str.starts_with("markup") {
    return Some("subst");
  }
  None
}

fn table_color(table: &ScopeTable, key: &str) -> Option<Color> {
  table
    .map
    .iter()
    .find(|(k, _)| *k == key)
    .map(|(_, c)| *c)
}

fn scope_stack_color(stack: &ScopeStack, theme: &Theme) -> Color {
  // Innermost-first walk; first bucket match wins, then parent-prefix
  // fallback (TS: scopes[scope] ?? scopes[scope.split('.')[0]]).
  for scope in stack.as_slice().iter().rev() {
    let s = scope.to_string();
    if let Some(key) = scope_bucket(&s) {
      if let Some(c) = table_color(theme.scopes, key) {
        return c;
      }
      if let Some((root, _)) = s.split_once('.') {
        if let Some(c) = table_color(theme.scopes, root) {
          return c;
        }
      }
    }
  }
  theme.foreground
}

// ── Stateful line highlighter (the original's design) ────────────

struct Highlighter {
  parse_state: ParseState,
  syntax: &'static syntect::parsing::SyntaxReference,
}

impl Highlighter {
  fn new(syntax: &'static syntect::parsing::SyntaxReference) -> Self {
    Highlighter {
      parse_state: ParseState::new(syntax),
      syntax,
    }
  }

  /// Tokenize one line into (foreground, text) blocks using the running
  /// parse state. Background is always theme.background — the transform
  /// pipeline applies real line/word backgrounds later.
  fn highlight_line(&mut self, line: &str, theme: &Theme) -> Vec<Block> {
    // BAT_THEME-selected .tmTheme overrides the built-in color tables.
    let custom = custom_theme().map(|(t, _)| t);
    if let Some(ct) = custom {
      return self.highlight_line_with_theme(line, |stack| {
        syntect_theme_color(ct, stack)
          .or_else(|| {
            ct.settings
              .foreground
              .map(|fg| Color { r: fg.r, g: fg.g, b: fg.b, a: 255 })
          })
          .unwrap_or(theme.foreground)
      });
    }
    let ss = syntax_set();
    let ops = match self.parse_state.parse_line(line, ss) {
      Ok(ops) => ops,
      Err(_) => return vec![(default_style(theme), line.to_string())],
    };
    // Reconstruct (range, ScopeStack) segments — same replay order as
    // syntect's own HighlightIterator.
    let mut segments: Vec<(usize, usize, ScopeStack)> = Vec::new();
    let mut stack = ScopeStack::new();
    let mut cursor = 0usize;
    for (pos, op) in ops {
      let pos = pos.min(line.len());
      if pos > cursor {
        if line.is_char_boundary(cursor) && line.is_char_boundary(pos) {
          segments.push((cursor, pos, stack.clone()));
        }
        cursor = pos;
      }
      stack.apply(&op);
    }
    if line.len() > cursor
      && line.is_char_boundary(cursor)
      && line.is_char_boundary(line.len())
    {
      segments.push((cursor, line.len(), stack));
    }

    if segments.is_empty() {
      return vec![(default_style(theme), line.to_string())];
    }
    let mut blocks: Vec<Block> = Vec::with_capacity(segments.len());
    for (start, end, stack) in segments {
      let fg = scope_stack_color(&stack, theme);
      blocks.push(((fg, theme.background), line[start..end].to_string()));
    }
    // Merge adjacent blocks with identical foreground to keep block counts
    // low (purely cosmetic — escape output identical either way).
    let mut merged: Vec<Block> = Vec::with_capacity(blocks.len());
    for (style, text) in blocks {
      match merged.last_mut() {
        Some(((s, _), t)) if *s == style.0 => t.push_str(&text),
        _ => merged.push((style, text)),
      }
    }
    merged
  }

  /// Segment + color a line using an arbitrary scope-resolver (used by the
  /// custom .tmTheme path). Identical segmentation replay as highlight_line.
  fn highlight_line_with_theme(
    &mut self,
    line: &str,
    resolve: impl Fn(&ScopeStack) -> Color,
  ) -> Vec<Block> {
    let ss = syntax_set();
    let ops = match self.parse_state.parse_line(line, ss) {
      Ok(ops) => ops,
      Err(_) => return vec![((resolve(&ScopeStack::new()), Color { r: 0, g: 0, b: 0, a: 1 }), line.to_string())],
    };
    let mut segments: Vec<(usize, usize, ScopeStack)> = Vec::new();
    let mut stack = ScopeStack::new();
    let mut cursor = 0usize;
    for (pos, op) in ops {
      let pos = pos.min(line.len());
      if pos > cursor {
        if line.is_char_boundary(cursor) && line.is_char_boundary(pos) {
          segments.push((cursor, pos, stack.clone()));
        }
        cursor = pos;
      }
      stack.apply(&op);
    }
    if line.len() > cursor
      && line.is_char_boundary(cursor)
      && line.is_char_boundary(line.len())
    {
      segments.push((cursor, line.len(), stack));
    }
    if segments.is_empty() {
      return vec![(
        (resolve(&ScopeStack::new()), Color { r: 0, g: 0, b: 0, a: 1 }),
        line.to_string(),
      )];
    }
    let mut merged: Vec<Block> = Vec::with_capacity(segments.len());
    for (start, end, stack) in segments {
      let fg = resolve(&stack);
      let block = ((fg, Color { r: 0, g: 0, b: 0, a: 1 }), line[start..end].to_string());
      match merged.last_mut() {
        Some(((s, _), t)) if *s == fg => t.push_str(&block.1),
        _ => merged.push(block),
      }
    }
    merged
  }

  /// Feed lines through the state without producing output (warm-up).
  fn warm(&mut self, content: &str) {
    let ss = syntax_set();
    for line in content.split_inclusive('\n') {
      let _ = self.parse_state.parse_line(line, ss);
    }
  }
}

// ── jsdiff 8.0.4 word/line tokenizer + Myers engine ──────────────
//
// Line-for-line port of the `diff` npm package 8.0.4 (MIT): diff/word.js,
// diff/line.js and diff/base.js, exactly mirroring ../src/jsDiff.ts. The
// previous implementation used the `similar` crate's from_words/from_lines,
// whose tokenizers differ from jsdiff's in observable ways (punctuation
// attaching to words, newlines not being separate tokens, lone \r being a
// line terminator, different Myers tie-breaks) — so change boundaries and
// count semantics diverged. Everything below reproduces jsdiff byte-for-byte.

type Range = (usize, usize);

const CHANGE_THRESHOLD: f64 = 0.4;

/// jsdiff's `extendedWordChars` (diff/word.js) — the exact "word" character
/// ranges of the word tokenizer regex. Note `\u{F8}-\u{2C6}` is one big
/// range (Latin-1 ø through IPA extensions): İ, Ā, ǅ… are word characters,
/// while CJK, Greek, Cyrillic and the ˇ–˝ modifiers (U+02C7, U+02D8-02DD)
/// are not.
fn is_extended_word_char(c: char) -> bool {
  matches!(
    c,
    'a'..='z' | 'A'..='Z' | '0'..='9' | '_'
      | '\u{AD}'
      | '\u{C0}'..='\u{D6}'
      | '\u{D8}'..='\u{F6}'
      | '\u{F8}'..='\u{2C6}'
      | '\u{2C8}'..='\u{2D7}'
      | '\u{2DE}'..='\u{2FF}'
      | '\u{1E00}'..='\u{1EFF}'
  )
}

/// JavaScript's `\s` character class — NOT the same set as Rust's
/// `char::is_whitespace` (JS includes U+FEFF, excludes U+0085).
fn is_js_whitespace(c: char) -> bool {
  matches!(
    c,
    '\u{09}'..='\u{0D}'
      | '\u{20}'
      | '\u{A0}'
      | '\u{1680}'
      | '\u{2000}'..='\u{200A}'
      | '\u{2028}'
      | '\u{2029}'
      | '\u{202F}'
      | '\u{205F}'
      | '\u{3000}'
      | '\u{FEFF}'
  )
}

/// jsdiff WordsWithSpaceDiff.tokenize (diff/word.js) — a left-to-right scan
/// with the exact alternation order of its regex
/// `(\r?\n)|[EXT]+|[^\S\n\r]+|[^EXT]` (`u` flag): every \n / \r\n is its own
/// token, word runs and non-newline whitespace runs group up, and anything
/// else (including a lone \r and each punctuation char) is a single-char
/// token.
fn tokenize_words_with_space(text: &str) -> Vec<&str> {
  let mut tokens: Vec<&str> = Vec::new();
  let bytes = text.as_bytes();
  let mut i = 0usize;
  while i < text.len() {
    let c = text[i..].chars().next().unwrap();
    if c == '\n' {
      // (\r?\n) — lone \n
      tokens.push(&text[i..i + 1]);
      i += 1;
    } else if c == '\r' && i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
      // (\r?\n) — \r\n pair
      tokens.push(&text[i..i + 2]);
      i += 2;
    } else if is_extended_word_char(c) {
      // [EXT]+
      let mut j = i + c.len_utf8();
      while let Some(c2) = text[j..].chars().next() {
        if !is_extended_word_char(c2) {
          break;
        }
        j += c2.len_utf8();
      }
      tokens.push(&text[i..j]);
      i = j;
    } else if c != '\r' && is_js_whitespace(c) {
      // [^\S\n\r]+ — whitespace runs sans \n and \r (\n gets its own token)
      let mut j = i + c.len_utf8();
      while let Some(c2) = text[j..].chars().next() {
        if c2 == '\r' || c2 == '\n' || !is_js_whitespace(c2) {
          break;
        }
        j += c2.len_utf8();
      }
      tokens.push(&text[i..j]);
      i = j;
    } else {
      // [^EXT] — single char (punctuation, lone \r, CJK, …)
      let len = c.len_utf8();
      tokens.push(&text[i..i + len]);
      i += len;
    }
  }
  tokens
}

/// jsdiff's diffLines tokenizer (diff/line.js `tokenize`, default options):
/// split keeping each (\n|\r\n) terminator attached to the preceding line,
/// drop the trailing empty token, then drop empty tokens (Diff#removeEmpty).
/// A lone \r is NOT a line terminator — it stays inside the line content.
fn tokenize_lines_js(text: &str) -> Vec<String> {
  let bytes = text.as_bytes();
  let mut parts: Vec<&str> = Vec::new();
  let mut start = 0usize;
  let mut i = 0usize;
  while i < bytes.len() {
    if bytes[i] == b'\n' {
      parts.push(&text[start..i]);
      parts.push("\n");
      i += 1;
      start = i;
    } else if bytes[i] == b'\r' && i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
      parts.push(&text[start..i]);
      parts.push("\r\n");
      i += 2;
      start = i;
    } else {
      i += 1;
    }
  }
  parts.push(&text[start..]);
  if parts.last().is_some_and(|t| t.is_empty()) {
    parts.pop();
  }

  let mut ret: Vec<String> = Vec::new();
  for (idx, part) in parts.iter().enumerate() {
    if idx % 2 == 1 {
      // retLines[retLines.length - 1] += line — a separator is always
      // preceded by a (possibly empty) content token, so ret is non-empty.
      if let Some(last) = ret.last_mut() {
        last.push_str(part);
      }
    } else {
      ret.push((*part).to_string());
    }
  }
  ret.retain(|t| !t.is_empty());
  ret
}

// ── jsdiff Myers engine (diff/base.js) ───────────────────────────

/// A node of jsdiff's change linked list (`previousComponent`).
struct MyersComponent {
  count: i64,
  added: bool,
  removed: bool,
  previous: Option<usize>,
}

/// jsdiff `Path` — one best path per diagonal. Kept in a HashMap keyed by
/// the (possibly negative) diagonal, mirroring JS's sparse array.
#[derive(Clone, Copy)]
struct MyersPath {
  old_pos: i64,
  last_component: Option<usize>,
}

/// jsdiff `extractCommon`: extend the path along the common prefix at the
/// current positions, appending one equal component.
fn extract_common(
  base_path: &mut MyersPath,
  components: &mut Vec<MyersComponent>,
  diagonal_path: i64,
  old_tokens: &[&str],
  new_tokens: &[&str],
) -> i64 {
  let new_len = new_tokens.len() as i64;
  let old_len = old_tokens.len() as i64;
  let mut old_pos = base_path.old_pos;
  let mut new_pos = old_pos - diagonal_path;
  let mut common_count: i64 = 0;
  while new_pos + 1 < new_len
    && old_pos + 1 < old_len
    && old_tokens[(old_pos + 1) as usize] == new_tokens[(new_pos + 1) as usize]
  {
    new_pos += 1;
    old_pos += 1;
    common_count += 1;
  }
  if common_count > 0 {
    components.push(MyersComponent {
      count: common_count,
      previous: base_path.last_component,
      added: false,
      removed: false,
    });
    base_path.last_component = Some(components.len() - 1);
  }
  base_path.old_pos = old_pos;
  new_pos
}

/// jsdiff `addToPath` (`oneChangePerToken` is always false here): append an
/// add/remove step, merging with the previous component when it has the
/// same tag.
fn add_to_path(
  source: MyersPath,
  added: bool,
  removed: bool,
  old_pos_inc: i64,
  components: &mut Vec<MyersComponent>,
) -> MyersPath {
  let last = source.last_component;
  let same_tag = last.is_some_and(|l| {
    components[l].added == added && components[l].removed == removed
  });
  let component = if same_tag {
    let l = last.unwrap();
    MyersComponent {
      count: components[l].count + 1,
      added,
      removed,
      previous: components[l].previous,
    }
  } else {
    MyersComponent {
      count: 1,
      added,
      removed,
      previous: last,
    }
  };
  components.push(component);
  MyersPath {
    old_pos: source.old_pos + old_pos_inc,
    last_component: Some(components.len() - 1),
  }
}

/// jsdiff `buildValues`: walk the linked component list front-to-back and
/// join token slices into change values.
fn build_values(
  components: &[MyersComponent],
  head: Option<usize>,
  old_tokens: &[&str],
  new_tokens: &[&str],
) -> Vec<JsChange> {
  let mut indices: Vec<usize> = Vec::new();
  let mut cursor = head;
  while let Some(i) = cursor {
    indices.push(i);
    cursor = components[i].previous;
  }
  indices.reverse();

  let mut out: Vec<JsChange> = Vec::with_capacity(indices.len());
  let mut new_pos = 0usize;
  let mut old_pos = 0usize;
  for i in indices {
    let component = &components[i];
    let count = component.count as usize;
    if !component.removed {
      out.push(JsChange {
        value: new_tokens[new_pos..new_pos + count].concat(),
        count: component.count,
        added: component.added,
        removed: component.removed,
      });
      new_pos += count;
      if !component.added {
        old_pos += count;
      }
    } else {
      out.push(JsChange {
        value: old_tokens[old_pos..old_pos + count].concat(),
        count: component.count,
        added: component.added,
        removed: component.removed,
      });
      old_pos += count;
    }
  }
  out
}

/// jsdiff `Diff#diffWithOptionsObj` (sync mode, no options): Myers diff over
/// string tokens with jsdiff's exact tie-breaks — in particular the
/// `!canRemove || (canAdd && removePath.oldPos < addPath.oldPos)` rule that
/// decides between the add and remove branch. The deadline check is dropped
/// (napi exposes no timeout option) and maxEditLength is always
/// oldLen + newLen, which admits the delete-all + insert-all path, so the
/// loop always finishes; the trailing fallback is unreachable but keeps the
/// function total.
fn diff_tokens_to_changes(old_tokens: &[&str], new_tokens: &[&str]) -> Vec<JsChange> {
  let new_len = new_tokens.len() as i64;
  let old_len = old_tokens.len() as i64;
  let max_edit_length = new_len + old_len;

  let mut components: Vec<MyersComponent> = Vec::new();
  let mut best_path: HashMap<i64, MyersPath> = HashMap::new();
  best_path.insert(0, MyersPath { old_pos: -1, last_component: None });

  // Seed editLength = 0, i.e. the content starts with the same values.
  let seed_pos = extract_common(
    best_path.get_mut(&0).unwrap(),
    &mut components,
    0,
    old_tokens,
    new_tokens,
  );
  if best_path.get(&0).unwrap().old_pos + 1 >= old_len && seed_pos + 1 >= new_len {
    let head = best_path.get(&0).unwrap().last_component;
    return build_values(&components, head, old_tokens, new_tokens);
  }

  let mut min_diagonal_to_consider = i64::MIN;
  let mut max_diagonal_to_consider = i64::MAX;

  let mut edit_length: i64 = 1;
  while edit_length <= max_edit_length {
    // Start bound is computed once per edit length (as in jsdiff's for-loop
    // initializer); the end bound is re-evaluated every iteration because
    // maxDiagonalToConsider shrinks inside the loop body.
    let mut diagonal_path = min_diagonal_to_consider.max(-edit_length);
    while diagonal_path <= max_diagonal_to_consider.min(edit_length) {
      // removePath is consumed from the map (jsdiff clears the slot);
      // addPath stays in place.
      let remove_path = best_path.remove(&(diagonal_path - 1));
      let add_path = best_path.get(&(diagonal_path + 1)).copied();
      let add_path_new_pos = add_path.map(|p| p.old_pos - diagonal_path);
      let can_add = add_path_new_pos.is_some_and(|p| p >= 0 && p < new_len);
      let can_remove = remove_path.is_some_and(|p| p.old_pos + 1 < old_len);
      if !can_add && !can_remove {
        // If this path is a terminal then prune.
        best_path.remove(&diagonal_path);
        diagonal_path += 2;
        continue;
      }
      // Select the diagonal that we want to branch from — jsdiff's exact
      // tie-break (add wins when removePath.oldPos < addPath.oldPos).
      let mut base_path =
        if !can_remove || (can_add && remove_path.unwrap().old_pos < add_path.unwrap().old_pos) {
          add_to_path(add_path.unwrap(), true, false, 0, &mut components)
        } else {
          add_to_path(remove_path.unwrap(), false, true, 1, &mut components)
        };
      let new_pos = extract_common(
        &mut base_path,
        &mut components,
        diagonal_path,
        old_tokens,
        new_tokens,
      );
      if base_path.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
        // End of both token strings — done.
        let head = base_path.last_component;
        return build_values(&components, head, old_tokens, new_tokens);
      }
      best_path.insert(diagonal_path, base_path);
      if base_path.old_pos + 1 >= old_len {
        max_diagonal_to_consider = max_diagonal_to_consider.min(diagonal_path - 1);
      }
      if new_pos + 1 >= new_len {
        min_diagonal_to_consider = min_diagonal_to_consider.max(diagonal_path + 1);
      }
      diagonal_path += 2;
    }
    edit_length += 1;
  }

  // Unreachable (see doc comment); degrade to a full replacement so the
  // function stays total.
  vec![
    JsChange {
      value: old_tokens.concat(),
      count: old_len,
      added: false,
      removed: true,
    },
    JsChange {
      value: new_tokens.concat(),
      count: new_len,
      added: true,
      removed: false,
    },
  ]
}

/// Byte ranges of changed regions in each string; empty pair when the change
/// is too large (CHANGE_THRESHOLD) — jsdiff-exact tokenization + Myers.
fn word_diff_strings(old_str: &str, new_str: &str) -> (Vec<Range>, Vec<Range>) {
  let old_tokens = tokenize_words_with_space(old_str);
  let new_tokens = tokenize_words_with_space(new_str);
  let changes = diff_tokens_to_changes(&old_tokens, &new_tokens);

  let mut changed_len = 0usize;
  let mut old_ranges: Vec<Range> = Vec::new();
  let mut new_ranges: Vec<Range> = Vec::new();
  let mut old_off = 0usize;
  let mut new_off = 0usize;

  for change in &changes {
    let len = change.value.len();
    if change.removed {
      changed_len += len;
      old_ranges.push((old_off, old_off + len));
      old_off += len;
    } else if change.added {
      changed_len += len;
      new_ranges.push((new_off, new_off + len));
      new_off += len;
    } else {
      old_off += len;
      new_off += len;
    }
  }

  let total_len = old_str.len() + new_str.len();
  if total_len > 0 && (changed_len as f64) / (total_len as f64) > CHANGE_THRESHOLD {
    return (Vec::new(), Vec::new());
  }
  (old_ranges, new_ranges)
}

fn find_adjacent_pairs(markers: &[Marker]) -> Vec<(usize, usize)> {
  let mut pairs: Vec<(usize, usize)> = Vec::new();
  let mut i = 0usize;
  while i < markers.len() {
    if markers[i] == Marker::Del {
      let del_start = i;
      let mut del_end = i;
      while del_end < markers.len() && markers[del_end] == Marker::Del {
        del_end += 1;
      }
      let mut add_end = del_end;
      while add_end < markers.len() && markers[add_end] == Marker::Add {
        add_end += 1;
      }
      let del_count = del_end - del_start;
      let add_count = add_end - del_end;
      if del_count > 0 && add_count > 0 {
        let n = del_count.min(add_count);
        for k in 0..n {
          pairs.push((del_start + k, del_end + k));
        }
        i = add_end;
      } else {
        i = del_end;
      }
    } else {
      i += 1;
    }
  }
  pairs
}

// ── jsdiff-compatible line/word diffs (faithful jsdiff 8.0.4 port) ──

/// A jsdiff `Change`: { value, count, added, removed }.
#[napi(object)]
pub struct JsChange {
  pub value: String,
  pub count: i64,
  pub added: bool,
  pub removed: bool,
}

/// jsdiff `diffLines(old, new)` (default options).
#[napi]
pub fn diff_lines(old_str: String, new_str: String) -> Vec<JsChange> {
  let old_tokens = tokenize_lines_js(&old_str);
  let new_tokens = tokenize_lines_js(&new_str);
  let old_refs: Vec<&str> = old_tokens.iter().map(String::as_str).collect();
  let new_refs: Vec<&str> = new_tokens.iter().map(String::as_str).collect();
  diff_tokens_to_changes(&old_refs, &new_refs)
}

/// jsdiff `diffWordsWithSpace(old, new)` (default options).
#[napi]
pub fn diff_words_with_space(old_str: String, new_str: String) -> Vec<JsChange> {
  let old_tokens = tokenize_words_with_space(&old_str);
  let new_tokens = tokenize_words_with_space(&new_str);
  diff_tokens_to_changes(&old_tokens, &new_tokens)
}

// ── jsdiff-compatible structuredPatch ────────────────────────────

/// jsdiff `structuredPatch` hunk: { oldStart, oldLines, newStart, newLines,
/// lines } where `lines` carry ' '/'-'/'+' prefixes plus jsdiff's
/// "\\ No newline at end of file" markers.
#[napi(object)]
pub struct JsStructuredPatchHunk {
  pub old_start: i64,
  pub old_lines: i64,
  pub new_start: i64,
  pub new_lines: i64,
  pub lines: Vec<String>,
}

/// Split a jsdiff Change value into lines keeping the trailing newline
/// (except the final line when the value doesn't end with one) — port of
/// jsdiff's splitLines in patch/create.js.
fn split_change_lines(value: &str) -> Vec<String> {
  let has_trailing_nl = value.ends_with('\n');
  let mut result: Vec<String> = value.split('\n').map(|l| format!("{l}\n")).collect();
  if has_trailing_nl {
    result.pop();
  } else if let Some(last) = result.pop() {
    // Strip the newline we just appended; slicing one trailing ASCII byte
    // off a string ending in '\n' is always a char boundary.
    result.push(last[..last.len() - 1].to_string());
  }
  result
}

/// Assemble unified-diff hunks from a line-level change list — line-for-line
/// port of jsdiff's diffLinesResultToPatch (patch/create.js), including the
/// two-pass "no newline at end of file" marker handling and the
/// `lines.len() <= context * 2` hunk-overlap rule.
fn structured_patch_from_changes(changes: &[(bool, bool, String)], context: usize) -> Vec<JsStructuredPatchHunk> {
  // (added, removed, lines) — same shape jsdiff's assembly loop consumes.
  let mut diff: Vec<(bool, bool, Vec<String>)> = changes
    .iter()
    .map(|(added, removed, value)| (*added, *removed, split_change_lines(value)))
    .collect();
  // Append an empty value to make cleanup easier (jsdiff does the same).
  diff.push((false, false, Vec::new()));

  let mut hunks: Vec<JsStructuredPatchHunk> = Vec::new();
  // jsdiff uses 0 as the "no open range" sentinel; ranges never legitimately
  // start at 0 because line numbers are 1-based.
  let mut old_range_start: i64 = 0;
  let mut new_range_start: i64 = 0;
  let mut cur_range: Vec<String> = Vec::new();
  let mut old_line: i64 = 1;
  let mut new_line: i64 = 1;

  for (i, (added, removed, lines)) in diff.iter().enumerate() {
    let lines_len = lines.len() as i64;
    if *added || *removed {
      // If we have previous context, start with that
      if old_range_start == 0 {
        old_range_start = old_line;
        new_range_start = new_line;
        if i > 0 {
          let prev = &diff[i - 1].2;
          let ctx: Vec<String> = if context > 0 {
            let skip = prev.len().saturating_sub(context);
            prev[skip..].iter().map(|l| format!(" {l}")).collect()
          } else {
            Vec::new()
          };
          old_range_start -= ctx.len() as i64;
          new_range_start -= ctx.len() as i64;
          cur_range = ctx;
        }
      }
      // Output our changes
      let marker = if *added { '+' } else { '-' };
      for line in lines {
        cur_range.push(format!("{marker}{line}"));
      }
      // Track the updated file position
      if *added {
        new_line += lines_len;
      } else {
        old_line += lines_len;
      }
    } else {
      // Identical context lines. Track line changes
      if old_range_start != 0 {
        // Close out any changes that have been output (or join overlapping)
        // (i + 2 < diff.len() is jsdiff's `i < diff.length - 2`, written
        // subtraction-free so the usize arithmetic can't underflow)
        if lines.len() <= context * 2 && i + 2 < diff.len() {
          // Overlapping
          for line in lines {
            cur_range.push(format!(" {line}"));
          }
        } else {
          // End the range and output it
          let context_size = (lines.len()).min(context);
          for line in &lines[..context_size] {
            cur_range.push(format!(" {line}"));
          }
          hunks.push(JsStructuredPatchHunk {
            old_start: old_range_start,
            old_lines: old_line - old_range_start + context_size as i64,
            new_start: new_range_start,
            new_lines: new_line - new_range_start + context_size as i64,
            lines: std::mem::take(&mut cur_range),
          });
          old_range_start = 0;
          new_range_start = 0;
        }
      }
      old_line += lines_len;
      new_line += lines_len;
    }
  }

  // Step 2: eliminate the trailing \n from each line of each hunk, and, where
  // needed, add "\ No newline at end of file".
  for hunk in &mut hunks {
    let mut out: Vec<String> = Vec::with_capacity(hunk.lines.len());
    for line in &hunk.lines {
      if let Some(stripped) = line.strip_suffix('\n') {
        out.push(stripped.to_string());
      } else {
        out.push(line.clone());
        out.push("\\ No newline at end of file".to_string());
      }
    }
    hunk.lines = out;
  }
  hunks
}

/// jsdiff `structuredPatch(old, new, { context }).hunks`: unified-diff hunks
/// with ' '/'-'/'+' prefixed lines and "\ No newline at end of file" markers.
/// Both the line diff and the hunk assembly are faithful ports of jsdiff
/// 8.0.4, so the output is byte-identical to the `diff` npm package.
#[napi]
pub fn structured_patch(
  old_str: String,
  new_str: String,
  context: Option<i64>,
) -> Vec<JsStructuredPatchHunk> {
  let context = context.unwrap_or(4).max(0) as usize;
  let changes = diff_lines(old_str, new_str);
  let changes: Vec<(bool, bool, String)> = changes
    .into_iter()
    .map(|c| (c.added, c.removed, c.value))
    .collect();
  structured_patch_from_changes(&changes, context)
}

// ── Transform pipeline (port of TS) ──────────────────────────────

struct Highlight {
  marker: Option<Marker>,
  line_number: usize,
  lines: Vec<Vec<Block>>,
}

fn remove_newlines(h: &mut Highlight) {
  h.lines = h
    .lines
    .iter()
    .map(|line| {
      line
        .iter()
        .flat_map(|(style, text)| {
          text
            .split('\n')
            .filter(|p| !p.is_empty())
            .map(|p| (*style, p.to_string()))
            .collect::<Vec<Block>>()
        })
        .collect::<Vec<Block>>()
    })
    .collect();
}

fn char_width(ch: char) -> usize {
  ch.width().unwrap_or(0)
}

fn wrap_text(h: &mut Highlight, width: usize, theme: &Theme) {
  let mut new_lines: Vec<Vec<Block>> = Vec::new();
  for line in &h.lines {
    let mut queue: Vec<Block> = line.clone();
    let mut cur: Vec<Block> = Vec::new();
    let mut cur_w = 0usize;
    while !queue.is_empty() {
      let (style, text) = queue.remove(0);
      let tw = text.width();
      if cur_w + tw <= width {
        cur.push((style, text));
        cur_w += tw;
      } else {
        let remaining = width.saturating_sub(cur_w);
        let mut byte_pos = 0usize;
        let mut acc_w = 0usize;
        for ch in text.chars() {
          let cw = char_width(ch);
          if acc_w + cw > remaining {
            break;
          }
          acc_w += cw;
          byte_pos += ch.len_utf8();
        }
        if byte_pos == 0 {
          if cur_w == 0 {
            // Fresh line and first char still doesn't fit — force one
            // codepoint to guarantee forward progress.
            let first = text.chars().next().unwrap_or(' ');
            byte_pos = first.len_utf8();
          } else {
            new_lines.push(std::mem::take(&mut cur));
            queue.insert(0, (style, text));
            cur_w = 0;
            continue;
          }
        }
        let rest = text[byte_pos..].to_string();
        cur.push((style, text[..byte_pos].to_string()));
        new_lines.push(std::mem::take(&mut cur));
        queue.insert(0, (style, rest));
        cur_w = 0;
      }
    }
    new_lines.push(cur);
  }
  h.lines = new_lines;

  // Pad changed lines so background extends to edge
  if let Some(m) = h.marker {
    if m != Marker::Ctx {
      let bg = line_background(m, theme);
      let pad_style = (theme.foreground, bg);
      for line in &mut h.lines {
        let cur_w: usize = line.iter().map(|(_, t)| t.width()).sum();
        if cur_w < width {
          line.push((pad_style, " ".repeat(width - cur_w)));
        }
      }
    }
  }
}

fn add_line_number(
  h: &mut Highlight,
  theme: &Theme,
  max_digits: usize,
  full_dim: bool,
) {
  let style = (
    match h.marker {
      Some(m) => decoration_color(m, theme),
      None => theme.foreground,
    },
    match h.marker {
      Some(m) => line_background(m, theme),
      None => theme.background,
    },
  );
  let should_dim = matches!(h.marker, None | Some(Marker::Ctx));
  for (i, line) in h.lines.iter_mut().enumerate() {
    let prefix = if i == 0 {
      format!(" {:>width$} ", h.line_number, width = max_digits)
    } else {
      " ".repeat(max_digits + 2)
    };
    let wrapped = if should_dim && !full_dim {
      format!("{DIM}{prefix}{UNDIM}")
    } else {
      prefix
    };
    line.insert(0, (style, wrapped));
  }
}

fn add_marker(h: &mut Highlight, theme: &Theme) {
  let Some(m) = h.marker else { return };
  let style = (decoration_color(m, theme), line_background(m, theme));
  let marker_ch = match m {
    Marker::Add => '+',
    Marker::Del => '-',
    Marker::Ctx => ' ',
  };
  for line in &mut h.lines {
    line.insert(0, (style, marker_ch.to_string()));
  }
}

fn dim_content(h: &mut Highlight) {
  for line in &mut h.lines {
    if !line.is_empty() {
      line[0].1 = format!("{DIM}{}", line[0].1);
      let last = line.len() - 1;
      line[last].1 = format!("{}{UNDIM}", line[last].1);
    }
  }
}

fn apply_background(h: &mut Highlight, theme: &Theme, ranges: &[Range]) {
  let Some(m) = h.marker else { return };
  let line_bg = line_background(m, theme);
  let word_bg = word_background(m, theme);

  let mut range_idx = 0usize;
  let mut byte_off = 0usize;
  for line in &mut h.lines {
    let mut new_line: Vec<Block> = Vec::new();
    for (style, text) in &mut *line {
      let text_start = byte_off;
      let text_end = byte_off + text.len();
      while range_idx < ranges.len() && ranges[range_idx].1 <= text_start {
        range_idx += 1;
      }
      if range_idx >= ranges.len() {
        new_line.push(((style.0, line_bg), std::mem::take(text)));
        byte_off = text_end;
        continue;
      }

      let mut pos = text_start;
      while pos < text_end && range_idx < ranges.len() {
        let r = ranges[range_idx];
        let in_range = pos >= r.0 && pos < r.1;
        let next: usize = if in_range {
          r.1.min(text_end)
        } else if r.0 > pos && r.0 < text_end {
          r.0
        } else {
          text_end
        };
        let seg_len = next - pos;
        let seg: String = text[pos - text_start..pos - text_start + seg_len]
          .to_string();
        new_line.push((
          (style.0, if in_range { word_bg } else { line_bg }),
          seg,
        ));
        pos = next;
        if pos >= r.1 {
          range_idx += 1;
        }
      }
      if pos < text_end {
        new_line.push(((style.0, line_bg), text[pos - text_start..].to_string()));
      }
      byte_off = text_end;
    }
    *line = new_line;
  }
}

fn into_lines(h: &Highlight, dim: bool, skip_bg: bool, mode: ColorMode) -> Vec<String> {
  h.lines
    .iter()
    .map(|line| as_terminal_escaped(line, mode, skip_bg, dim))
    .collect()
}

// ── Public API ───────────────────────────────────────────────────

fn max_line_number(old_start: i64, old_lines: i64, new_start: i64, new_lines: i64) -> i64 {
  let old_end = (old_start + old_lines - 1).max(0);
  let new_end = (new_start + new_lines - 1).max(0);
  old_end.max(new_end)
}

/// A unified-diff hunk to render with syntax highlighting and word diff.
#[napi(object)]
pub struct Hunk {
  pub old_start: i64,
  pub old_lines: i64,
  pub new_start: i64,
  pub new_lines: i64,
  pub lines: Vec<String>,
}

#[napi]
pub struct ColorDiff {
  hunk: Hunk,
  file_path: String,
  first_line: Option<String>,
  prefix_content: Option<String>,
}

#[napi]
impl ColorDiff {
  #[napi(constructor)]
  pub fn new(
    hunk: Hunk,
    first_line: Option<String>,
    file_path: String,
    prefix_content: Option<String>,
  ) -> Self {
    ColorDiff {
      hunk,
      file_path,
      first_line,
      prefix_content,
    }
  }

  /// Render the hunk to terminal-colored lines. Returns null inputs are
  /// invalid (parity: TS returns arrays; null only from native on error).
  #[napi]
  pub fn render(&self, theme_name: String, width: i64, dim: bool) -> Option<Vec<String>> {
    if width < 1 {
      return None;
    }
    let mode = detect_color_mode(&theme_name);
    let theme = build_theme(&theme_name, mode);
    let syntax = detect_language(&self.file_path, self.first_line.as_deref());
    let mut highlighter = syntax.map(Highlighter::new);

    // Warm highlighter with prefix content (original stateful behavior).
    if let (Some(hl), Some(prefix)) = (highlighter.as_mut(), self.prefix_content.as_deref()) {
      hl.warm(prefix);
    }

    let max_digits = max_line_number(
      self.hunk.old_start,
      self.hunk.old_lines,
      self.hunk.new_start,
      self.hunk.new_lines,
    )
    .to_string()
    .len();
    let mut old_line = self.hunk.old_start;
    let mut new_line = self.hunk.new_start;
    let effective_width = ((width - max_digits as i64 - 2 - 1).max(1)) as usize;

    // First pass: assign markers + line numbers
    struct Entry {
      line_number: i64,
      marker: Marker,
      code: String,
    }
    let entries: Vec<Entry> = self
      .hunk
      .lines
      .iter()
      .map(|raw_line| {
        let first = raw_line.chars().next().unwrap_or(' ');
        let marker = match first {
          '+' => Marker::Add,
          '-' => Marker::Del,
          _ => Marker::Ctx,
        };
        let code: String = raw_line.chars().skip(1).collect();
        let line_number = match marker {
          Marker::Add => {
            let n = new_line;
            new_line += 1;
            n
          }
          Marker::Del => {
            let n = old_line;
            old_line += 1;
            n
          }
          Marker::Ctx => {
            let n = new_line;
            old_line += 1;
            new_line += 1;
            n
          }
        };
        Entry {
          line_number,
          marker,
          code,
        }
      })
      .collect();

    // Word-diff ranges (skip when dim — too loud)
    let mut ranges: Vec<Vec<Range>> = entries.iter().map(|_| Vec::new()).collect();
    if !dim {
      let markers: Vec<Marker> = entries.iter().map(|e| e.marker).collect();
      for (del_idx, add_idx) in find_adjacent_pairs(&markers) {
        let (del_r, add_r) = word_diff_strings(
          &entries[del_idx].code,
          &entries[add_idx].code,
        );
        ranges[del_idx] = del_r;
        ranges[add_idx] = add_r;
      }
    }

    // Second pass: highlight + transform pipeline
    let mut out: Vec<String> = Vec::new();
    for (i, entry) in entries.iter().enumerate() {
      let tokens: Vec<Block> = match (&mut highlighter, entry.marker) {
        // Deleted lines render plain (delete background applied later);
        // parity with the verified TS pipeline.
        (Some(hl), Marker::Add | Marker::Ctx) => hl.highlight_line(&entry.code, &theme),
        (None, _) => vec![(default_style(&theme), entry.code.clone())],
        (Some(_), Marker::Del) => vec![(default_style(&theme), entry.code.clone())],
      };

      let mut h = Highlight {
        marker: Some(entry.marker),
        line_number: entry.line_number.max(0) as usize,
        lines: vec![tokens],
      };
      remove_newlines(&mut h);
      apply_background(&mut h, &theme, &ranges[i]);
      wrap_text(&mut h, effective_width, &theme);
      if matches!(mode, ColorMode::Ansi) && entry.marker == Marker::Del {
        dim_content(&mut h);
      }
      add_marker(&mut h, &theme);
      add_line_number(&mut h, &theme, max_digits, dim);
      out.extend(into_lines(&h, dim, false, mode));
    }
    Some(out)
  }
}

#[napi]
pub struct ColorFile {
  code: String,
  file_path: String,
}

#[napi]
impl ColorFile {
  #[napi(constructor)]
  pub fn new(code: String, file_path: String) -> Self {
    ColorFile { code, file_path }
  }

  #[napi]
  pub fn render(&self, theme_name: String, width: i64, dim: bool) -> Option<Vec<String>> {
    if width < 1 {
      return None;
    }
    let mode = detect_color_mode(&theme_name);
    let theme = build_theme(&theme_name, mode);
    let mut lines: Vec<&str> = self.code.split('\n').collect();
    // Rust .lines() drops trailing empty line from trailing \n
    if lines.last() == Some(&"") {
      lines.pop();
    }
    let first_line = lines.first().copied();
    let syntax = detect_language(&self.file_path, first_line);
    let mut highlighter = syntax.map(Highlighter::new);

    let max_digits = lines.len().to_string().len();
    let effective_width = ((width - max_digits as i64 - 2).max(1)) as usize;

    let mut out: Vec<String> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
      let tokens: Vec<Block> = match &mut highlighter {
        Some(hl) => hl.highlight_line(line, &theme),
        None => vec![(default_style(&theme), (*line).to_string())],
      };
      let mut h = Highlight {
        marker: None,
        line_number: i + 1,
        lines: vec![tokens],
      };
      remove_newlines(&mut h);
      wrap_text(&mut h, effective_width, &theme);
      add_line_number(&mut h, &theme, max_digits, dim);
      out.extend(into_lines(&h, dim, true, mode));
    }
    Some(out)
  }
}

/// The active syntax theme for a Claude theme name.
#[napi(object)]
pub struct SyntaxTheme {
  pub theme: String,
  pub source: Option<String>,
}

#[napi]
pub fn get_syntax_theme(theme_name: String) -> SyntaxTheme {
  // When BAT_THEME selects a loadable .tmTheme, it IS the active theme —
  // report its name truthfully. Otherwise the built-in tables render.
  if let Some((_, name)) = custom_theme() {
    return SyntaxTheme {
      theme: name.clone(),
      source: std::env::var("CLAUDE_CODE_SYNTAX_HIGHLIGHT")
        .or_else(|_| std::env::var("BAT_THEME"))
        .ok(),
    };
  }
  let theme = if theme_name.contains("ansi") {
    "ansi"
  } else if theme_name.contains("dark") {
    "Monokai Extended"
  } else {
    "GitHub"
  };
  SyntaxTheme {
    theme: theme.to_string(),
    source: None,
  }
}

/// Native capability probe.
#[napi]
pub fn has_native_color_diff() -> bool {
  true
}
