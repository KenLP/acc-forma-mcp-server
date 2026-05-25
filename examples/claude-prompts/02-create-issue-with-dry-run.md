# Example: Create an Issue (with dry-run safety flow)

## Step 1 — Claude auto-calls dry_run=true (default)

**Prompt:**
```
Create an issue titled "Water leak at Level 3 mechanical room" in project b.abc-12345678.
The subtype ID is 9f2c1a3b-0000-0000-0000-000000000001.
Due date: 2026-05-01.
```

**Tool call (auto dry_run=true):**
```
issues.create({
  project_id: "b.abc-12345678",
  title: "Water leak at Level 3 mechanical room",
  issue_subtype_id: "9f2c1a3b-0000-0000-0000-000000000001",
  due_date: "2026-05-01",
  dry_run: true   ← default
})
```

**Response:**
```json
{
  "preview": {
    "method": "POST",
    "url": "https://developer.api.autodesk.com/construction/issues/v1/projects/abc-12345678/issues",
    "body": {
      "title": "Water leak at Level 3 mechanical room",
      "issueSubtypeId": "9f2c1a3b-0000-0000-0000-000000000001",
      "dueDate": "2026-05-01"
    },
    "scope_required": ["data:read", "data:write"],
    "estimated_side_effects": ["Create 1 issue titled \"Water leak at Level 3 mechanical room\" in project b.abc-12345678"],
    "business_rules_passed": ["issue_subtype_id_exists_in_project", "due_date_is_current_or_future"]
  },
  "approval_token": "appr_01JXWXYZ...",
  "next_step": "To execute this action, call tool \"issues.create\" again with the same inputs plus dry_run=false and approval_token=\"appr_01JXWXYZ...\". Token expires in 300s and is single-use."
}
```

## Step 2 — User approves, Claude executes

**Tool call:**
```
issues.create({
  project_id: "b.abc-12345678",
  title: "Water leak at Level 3 mechanical room",
  issue_subtype_id: "9f2c1a3b-0000-0000-0000-000000000001",
  due_date: "2026-05-01",
  dry_run: false,
  approval_token: "appr_01JXWXYZ..."
})
```

**Response:**
```
Issue created successfully.
ID:     iss-789xyz
Title:  Water leak at Level 3 mechanical room
Status: open
```
