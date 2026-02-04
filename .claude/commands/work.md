# Work on Planned Items

Implement items from plan.md using TDD. If multiple items can be parallelized, spawn worker sessions.

## Instructions

1. Read `plan.md`

2. Find ALL items with **Status: planned** or **Status: in-progress**

3. **If 2+ planned items exist, analyze parallelism:**

   a. For each item, look at the "Files to Modify" section
   b. Compare file lists between items — items with NO shared files can run in parallel
   c. Group items into:
      - **Parallel group**: Items with non-overlapping files
      - **Sequential group**: Items that share files with another item

   d. Present the analysis via AskUserQuestion:
      - Show which items can be parallelized and why
      - Show which items must be sequential and why (list shared files)
      - Options: [Parallelize] [Work sequentially] [Let me choose]

   e. If user approves parallelization, spawn worker sessions:
      ```bash
      # Call the companion daemon API to spawn a work group
      curl -s -X POST http://localhost:9877 \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $(cat /etc/companion/config.json | grep token | cut -d'"' -f4)" \
        -d '{
          "type": "spawn_work_group",
          "requestId": "work-'$(date +%s)'",
          "payload": {
            "name": "<descriptive group name>",
            "foremanSessionId": "<this session ID>",
            "foremanTmuxSession": "<this tmux session>",
            "parentDir": ".",
            "planFile": "plan.md",
            "workers": [
              {
                "taskSlug": "<item-slug>",
                "taskDescription": "<brief description>",
                "planSection": "<full plan section text for this item>",
                "files": ["<file1>", "<file2>"]
              }
            ]
          }
        }'
      ```

   f. After spawning, continue working on sequential items (if any) using TDD
   g. When done with sequential items, check worker status and report:
      - "Workers still running — monitor from dashboard."
      - Or if all complete: proceed to merge step

4. **If only 1 item, or user chose sequential:** Follow TDD for each item:

   a. **Write tests first**
      - Create/update test files based on "Tests Needed" section
      - Run tests - they should fail (red)

   b. **Implement the feature**
      - Follow the "Implementation Steps" from plan
      - Make tests pass (green)
      - Run `npx tsc --noEmit` to type check

   c. **Refactor if needed**
      - Clean up code while keeping tests green

   d. **Commit**
      - Commit with descriptive message
      - Update plan.md status to "done"

5. When ALL items in plan.md are done (including any parallel workers):

   a. **If workers were spawned, merge their branches:**
      ```bash
      curl -s -X POST http://localhost:9877 \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $(cat /etc/companion/config.json | grep token | cut -d'"' -f4)" \
        -d '{
          "type": "merge_work_group",
          "requestId": "merge-'$(date +%s)'",
          "payload": { "groupId": "<group-id-from-spawn>" }
        }'
      ```

   b. **Update FEATURES.md**
      - Compile completed features into `FEATURES.md`
      - Format for GitHub README showcase
      ```markdown
      ## <Feature Name>
      <Brief description>

      - Key capability 1
      - Key capability 2
      ```

   c. **Report completion**
      - List all commits made (including worker commits)
      - Show updated FEATURES.md content
      - Ask if ready to push

## Rules

- Tests first, always
- Commit after each completed item
- NO push without explicit approval
- NO EAS builds without approval
- Ask if stuck or unclear
- When spawning workers, each worker handles ONE plan item only
- Workers should not modify files outside their scope
