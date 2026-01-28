# Work on Planned Items

Implement items from plan.md using TDD.

## Instructions

1. Read `/Users/chriscushman/local/src/claude-companion/plan.md`

2. Find the next item with **Status: planned** or **Status: in-progress**

3. For each item, follow TDD:

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

4. When ALL items in plan.md are done:

   a. **Create feature branch** (if not already on one)
      - `git checkout -b feature/<descriptive-name>`

   b. **Update FEATURES.md**
      - Compile completed features into `/Users/chriscushman/local/src/claude-companion/FEATURES.md`
      - Format for GitHub README showcase
      ```markdown
      ## <Feature Name>
      <Brief description>

      - Key capability 1
      - Key capability 2
      ```

   c. **Report completion**
      - List all commits made
      - Show updated FEATURES.md content
      - Ask if ready to push

## Rules

- Tests first, always
- Commit after each completed item
- NO push without explicit approval
- NO EAS builds without approval
- Ask if stuck or unclear
