# Smart Commit

Ship the current work: update tracking files, run tests, fix breakage, commit, and push.

## Instructions

### 1. Understand the changes

Run `git status` and `git diff` (staged + unstaged) to see everything that changed.

### 2. Update tracking files

**`todo.md`** — Mark completed items as done or remove them. If the work was tagged `[planned]`, remove it from Upcoming.

**`plan.md`** — For any plan item that was just implemented:
- Change its **Status** to `done`
- If ALL items in plan.md are done, clear the completed plans from the file (keep the header and `---` separator)

**`FEATURES.md`** — For each completed plan item, add an entry:
```markdown
## <Feature Name>
<Brief description of what it does>

- Key capability 1
- Key capability 2
```
Create the file if it doesn't exist. Append new features; don't overwrite existing ones.

### 3. Run tests and fix breakage

Run the test suite: `bin/test` (or `cd daemon && npm test` + `cd web && npx tsc --noEmit` if bin/test isn't available).

If tests fail:
- Fix the failing tests or code
- Re-run to confirm green
- Repeat until all pass

Do NOT skip or disable tests to make them pass.

### 4. Stage and commit

Stage all relevant files (including the tracking file updates). Never stage `.env`, credentials, secrets, or `node_modules/`.

Generate a commit message:
- First line: concise summary describing the user-visible change (not just "update files")
- Body: explain the "why" briefly, list key changes
- Include tracking file updates as a secondary note, not the headline

Commit without asking for confirmation — the user invoked `/commit` to ship it.

### 5. Push

Push to the current remote branch. If there's no upstream, push with `-u origin <branch>`.

## Rules

- Never commit .env, credentials, or secrets
- Never amend without explicit request
- Never force-push
- If tests can't be fixed after 2 attempts, stop and report the failures instead of committing broken code
