# Run Tests

Detect the project's test framework and run tests.

## Instructions

1. Detect the test framework:
   - Check `package.json` for jest, vitest, mocha
   - Check for `pytest.ini`, `setup.cfg`, `pyproject.toml` for pytest
   - Check for `*_test.go` files for Go
   - Check for `Cargo.toml` for Rust

2. Run the appropriate test command:
   - Jest: `npx jest`
   - Vitest: `npx vitest run`
   - pytest: `python -m pytest`
   - Go: `go test ./...`
   - Rust: `cargo test`

3. If `$ARGUMENTS` specified, run only matching tests

4. Report results: passed, failed, skipped counts

5. If tests fail, analyze the failures and suggest fixes

## Fault Detection

- If no test framework found, suggest installing one appropriate for the project
- If dependencies missing, run install command first
