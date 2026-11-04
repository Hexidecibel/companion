// Daemon test files that only pass on Linux. bin/test runs the rest of the daemon suite on the
// Mac mini (DAEMON_TEST_SPLIT=portable) and these locally in the same invocation
// (DAEMON_TEST_SPLIT=linux-only). Found empirically on macOS 27 / node 26 (2026-11-04).
// Add a file here when it reads procfs, tmux, or GNU-only tool behaviour.
module.exports = [
  '__tests__/impact.test.ts', //                    reads /proc/self/stat and swap
  '__tests__/watcher-shared-folder.test.ts', //     maps sessions via /proc/<pid> (cwd, open tasks dir)
  '__tests__/watcher-profiles.test.ts', //          reads the agent's /proc/<pid>/environ
  '__tests__/watcher-codex-isolation.test.ts', //   process lookup via /proc
  '__tests__/remove-session-ownership.test.ts', //  running-process ownership via /proc
  '__tests__/herald-cush.test.ts', //               /etc is a symlink to /private/etc on macOS
  'src/profiles/__tests__/login-flow.test.ts', //   GNU ls exit code (2) vs BSD ls (1)
];
