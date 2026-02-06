# TDD

Implement a feature using test-driven development.

## Usage

```
/tdd <feature description>
```

## Instructions

1. The feature to implement: `$ARGUMENTS`

2. If `$ARGUMENTS` is empty, ask what feature to build

3. Understand the feature:
   - Read relevant existing code
   - Identify which files will need changes
   - Determine the test framework (Jest, Vitest, pytest, Go test, etc.)

4. **Red** — Write failing tests first:
   - Create or update test files covering the feature
   - Include happy path, edge cases, and error cases
   - Run tests — confirm they fail

5. **Green** — Write the minimum code to pass:
   - Implement only what's needed to make tests pass
   - Run tests after each change
   - Don't add anything the tests don't require

6. **Refactor** — Clean up while green:
   - Remove duplication
   - Improve naming
   - Simplify logic
   - Run tests again — must still pass

7. Repeat steps 4-6 if the feature needs more test cases

8. Run type checker if applicable (`npx tsc --noEmit`, `mypy`, etc.)

9. Report what was implemented and test results

## Rules

- Never write implementation before tests
- Each red-green-refactor cycle should be small and focused
- If a test is hard to write, the design probably needs rethinking
- Don't mock what you don't own — wrap external dependencies first
