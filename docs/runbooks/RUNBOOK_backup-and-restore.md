# Runbook: backup and restore (master key + tenant volume)

Closes the residual concern recorded in
[`docs/audits/AUDIT_2026-08-12_remote-mcp.md`](../audits/AUDIT_2026-08-12_remote-mcp.md):
*"Residual operational concerns remain around master-key backup, rotation, and key
versioning. Loss of the master key makes stored tenant ciphertext unrecoverable."*

## What is actually at risk

Two artifacts, and **both are needed** to serve a single customer:

| Artifact | Where it lives | If lost |
|---|---|---|
| `FORMA_MASTER_KEY` | Fly secret on app `bimlynx-mcp` | Every `private_key_ciphertext` in the DB is unrecoverable. Tenants must be re-provisioned from scratch — new robot, new bearer key, and every customer admin must redo their two console steps |
| `/data/state.db` | Fly volume `forma_data`, single volume, `primary_region = "sin"` | Same outcome. The `tenants` table *is* the credential: it holds the robot's encrypted key and the sha256 of the bearer key, and nothing in it can be recomputed |

They are a pair by design: the DB is useless without the key, and the key is useless without
the DB. **Store them in different places.** A backup location holding both is a single
compromise away from every tenant robot credential.

Neither artifact is in the git repository, and nothing about this changes that — the repo is
public and contains no secrets (verified: the only env file ever committed is
`.env.example`, all placeholders).

---

## Prerequisite: flyctl

None of this runs from the repo. `flyctl` is not a project dependency — install it once on
the operator machine:

```bash
curl -L https://fly.io/install.sh | sh
```

Then `fly auth login`. Every command below targets app `bimlynx-mcp`.

---

## 1. Back up the master key (do this first, once)

Fly secrets are **write-only** — `fly secrets list` shows a digest, never the value. There is
no way to read the key back out of Fly. If the only copy is in Fly, and Fly loses it, it is
gone.

**If you still have the key** (from when you first ran `fly secrets set`), skip to step 1.2.

### 1.1 If you do not have a copy

You cannot recover it. `rotate-key` (§6) cannot help either — it re-encrypts by first
decrypting with the *current* key, which is exactly what is missing. You must generate a new
key and re-provision every tenant. Do this only after §1.2 has confirmed, against a fresh
snapshot, that no copy you can find decrypts the existing rows.

### 1.2 Verify the copy you have is the right one

Before trusting a copy, prove it decrypts production data. This never prints the key or the
decrypted PEM:

```bash
fly ssh console -a bimlynx-mcp -C "node dist/backup-tenants.js verify-key"
```

That checks the key **Fly is currently running with**. To check the copy *you* wrote down,
pipe it in against a pulled snapshot (§2) instead:

```bash
node dist/backup-tenants.js verify-key --db ./state-backup.db --stdin
```

Paste the key, press Ctrl-D. There is deliberately no `--key <hex>` flag: an argument is
visible in the host's process list and lands in shell history.

Expected output ends with:

```
All tenant rows decrypt with this key — it is the correct master key.
```

Both commands print a **key fingerprint** (first 16 hex of its sha256). Compare fingerprints
to confirm two copies are the same key without either being displayed.

### 1.3 Where to store it

- A password manager entry, **or** a paper copy in a safe — 64 hex characters is short
  enough to write by hand.
- **Not** in the same place as the DB backups.
- **Not** in the repo, a ticket, a chat message, or an email.
- At least two copies in different physical locations. The failure this guards against is
  "the laptop with the only copy died".

---

## 2. Back up the tenant database

### Why not `cp /data/state.db`

`src/persistence/db.ts` sets `journal_mode = WAL`, so committed rows can still be sitting in
the `-wal` sidecar when a file copy is taken. Copying the main file alone silently drops
them — and the rows it drops are the most recently written ones, i.e. **the tenants you
provisioned most recently**.

Measured on a WAL-mode reproduction in this repo:

| Method | Rows recovered (source had 400) |
|---|---|
| `cp state.db` | **0 — the copy was unreadable**, `no such table: tenants` (the `CREATE TABLE` was itself still in the WAL) |
| `backup-tenants.js snapshot` | 400, `integrity_check: ok` |

Do not use `cp`, `fly ssh sftp get /data/state.db`, or a volume snapshot as the *primary*
backup for this reason.

### 2.1 Take a consistent snapshot

```bash
fly ssh console -a bimlynx-mcp -C "node dist/backup-tenants.js snapshot --out /data/backup.db"
```

Uses SQLite's online backup API, then reopens the result and runs `integrity_check` plus a
`tenants` row count before reporting success. A backup nobody has opened is a hope, not a
backup.

