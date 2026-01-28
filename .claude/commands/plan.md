# Plan from Todo

Process todo.md items into detailed implementation plans.

## Instructions

1. Read `/Users/chriscushman/local/src/claude-companion/todo.md`

2. Read `/Users/chriscushman/local/src/claude-companion/plan.md` (if exists)

3. For each unplanned item in todo.md:
   - Ask clarifying questions using AskUserQuestion
   - Understand the scope and requirements
   - Identify which files need changes
   - Consider edge cases and potential issues

4. Write detailed plan to `/Users/chriscushman/local/src/claude-companion/plan.md`:
   ```markdown
   # Implementation Plan

   ## Item: <title>
   **Status:** planned | in-progress | done

   ### Requirements
   - <bullet points from discussion>

   ### Files to Modify
   - `path/to/file.ts` - <what changes>

   ### Implementation Steps
   1. <step>
   2. <step>

   ### Tests Needed
   - <test case>

   ---
   ```

5. Mark items as "planned" in todo.md by changing `- item` to `- [planned] item`

## Rules

- NO CODING in this phase
- Ask questions if anything is unclear
- One item at a time unless user wants batch planning
- Keep plans focused and actionable
