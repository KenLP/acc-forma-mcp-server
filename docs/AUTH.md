# Authentication Setup

`acc-forma-mcp-server` supports three auth modes. **SSA is the recommended mode** for unattended (AI-driven) access.

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

Only usable for Account Admin reads, Webhooks, and OSS bucket operations. **Does NOT work** for Issues, RFIs, Reviews, Submittals, or other project-level write APIs.

```env
APS_AUTH_MODE=2lo
APS_CLIENT_ID=...
APS_CLIENT_SECRET=...
```

## Mode 3: 3-legged OAuth (PKCE)

Planned for Phase 3. Will open a browser for user login, store encrypted refresh tokens at `~/.acc-forma-mcp/tokens.json`.

## Auth troubleshooting

| Error | Likely cause | Fix |
|---|---|---|
| `403 on any project-scoped call` | APS app not provisioned on hub | Hub Admin → Custom Integrations → add app |
| `403 on specific project` | SSA not invited to project | Invite SSA email to project |
| `401 Unauthorized` | Wrong Client ID/Secret or expired SSA key | Check credentials; rotate key if needed |
| `SSA token fetch failed 400` | Wrong SSA_ID, SSA_KEY_ID, or key file mismatch | Verify all three env vars; key must match the listed key |
