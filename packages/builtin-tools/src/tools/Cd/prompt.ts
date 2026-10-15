export const DESCRIPTION =
  'Change the session working directory. Subsequent tool calls and relative ' +
  'paths resolve from the new directory.'

export const PROMPT = `Changes the session's working directory.

- Accepts absolute paths, paths relative to the current working directory,
  and \`~\`-prefixed paths (expanded to the user's home directory).
- The target must exist and be a directory.
- On success the session cwd is updated: file tools, relative paths and the
  persistent shell all resolve from the new directory afterwards.
- Directory moves are subject to permission rules: \`Cd\` deny rules block
  matching directories outright, and if \`Cd\` allow rules exist the target's
  realpath must match one of them (realpath escapes outside the rule root are
  refused).`