### 2.2 Pull it off the volume

```bash
fly ssh sftp get /data/backup.db ./state-backup-$(date +%Y%m%d).db -a bimlynx-mcp
```

### 2.3 Remove the copy left on the volume

```bash
fly ssh console -a bimlynx-mcp -C "rm /data/backup.db"
```

Leaving it there doubles the blast radius of anyone who gets access to the volume, and it
will go stale and mislead whoever finds it next.

### 2.4 Verify the pulled copy before trusting it

```bash
node dist/backup-tenants.js verify-key --db ./state-backup-$(date +%Y%m%d).db --stdin
```

A backup that has not been opened and decrypted is not yet known to be a backup.

### Cadence

Take one **after every `tenant-admin create` or `disable`** — those are the only operations
that change the table, and they are rare and manual. A calendar-driven schedule is the wrong
shape here: nothing changes between provisioning events.

---

## 3. Volume snapshots (second line of defence)

Fly takes daily snapshots automatically. `fly.toml` sets `snapshot_retention = 30` on the
`[mounts]` block; that applies to snapshots taken from here on. Apply it to the **existing**
volume too:

```bash
fly volumes list -a bimlynx-mcp
```

```bash
fly volumes update <volume id> --snapshot-retention 30 -a bimlynx-mcp
```

List and create on demand:

```bash
fly volumes snapshots list <volume id>
```

```bash
fly volumes snapshots create <volume id>
```

These are block-level copies of a live WAL SQLite file, so a snapshot can land
mid-checkpoint. Treat them as the fallback for "the volume is gone", not as the backup of
record.

---

## 4. Restore

### 4.1 Restore the database from a pulled backup

Do **not** `mv` a file into place. The live database runs in WAL mode, so `state.db-wal` and
`state.db-shm` sit beside it; a restored main file dropped under the old sidecars lets
SQLite replay the *old* database's WAL frames onto the *new* file on next open. The
`restore` command goes through SQLite's backup API instead, writing the restored pages via
the live file's own pager — the sidecars stay coherent, the running server sees the rows on
its next statement, and nothing has to be stopped or restarted.

Upload the backup:

```bash
fly ssh sftp shell -a bimlynx-mcp
```

`put ./state-backup-YYYYMMDD.db /data/state-restore.db`, then dry run. This checks the
backup's integrity, proves every row decrypts under the key the server is running with, and
lists any live tenant the restore would lose — and writes nothing:

```bash
fly ssh console -a bimlynx-mcp -C "node dist/backup-tenants.js restore --from /data/state-restore.db"
```

Read the "NOT in the backup" list carefully: those are tenants provisioned after the backup
was taken. If any are listed, see §4.3 before continuing. Then:

```bash
fly ssh console -a bimlynx-mcp -C "node dist/backup-tenants.js restore --from /data/state-restore.db --apply"
```

`--apply` first snapshots the current live state to `/data/state.db.pre-restore-<ts>.db` —
the state being replaced may be the only copy of a later-provisioned tenant — then restores
and verifies what landed from a fresh handle. No restart needed.

Once a real tool call has succeeded against the restored data, remove both files from the
volume:

```bash
fly ssh console -a bimlynx-mcp -C "rm /data/state-restore.db /data/state.db.pre-restore-*.db"
```

### 4.2 Restore the whole volume from a Fly snapshot

```bash
fly volumes snapshots list <volume id>
```

```bash
fly volumes create forma_data --snapshot-id <snapshot id> -s 1 -a bimlynx-mcp
```

Fly attaches a volume by name, so the machine picks up the new one on its next start. Verify
with `verify-key` before announcing recovery.

### 4.3 What restore does **not** fix

- **Bearer keys are unchanged** by a restore, because only their hash is stored — a customer
  whose tenant row comes back keeps using the key they already have. This is the good case.
- **A tenant provisioned after the backup was taken is gone.** Its bearer key will 401. You
  must re-run `tenant-admin create` and send that customer a new key. The service account
  itself still exists on APS — check with `tenant-admin list-ssa`, which flags SAs with
  `tenant=(none locally)`, and delete the orphan before creating a replacement or it counts
  against the 10 SA/Client ID quota.
- **Audit log** lives in `/data/audit`, not in `state.db`, and is not covered by
  `backup-tenants.js snapshot`. It is 90-day retained operational history, not a credential;
  the volume snapshot covers it.

---

## 5. Disaster drill

Worth doing once, now, rather than discovering a gap during an incident:

1. Take a snapshot (§2.1) and pull it (§2.2).
2. `verify-key --stdin` against the pulled copy, using **the written-down key**, not the
   environment (§1.2). This is the step that proves both halves independently.
