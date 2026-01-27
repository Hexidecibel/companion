# Work on Task from Queue

Interactive task picker for autonomous work sessions.

## Instructions

1. Read `/Users/chriscushman/local/src/claude-companion/TASKS.md`

2. Parse the "Work Queue (Async Tasks)" section and extract numbered tasks

3. Present tasks to user using AskUserQuestion:
   - Show task number and title for each
   - Let user pick which task to work on

4. Once task is selected:
   - Read CLAUDE.md for implementation patterns
   - Follow the step-by-step instructions in the task
   - Explore relevant existing code before writing new code
   - Implement incrementally
   - Test if possible (type check with `npx tsc --noEmit`)

5. When complete:
   - Commit changes with descriptive message
   - Do NOT push unless user approves
   - Do NOT start EAS builds

6. Update TASKS.md:
   - Move completed items from "Pending" to "Completed" section
   - Remove the task from "Work Queue" or mark as done

7. Report what was accomplished and what files were changed

## Important Rules

- NO EAS builds without explicit approval
- NO git push without approval
- Ask user if unclear about requirements
- Commit incrementally for large tasks
