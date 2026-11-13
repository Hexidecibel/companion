# Claude Code contract tests (AskUserQuestion)

Companion answers Claude Code's AskUserQuestion (AUQ) box by reading the tmux pane and pressing keys. Nothing about that box is a public API: the layout, the footer text, the keys and the transcript shape can change in any Claude Code release. Two layers catch that.

## 1. Fixture tests (every `bin/test`)

`daemon/src/__tests__/fixtures/cc-contract/` holds real ANSI pane captures from a real Claude Code (file names carry the version, e.g. `auq-cc2.1.323-multi-question-w120-s2.txt`), the parse each one must give (`.expected.json`) and a sanitized transcript pair (`.jsonl`: the `tool_use` block and the user entry with `tool_result` + `toolUseResult`).

- `auq-contract-fixtures.test.ts`: each capture parses to its expected view (`auqContractView` in `daemon/src/agents/claude/auq-contract.ts`), with no unparsed lines and a known footer. The JSONL shape is checked as well.
- `auq-driver.test.ts`: the step-by-step driver (`auq-driver.ts`) against a fake pane that moves between real captures on the keys the picker reacts to.
- `live-auq-state.test.ts`, `input-injector-auq.test.ts`, `live-choice-watch.test.ts`: the chat card state, the injector and the live follow of the box.

## 2. Live canary (`bin/test-cc-contract`)

Starts the installed `claude` (haiku model) on a **private** tmux server in `~/.companion/cc-contract/work`, has it ask nine scripted AUQ scenarios (single, single + Other, multi-select, three questions with back/review/submit, previews, long labels at widths 120/80/60), answers each one through the real `InputInjector`, and checks:

- every screen parses exactly like the scenario expects (strict compare, known footer);
- the injector reports the right outcome (answered / next_question / review / submitted / navigated);
- the transcript gets the matching `tool_use` + `tool_result` with the same answers;
- `away_summary` entries in the last 30 days still have the known keys.

Flags: `--if-changed` (skip when the installed Claude Code version already passed; state in `~/.companion/cc-contract/state.json`), `--out <dir>` (where captures go), `--keep`, `--only <scenario>`. On failure it writes `drift.txt` in the out dir with every mismatch. Costs a few haiku calls on the user's own Claude login.

Promote a passing run's captures into fixtures when Claude Code changes: copy the out dir's `.txt` / `.expected.json` / `.jsonl` (not `.got.json` or `drift.txt`) into `daemon/src/__tests__/fixtures/cc-contract/` and update the version in the test file names.

Daily cron (runs only when Claude Code was updated):

```
0 6 * * * cd /home/hexi/local/src/companion && bin/test-cc-contract --if-changed >> ~/.companion/cc-contract/cron.log 2>&1
```

## Known limits

- Preview panels are not shown in the chat (only the labels; the card says the preview is in the terminal). Claude Code draws no option descriptions in preview boxes.
- Multi-select with more than 9 rows is refused (digits only reach 1-9).
- The chat follows the terminal by polling the pane (the box is not in the transcript until answered).
