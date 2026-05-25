# Auth modes — 2LO vs SSA

The server supports two APS authentication modes simultaneously. Tools are gated to the modes they support, and the server picks the right mode per tool automatically. This document explains why two modes exist, which tools use which, and how to diagnose 401/403 errors.

## Why two modes

| Mode | Token grant | Visibility | Mutations |
|---|---|---|---|
| **2LO** (`client_credentials`) | App identity | All projects in the hub | Limited (read-mostly APIs) |
| **SSA** (Secure Service Account, JWT bearer) | Service-account identity | Projects the SSA is provisioned on | Full (write APIs require this) |

Issues, Reviews, and AEC Data Model APIs **require an end-user-like identity** (SSA or 3LO). Data Management and Account Admin APIs work with the simpler 2LO grant and benefit from hub-wide visibility.

## Per-tool matrix

| Tool group | Preferred auth | Required auth modes |
|---|---|---|
| `dm_*` | 2LO | 2LO, SSA, 3LO |
| `admin_*` | 2LO | 2LO, SSA, 3LO |
| `issues_*` | (default) SSA | SSA, 3LO |
| `reviews_*` | (default) SSA | SSA, 3LO |
| `aecdm_*` | (default) SSA | SSA, 3LO |
| `meta_*` | (default) SSA | any |

The server's `_wrap.ts` uses two annotations:

- `preferredAuth: '2lo'` — DM/Admin tools always use the 2LO provider when available, even if SSA is the default mode.
- `requiredAuthModes: ['ssa', '3lo']` — Issues/Reviews/AECDM fail fast with an actionable message if the current mode is 2LO.

## Required env vars per mode

### 2LO mode (`APS_AUTH_MODE=2lo`)

```
APS_CLIENT_ID=...
APS_CLIENT_SECRET=...
```

Sufficient for all `dm_*` and `admin_*` tools. Calls to `issues_*`, `reviews_*`, or `aecdm_*` will fail fast with a "tool requires SSA or 3LO auth" message.

### SSA mode (`APS_AUTH_MODE=ssa`)

```
APS_CLIENT_ID=...
APS_CLIENT_SECRET=...    # still required for token exchange
SSA_ID=...               # the service account ID
SSA_KEY_ID=...           # the registered key ID
SSA_KEY_PATH=/path/to/key.pem   # private key for JWT signing
```

When SSA mode is active, the server **also constructs a 2LO provider** internally. DM/Admin tools transparently route to the 2LO provider so they keep their hub-wide visibility. You don't need to do anything; this is automatic.

## Diagnosing 401 / 403

| Symptom | Likely cause | Fix |
|---|---|---|
| `issues_*` returns 401 in 2LO mode | Wrong mode for this tool | Set `APS_AUTH_MODE=ssa` and add SSA env vars |
| `issues_*` returns 403 for one project but works for others | SSA not provisioned on that project | Add the SSA as a project member in ACC admin |
| `dm_list_projects` shows fewer projects in SSA mode | SSA only sees projects it's provisioned on | Server auto-routes DM to 2LO; verify `auth2lo` is set in ctx |
| `aecdm_*` tools return empty data | Often NOT auth — files not indexed | See `workflow-aecdm.md` re: re-publish |
| Tool fails with "requires SSA or 3LO" | Server is in 2LO mode | Switch to SSA mode |

## Provisioning an SSA on a project

1. In ACC: Account Admin → Members → Add → search for the SSA's email-style identifier.
2. Assign appropriate access to the relevant project(s).
3. The SSA must be a member of every project it needs to mutate.

This is the most common cause of "the server worked yesterday but fails on this new project" — the SSA is not yet a member of the new project.

## Token caching

Both providers cache tokens until ~60 seconds before expiry. If you suspect a stale token (very rare), restart the server. There is no manual cache-invalidate tool — that would be a security regression.

## 3LO

3-legged OAuth is on the roadmap but not currently wired up. When implemented, it will appear as `APS_AUTH_MODE=3lo` and require an interactive browser flow. Tools annotated with `requiredAuthModes: ['ssa', '3lo']` will accept it transparently.
