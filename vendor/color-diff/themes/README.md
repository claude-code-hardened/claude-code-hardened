# Vendored .tmTheme themes

Original TextMate theme files used with the color-diff BAT_THEME
interpreter (set `BAT_THEME` to one of these files' paths).

| File | Upstream | Source repo |
|------|----------|-------------|
| `Monokai Extended.tmTheme` | Monokai Extended | github.com/jonschlinkert/sublime-monokai-extended |
| `GitHub.tmTheme` | GitHub Sublime theme | github.com/AlexanderEkdahl/github-sublime-theme |

Both repos are vendored by the bat project (MIT) as git submodules; the
theme assets carry their upstream licenses. Colors in the built-in
tables of `packages/color-diff-napi` were measured from the original
native module's output and cross-verified against these files
(comment/string/keyword.operator/defaultFg all match exactly).
