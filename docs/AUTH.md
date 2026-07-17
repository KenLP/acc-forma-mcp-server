# Authentication Setup

`acc-forma-mcp-server` supports two working auth modes: SSA and 2-legged OAuth (2LO). A third mode, 3-legged OAuth, is not yet implemented (see Mode 3 below). **SSA is the recommended mode** for unattended (AI-driven) access.

## Mode 1: SSA (Secure Service Account) — Recommended

SSA is a bot-like identity that can be invited to Forma projects, scoped via APS roles, and rotated without human login.

### Steps

1. **Create an APS application** at [aps.autodesk.com](https://aps.autodesk.com) → My Apps → Create App. Enable "Autodesk Construction Cloud" APIs.

2. **Create an SSA** under your app:
   - Go to your app → Security → Service Accounts
   - Generate a key pair — download the private key PEM file (store securely, never commit)
   - Note: `SSA_ID` (service account ID), `SSA_KEY_ID` (key ID)

3. **Invite the SSA** to your Forma hub:
   - Hub Admin → Members → Add Member → enter the SSA email
   - Assign Project Admin or appropriate role

4. **Provision the APS app** on the hub:
   - Hub Admin → Custom Integrations → Add Integration → find your app by Client ID
   - Without this, all project-scoped calls return 403

5. **Configure `.env`**:
   ```env
   APS_AUTH_MODE=ssa
   APS_CLIENT_ID=...
   APS_CLIENT_SECRET=...
   SSA_ID=...
   SSA_KEY_ID=...
   SSA_KEY_PATH=/absolute/path/to/private-key.pem
   ```

## Mode 2: 2-legged (client_credentials)

Used automatically (when available) by tools that declare `preferredAuth: '2lo'`: Data Management reads (`dm_list_hubs`, `dm_list_projects`, `dm_list_top_folders`, `dm_list_folder_contents`, `dm_get_item`, `dm_list_versions`), Account Admin reads (`admin_list_companies`, `admin_list_projects`, `admin_get_project`, `admin_list_users`), Model Derivative (`md_get_manifest`, `md_get_properties`, `md_trigger_translation`), and `docs_get_viewables`. **Does NOT work** for Issues, Reviews, AEC Data Model, or Model Coordination — those need SSA (or 3LO).

```env
APS_AUTH_MODE=2lo
APS_CLIENT_ID=...
APS_CLIENT_SECRET=...
```

## Mode 3: 3-legged OAuth (PKCE)

Planned for Phase 3 — not yet implemented. Setting `APS_AUTH_MODE=3lo` today fails at startup with: `3-legged OAuth (APS_AUTH_MODE=3lo) is planned for Phase 3 and not yet implemented. Use APS_AUTH_MODE=ssa.` Once implemented, it will open a browser for user login and store encrypted refresh tokens at `~/.acc-forma-mcp/tokens.json`.

## Auth troubleshooting

| Error | Likely cause | Fix |
|---|---|---|
| `403 on any project-scoped call` | APS app not provisioned on hub | Hub Admin → Custom Integrations → add app |
| `403 on specific project` | SSA not invited to project | Invite SSA email to project |
| `401 Unauthorized` | Wrong Client ID/Secret or expired SSA key | Check credentials; rotate key if needed |
| `SSA token fetch failed 400` | Wrong SSA_ID, SSA_KEY_ID, or key file mismatch | Verify all three env vars; key must match the listed key |
