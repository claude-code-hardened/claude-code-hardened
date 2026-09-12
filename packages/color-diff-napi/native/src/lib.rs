//! Rust restoration of the original color-diff native module
//! (vendor/color-diff-src was lost; the TypeScript port in ../src was a
//! stand-in using highlight.js). This crate restores the original design:
//! syntect for syntax tokenization (stateful — multi-line strings/comments
//! highlight correctly, unlike hljs line-by-line), the `similar` Myers
//! algorithm for word diffing, and the measured scope-color tables so the
//! output colors match what the original produced.
//!
//! The transform pipeline (markers, backgrounds, wrapping, line numbers,
//! dimming) is a line-for-line port of the TS port, which itself was
//! verified output-identical in structure to the original native module.

use std::sync::OnceLock;

use napi::bindgen_prelude::*;
use napi::Result;
use napi_derive::napi;
use similar::algorithms::{diff, Algorithm, DiffHook};
use syntect::parsing::{ParseState, ScopeStack, ScopeStackOp, SyntaxSet};
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
fn filename_language(base: &str) -> Option<&'static str> {
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
    if let Some(m) = item.scope.does_match(stack) {
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
        Some(((s, _), t)) if s.0 == fg => t.push_str(&block.1),
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

// ── Word diff (similar crate, Myers on tokens) ───────────────────

type Range = (usize, usize);

const CHANGE_THRESHOLD: f64 = 0.4;

/// Tokenize into word runs, whitespace runs, and single punctuation chars —
/// identical splitting to the TS tokenize() (mirrors diffWordsWithSpace).
fn tokenize(text: &str) -> Vec<&str> {
  let mut tokens: Vec<&str> = Vec::new();
  let bytes = text.as_bytes();
  let mut i = 0usize;
  while i < bytes.len() {
    let b = bytes[i];
    let is_word = b.is_ascii_alphanumeric() || b == b'_';
    let is_ws = b.is_ascii_whitespace();
    if is_word || (b >= 0x80 && {
      let ch = text[i..].chars().next().unwrap_or(' ');
      ch.is_alphanumeric() || ch == '_'
    }) {
      let mut j = i + 1;
      while j < bytes.len() {
        let b2 = bytes[j];
        let w = b2.is_ascii_alphanumeric()
          || b2 == b'_'
          || (b2 >= 0x80 && {
            let ch = text[j..].chars().next().unwrap_or(' ');
            ch.is_alphanumeric() || ch == '_'
          });
        if !w {
          break;
        }
        j += text[j..]
          .chars()
          .next()
          .map(|c| c.len_utf8())
          .unwrap_or(1);
      }
      tokens.push(&text[i..j]);
      i = j;
    } else if is_ws {
      let mut j = i + 1;
      while j < bytes.len() && bytes[j].is_ascii_whitespace() {
        j += 1;
      }
      tokens.push(&text[i..j]);
      i = j;
    } else {
      let len = text[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
      tokens.push(&text[i..i + len]);
      i += len;
    }
  }
  tokens
}

/// Collect (tag, old_range, new_range) ops from the Myers diff of tokens.
#[derive(Default)]
struct RangeSink {
  ops: Vec<(similar::DifferenceTag, usize, usize, usize, usize)>,
}

impl DiffHook for RangeSink {
  type Diff = ();

  fn equal(
    &mut self,
    old_index: usize,
    new_index: usize,
    len: usize,
  ) -> Result<(), ()> {
    self.ops.push((
      similar::DifferenceTag::Equal,
      old_index,
      new_index,
      len,
      0,
    ));
    Ok(())
  }

  fn delete(
    &mut self,
    old_index: usize,
    old_len: usize,
    new_index: usize,
  ) -> Result<(), ()> {
    self.ops.push((
      similar::DifferenceTag::Delete,
      old_index,
      new_index,
      old_len,
      0,
    ));
    Ok(())
  }

  fn insert(
    &mut self,
    old_index: usize,
    new_index: usize,
    new_len: usize,
  ) -> Result<(), ()> {
    self.ops.push((
      similar::DifferenceTag::Insert,
      old_index,
      new_index,
      new_len,
      0,
    ));
    Ok(())
  }

  fn replace(
    &mut self,
    old_index: usize,
    old_len: usize,
    new_index: usize,
    new_len: usize,
  ) -> Result<(), ()> {
    self.ops.push((
      similar::DifferenceTag::Replace,
      old_index,
      new_index,
      old_len,
      new_len,
    ));
    Ok(())
  }

  fn finish(&mut self) -> Result<(), Self::Diff> {
    Ok(())
  }
}

/// Byte ranges of changed regions in each string; empty pair when the change
/// is too large (CHANGE_THRESHOLD) — identical to the TS wordDiffStrings.
fn word_diff_strings(old_str: &str, new_str: &str) -> (Vec<Range>, Vec<Range>) {
  let old_tokens = tokenize(old_str);
  let new_tokens = tokenize(new_str);

  let mut sink = RangeSink::default();
  let _ = diff(
    Algorithm::Myers,
    &old_tokens,
    &new_tokens,
    &mut sink,
  );

  let total_len = old_str.len() + new_str.len();
  let mut changed_len = 0usize;
  let mut old_ranges: Vec<Range> = Vec::new();
  let mut new_ranges: Vec<Range> = Vec::new();
  let mut old_off = 0usize;
  let mut new_off = 0usize;

  for (tag, oi, ni, ol, nl) in sink.ops {
    let old_len: usize = old_tokens[oi..oi + ol].iter().map(|t| t.len()).sum();
    let new_len: usize = new_tokens[ni..ni + nl].iter().map(|t| t.len()).sum();
    match tag {
      similar::DifferenceTag::Delete => {
        changed_len += old_len;
        old_ranges.push((old_off, old_off + old_len));
        old_off += old_len;
      }
      similar::DifferenceTag::Insert => {
        changed_len += new_len;
        new_ranges.push((new_off, new_off + new_len));
        new_off += new_len;
      }
      similar::DifferenceTag::Replace => {
        changed_len += old_len + new_len;
        old_ranges.push((old_off, old_off + old_len));
        new_ranges.push((new_off, new_off + new_len));
        old_off += old_len;
        new_off += new_len;
      }
      similar::DifferenceTag::Equal => {
        old_off += old_len;
        new_off += new_len;
      }
    }
  }

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

/// Runtime theme export: serialize the ACTIVE theme — a BAT_THEME-loaded
/// .tmTheme when set (all its selector rules), otherwise the built-in
/// measured tables for the given Claude theme name. Returns JSON:
/// { name, source, foreground, rules: { selector: "#RRGGBB" } }.
#[napi]
pub fn export_active_theme(theme_name: String) -> Option<String> {
  let (name, source, rules): (String, Option<String>, Vec<(String, String)>) =
    if let Some((theme, cname)) = custom_theme() {
      let source = std::env::var("CLAUDE_CODE_SYNTAX_HIGHLIGHT")
        .or_else(|_| std::env::var("BAT_THEME"))
        .ok();
      let mut rules = Vec::new();
      for item in &theme.scopes {
        if let Some(fg) = item.style.foreground {
          rules.push((
            item.scope.to_string(),
            format!("#{:02x}{:02x}{:02x}", fg.r, fg.g, fg.b),
          ));
        }
      }
      (cname.clone(), source, rules)
    } else {
      let mode = detect_color_mode(&theme_name);
      let theme = build_theme(&theme_name, mode);
      let mut rules = Vec::new();
      for (key, color) in theme.scopes.map {
        rules.push((
          (*key).to_string(),
          format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b),
        ));
      }
      (theme_name, None, rules)
    };

  let mut json = String::with_capacity(256 + rules.len() * 32);
  let esc = |s: &str| -> String {
    s.replace('\\', "\\\\")
      .replace('"', "\\\"")
      .replace('\n', "\\n")
  };
  json.push_str(&format!("{{\"name\":\"{}\"", esc(&name)));
  json.push_str(",\"source\":");
  match &source {
    Some(s) => json.push_str(&format!("\"{}\"", esc(s))),
    None => json.push_str("null"),
  }
  json.push_str(",\"rules\":{");
  for (i, (sel, hex)) in rules.iter().enumerate() {
    if i > 0 {
      json.push(',');
    }
    json.push_str(&format!("\"{}\":\"{}\"", esc(sel), hex));
  }
  json.push_str("}}");
  Some(json)
}
