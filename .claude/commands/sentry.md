# Sentry Issue Investigation

Fetch and investigate recent Sentry errors for Companion.

## Setup
Secrets are stored in `.claude/secrets.env`. Source it first:
```bash
source /Users/chriscushman/local/src/claude-companion/.claude/secrets.env
```

## Steps

1. List unresolved issues:
```bash
source /Users/chriscushman/local/src/claude-companion/.claude/secrets.env && \
curl -s -H "Authorization: Bearer $SENTRY_API_TOKEN" \
  "https://sentry.io/api/0/projects/$SENTRY_ORG/$SENTRY_PROJECT/issues/?query=is:unresolved" | jq '.[] | {id, title, culprit, count, lastSeen}'
```

2. Get details for a specific issue (replace ISSUE_ID with the id from step 1):
```bash
source /Users/chriscushman/local/src/claude-companion/.claude/secrets.env && \
curl -s -H "Authorization: Bearer $SENTRY_API_TOKEN" \
  "https://sentry.io/api/0/issues/ISSUE_ID/events/latest/" | jq '{message, culprit, tags, contexts, exception}'
```

3. Get full stack trace:
```bash
source /Users/chriscushman/local/src/claude-companion/.claude/secrets.env && \
curl -s -H "Authorization: Bearer $SENTRY_API_TOKEN" \
  "https://sentry.io/api/0/issues/ISSUE_ID/events/latest/" | jq '.exception.values[] | {type, value, stacktrace: .stacktrace.frames[-5:] | map({filename, function, lineno, context_line})}'
```

4. Mark issue as resolved (after fix is confirmed):
```bash
source /Users/chriscushman/local/src/claude-companion/.claude/secrets.env && \
curl -s -X PUT -H "Authorization: Bearer $SENTRY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "resolved"}' \
  "https://sentry.io/api/0/issues/ISSUE_ID/"
```

## Workflow

1. Run step 1 to list all unresolved issues
2. Pick an issue and get details with steps 2-3
3. Analyze the stack trace, identify the root cause
4. Fix the code
5. User tests the fix
6. If fixed, mark as resolved with step 4

After fetching issues, summarize each one and propose fixes.