3. Confirm the fingerprint matches what `verify-key` reports on production.
4. Delete the volume-side copy (§2.3).

If step 2 fails, you have found the problem while nothing is on fire.

---

## 6. Rotate the master key

Use when the key may have been exposed, or on a schedule you set. Rotation re-encrypts every
tenant's robot private key; **bearer keys are unaffected**, so no customer has to be
contacted and no ACC console step has to be redone.

### 6.1 The window you are opening

`buildTenantContext` decrypts a tenant's robot key only on a **cache miss**
(`src/tenancy/context.ts`), and the machine runs with `min_machines_running = 0`, so the
cache is usually cold. Between the moment the database is rotated and the moment the Fly
secret is updated, a tenant lookup throws and the transport returns **500** (not 401).

Treat §6.2 and §6.3 as one action. Do not stop in between to go and find where you wrote the
new key down — have it ready first.

### 6.2 Rotate the database

Generate the new key and keep it in front of you:

```bash
openssl rand -hex 32
```

The new key is read from stdin, so do this from an interactive shell on the machine rather
than through `-C` (which does not give you a reliable stdin to paste into):

```bash
fly ssh console --pty -a bimlynx-mcp
```

Inside that shell, dry run first. This reads every row, re-encrypts it in memory, verifies
the round-trip, and writes **nothing**:

```
node dist/backup-tenants.js rotate-key
```

Paste the new key, press Enter, then Ctrl-D. Expect `N of N tenant row(s) re-encrypt
cleanly`. If any row reports FAIL, stop — the key currently in `FORMA_MASTER_KEY` is not the
key those rows were encrypted under, and rotating would strand them. Nothing was written.

Then commit, in the same shell:

```
node dist/backup-tenants.js rotate-key --apply
```

`--apply` takes its own pre-rotation backup on the volume first (path is printed) and does
every UPDATE in one transaction, so it cannot leave the table half-rotated. The old key is
deliberately never accepted as an argument — it comes from the environment the container
already has.

### 6.3 Immediately update the secret

```bash
fly secrets set FORMA_MASTER_KEY=<the new key> -a bimlynx-mcp
```

This restarts the app onto the new key and closes the window.

### 6.4 Confirm, then clean up

```bash
fly ssh console -a bimlynx-mcp -C "node dist/backup-tenants.js verify-key"
```

Zero failures means the running environment and the database agree. Then:

1. Store the new key per §1.3, in both locations.
2. Make a real tool call through an MCP client to confirm end to end.
3. Delete the pre-rotation backup from the volume — it still decrypts with the **old** key,
   so leaving it there keeps the compromised key useful to anyone who reaches the volume.
4. Only now destroy your copies of the old key.

### 6.5 Rollback

If something is wrong before you delete the pre-rotation backup, put it back through the
same `restore` command, with `FORMA_MASTER_KEY` still the **old** key (i.e. before or
after reverting §6.3 — the pair must match):

```bash
fly ssh console -a bimlynx-mcp -C "node dist/backup-tenants.js restore --from /data/state.db.pre-rotate-<ts>.db --apply"
```

If §6.3 already ran, set the secret back to the old key afterwards. `restore` refuses to
proceed if the file does not decrypt under whatever key is in the environment, so a mismatch
fails loudly rather than restoring unreadable rows.

### 6.6 Do not provision during a rotation

`rotate-key --apply` re-reads the table inside its transaction, so a tenant created between
the dry run and `--apply` is rotated too — but a tenant created *after* `--apply` commits and
*before* §6.3 lands is encrypted under the old key and stranded. Nothing in the tool can
prevent that; the fix is procedural. Do not run `tenant-admin create` until §6.4 has
reported zero failures.

---

## Known gaps (not addressed here)

- **Rotation has a brief failure window** (§6.1) rather than being seamless. Closing it
  would mean the server accepting a `FORMA_MASTER_KEY_PREVIOUS` fallback so both keys
  decrypt during a transition. That was not built: it puts a second, permanently-valid key
  on the auth hot path, and a stale fallback nobody remembers to remove is exactly the
  failure rotation exists to prevent. At this scale a back-to-back rotate-then-set-secret is
  the better trade.
- **No off-site automated copy.** Backups are operator-pulled. At ≤10 tenants (the APS
  quota) that is a deliberate trade: an automated push to S3/R2 would mean storage
  credentials inside the container, which is a larger attack surface than the problem it
  solves. Revisit if the quota is raised.
- **Single region.** The volume is in `sin` only. A region-level loss falls back to Fly
  snapshots plus the operator-held copy.
