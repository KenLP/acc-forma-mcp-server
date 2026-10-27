# BIMLynx self-host setup guide

BIMLynx connects Claude Desktop to your Autodesk Construction Cloud (ACC / Forma) projects. The
**self-host edition** runs entirely on your own computer, using an Autodesk app that your
organization creates in its own Autodesk account. Two things follow from that:

- **API usage counts against your organization's own Autodesk account**, not ours. Autodesk
  charges for the AEC Data Model API by the amount of data read out, and capacity that comes with a
  subscription only applies to apps created in the same Autodesk team as that subscription. Part A
  covers this.
- **Project data goes only between your computer and Autodesk.** BIMLynx has no server in the
  middle.

> Vietnamese version: [SELF-HOST-GUIDE.vi.md](SELF-HOST-GUIDE.vi.md)

## Who does what

| Part | Who | Time | When |
|---|---|---|---|
| [A](#part-a--autodesk-team-admin-once) | Autodesk **team admin** | ~10 min | once per organization |
| [B](#part-b--user-each-computer) | The **user** | ~5 min | on each computer |
| [C](#part-c--acc-account-admin-and-project-admin) | **ACC account admin** + **project admin** | ~5 min | after Part B, once per project |
| [D](#part-d--check-and-troubleshoot) | Anyone | — | when testing or when something fails |

Do the parts **in this order**. In Part C, ACC links the integration to the robot account that
Part B creates. If no robot exists yet when the integration is added, ACC grants the integration
account-administrator-level access instead.

You do **not** need Node.js, a terminal, or to edit any configuration file.

---

## Part A — Autodesk team admin (once)

### A1. Use the team that holds your subscription

Autodesk applies a subscription's included API capacity only to apps created **in the same team
as the subscription**. A Forma Build subscription, for example, includes AEC Data Model capacity
each month. An app created anywhere else only gets the free monthly allowance.

1. Sign in to [Autodesk Account](https://manage.autodesk.com) as a team admin of the team that
   holds the subscription.
2. Go to **Products and Services → Hubs**.
3. If that team already has a hub of type **Autodesk Platform Services**, use it and skip to A2.
4. Otherwise click **Create hub**. Choose **Autodesk Platform Services** as the product, enter a
   name, and click **Create & Activate**.

> Autodesk states that an APS subscription is required to create or join a developer hub, and that
> a hub's team cannot be changed after it is created. If **Create hub** is unavailable for your
> team, contact your Autodesk representative before going further: without a hub in the
> subscription's team, usage falls back to the free allowance.

### A2. Create the app

1. In the developer hub, open **Applications → Create application**.
2. Name it `BIMLynx` (any name works).
3. Application type: **Server-to-Server**. BIMLynx authenticates as a robot account, called a
   Secure Service Account, and Autodesk requires this app type for it.
4. Under API access, enable at least: **Data Management API**, **Model Derivative API**,
   **AEC Data Model API**, and **Autodesk Construction Cloud API**. Labels in the portal may differ
   slightly.
5. Click **Create**. Then copy the **Client ID** and **Client Secret** and send them to the users
   through a secure channel: a password manager, not plain email or chat.

---

## Part B — User (each computer)

Requires Claude Desktop for Windows or macOS.

1. Download `bimlynx-local-<version>.mcpb` from the link we sent you.
2. Double-click it. You can also drag it onto **Claude Desktop → Settings → Extensions**. Claude
   Desktop shows a notice that the publisher is unverified, because the bundle is not code-signed
   yet. Choose **Install**.
3. Fill in the settings:

   | Field | Value |
   |---|---|
   | APS Client ID | from Part A |
   | APS Client Secret | from Part A |
   | BIMLynx data folder | keep the default (`BIMLynx` in your home folder) or choose another one |
   | APS region | `US`, `EMEA` or `AUS`: where your ACC account is hosted (default `US`) |

4. Enable the extension. Open a new chat and type: **"set up BIMLynx"**.
   - Claude runs `setup_status` and shows a checklist. Every item should be `[ok]` except the robot
     account, which is created in the next step.
   - Claude then calls `setup_create_robot`, first as a **preview**. Read it and approve.
5. The result shows the robot's email. It looks like
   `bimlynx-<computer-name>@<...>.adskserviceaccount.autodesk.com`. **Send that email to your ACC
   admin** for Part C.
6. **Quit Claude Desktop completely and reopen it.** Closing the window is not enough: on
   Windows, quit from the system-tray icon; on macOS, use Claude → Quit. BIMLynx now starts with
   its full tool set.

The data folder now holds `robot-key.pem`, the robot's private key, plus `robot.json` and the audit
log. **Keep the folder private.** Do not share it or put it in a synced or shared drive. Anyone
with the key and your Client Secret can act as the robot.

---

## Part C — ACC account admin and project admin

### C1. Add the custom integration (account admin, once)

1. In ACC / Forma, open **Account Admin → Custom Integrations**.
2. Add a custom integration and enter the **Client ID** from Part A, plus a name such as BIMLynx and
   a description.
3. ACC detects the robot account created in Part B and links the integration to it.

### C2. Invite the robot to projects (project admin, per project)

1. Open the project → **Project Admin → Members → Add members**.
2. Enter the **robot email** from Part B5.
3. Give it access to **Docs**. Add **Model Coordination** if you will use clash tools. On the
   Members page, check that the robot is subscribed to the Build modules you will use, such as
   Issues and Reviews.
4. Grant **folder permissions** and **Issues permissions** as you would for a person. The robot
   sees exactly what it is given, nothing more.

BIMLynx can only reach projects the robot is a member of.

---

## Part D — Check and troubleshoot

### First test

In a new chat, ask: **"List my ACC hubs and projects."** Then try something read-only on one
project, for example "List the open issues in project X".

Every **write** action (create issue, add comment, start review, ...) shows a preview first and
runs only after you approve it. Each call is recorded in the audit log in your data folder.

### Problems

| What you see | Cause | Fix |
|---|---|---|
| After restarting, Claude still offers only `setup_status` / `setup_create_robot` | The robot was not created, or the data folder changed | Ask "check BIMLynx setup status"; it reports what is missing |
| Setup status: *Client ID / Client Secret rejected* | Wrong secret | Re-copy both values (Claude Desktop → Settings → Extensions → BIMLynx) |
| Setup status: *APS does not recognize this Client ID* (AUTH-001) | Wrong Client ID, or app has no API access | Re-copy the Client ID; check app type is Server-to-Server (A2) |
| Setup status: *refused to list service accounts* | The app cannot manage service accounts | Check app type (A2); contact us with the exact message |
| Setup status: *all 10 service accounts are used* | Autodesk allows 10 robots per app | Delete unused ones, or request more through APS "Get Help" |
| Setup status: *belongs to a different APS app* | The data folder was used with another app before | Move `robot.json` and `robot-key.pem` out of the folder, then run setup again |
| `Access denied (403)` on a project | Custom integration missing (C1) or robot not invited (C2) | Complete C1 / C2 |
| `404 ... no access` on clash tools (`mc_*`) | Robot lacks Model Coordination on the project | Add the product in C2 |
| The extension does not start | — | Look at Claude Desktop's log for BIMLynx (Windows: `%APPDATA%\Claude\logs`, macOS: `~/Library/Logs/Claude`) and send it to us |

### Start over on a computer

1. Delete `robot.json` and `robot-key.pem` from the data folder.
2. Delete the old robot so that it does not occupy one of the 10 slots. You can do this in the APS
   developer portal, or contact us and we will walk you through it.
3. Restart Claude Desktop and run "set up BIMLynx" again.

---

## Keeping API costs under control

Autodesk prices APIs per organization, and the prices can change. See
[APS pricing](https://www.autodesk.com/products/autodesk-platform-services/product-details).
At the time of writing:

- **AEC Data Model API** (`aecdm_*` tools, and `issues_pin_element` which reads element
  positions) is charged by **data read out**. There is a small free monthly allowance; a
  subscription's included capacity applies only if Part A1 was done in the subscription's team.
  A single query over every element of one category in a large model can be over 1 MB.
- **Model Derivative API** (`md_*` tools) has a large free monthly allowance of basic calls.
  `md_get_properties` with `group_by` / `sum_fields` covers most parameter questions: quantities
  by level, areas, counts.
- Data Management, Issues, Reviews, Model Properties and Webhooks are currently not metered.

Watch actual usage per app in the developer hub: **Applications → your app → API usage**. Use
**Hub analytics → Token usage** for the whole hub. Check it after your first few days of use to
confirm that usage appears under your own app and team.

## What runs where

- The server is a single JavaScript file inside the extension. It runs under Claude Desktop's
  bundled Node.js.
- Claude Desktop keeps the Client Secret, entered as a masked field. The data folder holds the
  robot key and the audit log. Audit files older than 90 days are deleted automatically.
- Network traffic goes only to Autodesk APIs (`developer.api.autodesk.com`) and to the signed
  download links those APIs return.
- Privacy policy: [PRIVACY.md](../PRIVACY.md). Support: hello@bimlynx.com
