#!/usr/bin/env bash
# PostToolUse (Edit|Write|MultiEdit): run the tests related to the edited file.
#
# - Only source files of this project (ts/tsx/js/mjs/cjs), never dist/node_modules.
# - `bin/test --fast --direct --quiet <file>`: same-name test if there is one,
#   else jest/vitest related tests. Silent on pass.
# - Hard 60 s timeout. A run already in flight for this project = skip (no pile-ups).
# - On failure: exit 2 with the failure blocks on stderr, so Claude sees them.
set -u
PROJECT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

f=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)
[ -n "$f" ] || exit 0
case "$f" in /*) ;; *) f="$PROJECT/$f" ;; esac
case "$f" in "$PROJECT"/*) ;; *) exit 0 ;; esac
case "$f" in
  */node_modules/*|*/dist/*|*/dist-desktop/*|*/coverage/*|*/.claude/*) exit 0 ;;
  *.ts|*.tsx|*.js|*.mjs|*.cjs) ;;
  *) exit 0 ;;
esac
[ -f "$f" ] || exit 0

lock="${XDG_RUNTIME_DIR:-/tmp}/fast-test-$(printf '%s' "$PROJECT" | md5sum | cut -c1-12).lock"
exec 9>"$lock"
flock -n 9 || exit 0   # another related-test run for this project is in flight

out=$(timeout -k 5 60 "$PROJECT/bin/test" --fast --direct --quiet "$f" 2>&1)
rc=$?
[ $rc -eq 0 ] && exit 0
if [ $rc -eq 124 ] || [ $rc -eq 137 ]; then
  echo "fast-test: related tests for ${f#$PROJECT/} timed out after 60 s (not a failure; run bin/test --fast ${f#$PROJECT/} yourself)" >&2
  exit 0
fi
{ echo "Related tests FAILED after editing ${f#$PROJECT/}:"; printf '%s\n' "$out" | tail -n 80; } >&2
exit 2
