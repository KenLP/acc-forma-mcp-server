# BIMLynx self-host setup guide

BIMLynx connects Claude Desktop to your Autodesk Forma projects (formerly Autodesk Construction
Cloud, ACC). The **self-host edition** runs entirely on your own computer, using an Autodesk app
that your organization creates in its own Autodesk account. Three things follow from that:

- **API usage counts against your organization's own Autodesk account**, not ours. Autodesk
  charges for the AEC Data Model API by the amount of data read out, and capacity that comes with a
  subscription only applies to apps created in the same Autodesk team as that subscription. Part A
  covers this.
- **Project data goes only between your computer and Autodesk.** BIMLynx has no server in the
  middle.
- **BIMLynx reads only the projects its robot account is invited to.** Every call runs as that
  robot. It never uses a hub-wide token, and it has no hub-level Admin tools. See
  [What BIMLynx can reach](#what-bimlynx-can-reach).

> Vietnamese version: [SELF-HOST-GUIDE.vi.md](SELF-HOST-GUIDE.vi.md)

## Who does what

| Part | Who | Time | When |
|---|---|---|---|
| [A](#part-a--autodesk-team-admin-once) | Autodesk **team admin** | ~10 min | once per organization |
| [B](#part-b--user-each-computer) | The **user** | ~5 min | on each computer |
| [C](#part-c--forma-account-admin-and-project-admin) | Forma **account admin** + **project admin** | ~5 min | after Part B, once per project |
| [D](#part-d--check-and-troubleshoot) | Anyone | — | when testing or when something fails |

Do the parts **in this order**. In Part C, Forma links the integration to the robot account that
Part B creates. If no robot exists yet when the integration is added, Forma grants the integration
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

Use a **new app for BIMLynx** rather than one your organization already uses for something else.
An app can hold at most 10 robot accounts, and Part C is simplest when the app has no custom
integration yet.

---

## Part B — User (each computer)

Requires Claude Desktop for Windows or macOS. Claude Desktop calls installed bundles
**connectors**: you will find BIMLynx under **Settings → Customize → Connectors**, with type
**Desktop**.

### B1. Before you install

- **Remove any older BIMLynx connector.** The hosted edition ("BIMLynx — Autodesk Construction
  Cloud", which asks for a *bearer key*) is a different connector. If both are installed, Claude
  sees two sets of tools with the same names. In **Settings → Customize → Connectors**, remove it.
- **Check you have the self-host file.** It is named `bimlynx-local-<version>.mcpb`. A file named
  `bimlynx-<version>.mcpb`, without `-local`, is the hosted edition.

### B2. Install

1. Double-click `bimlynx-local-<version>.mcpb`. Claude Desktop shows a notice that the publisher is
   unverified, because the bundle is not code-signed yet.
2. **Before you click Install, read the dialog.** It must say **BIMLynx (self-host) — Autodesk
   Forma**, and the settings must be the four below. If it asks for a **bearer key**, it is the
   hosted edition: cancel.
3. Choose **Install**, then fill in the settings:

   | Field | Value |
   |---|---|
   | APS Client ID | from Part A |
   | APS Client Secret | from Part A |
   | BIMLynx data folder | keep the default (`BIMLynx` in your home folder) or choose another one |
   | APS region | `US`, `EMEA` or `AUS`: where your Forma account is hosted (default `US`) |

4. **Switch the connector on.** In **Settings → Customize → Connectors**, turn on **BIMLynx
   (self-host) — Autodesk Forma**. Claude Desktop does **not** turn it on by itself, not even after
   you have filled in the settings. While it is off, Claude has no BIMLynx tools at all.

### B3. Create the robot account

1. Open a **new chat** in Claude Desktop and type: **"set up BIMLynx"**.
2. Claude runs `setup_status` and shows a checklist. Every item should be `[ok]` except the robot
   account, which is created in the next step.
3. Claude then calls `setup_create_robot` as a **preview**: the robot's name, which app it belongs
   to, the files it will write. **Nothing is created until you answer.**

**How to answer the preview**

| You want to | Reply in the chat |
|---|---|
| create the robot as shown | **"Yes, create it."** |
| use a different name | "Use the name `bimlynx-<name>` instead." Claude shows a new preview; answer that one. |
| stop | "No, don't create it." Nothing is created. |

- The approval is valid for **5 minutes**. If you answer later, Claude runs the preview again;
  answer the new one.
- If Claude Desktop itself asks whether to allow the tool, choose **Allow once**. That is Claude
  Desktop's own permission prompt, separate from BIMLynx's approval.

4. The result shows the robot's email. It looks like
   `bimlynx-<computer-name>@<...>.adskserviceaccount.com`. **Send that email to your Forma admin**
   for Part C.

### B4. Restart Claude Desktop

**Quit Claude Desktop completely and reopen it.** Closing the window is not enough: on Windows,
quit from the system-tray icon; on macOS, press **⌘Q** or use **Claude → Quit Claude**. BIMLynx
then starts with its full tool set.

The data folder now holds `robot-key.pem`, the robot's private key, plus `robot.json` and the audit
log. **Keep the folder private.** Do not share it or put it in a synced or shared drive. Anyone
with the key and your Client Secret can act as the robot.

---

## Part C — Forma account admin and project admin

Do **both** steps. Inviting the robot to a project (C2) is not enough on its own: without the
custom integration (C1), every project call is refused.

### C1. Add the custom integration (account admin, once per app)

1. In Forma, open **Account Admin → Custom Integrations**.
2. Add a custom integration and enter the **Client ID** from Part A, plus a name such as BIMLynx and
   a description.
3. Forma detects the robot account created in Part B and links the integration to it. The
   integration then shows the robot's email, and an access level of **Project access** or **Full
   project access** — not **Full hub access**.

### C2. Invite the robot to projects (project admin, per project)

1. Open the project → **Project Admin → Members → Add members**.
2. Enter the **robot email** from Part B.
3. Give it access to **Docs**. Add **Model Coordination** if you will use clash tools. On the
   Members page, check that the robot is subscribed to the Build modules you will use, such as
   Issues and Reviews.
4. Grant **folder permissions** and **Issues permissions** as you would for a person.

### What BIMLynx can reach

BIMLynx reads and writes **only in the projects the robot is a member of**, and only what the
robot's role in each project allows. A project it was not invited to does not appear in any list,
and opening a file there by its id is refused by Autodesk.

This holds because every call runs on the robot's own token. The self-host edition never uses the
app's hub-wide (2-legged) token, and it does not include the hub-level Admin tools — the hub's
full project list, its member list and its company list — or the webhook tools. To give BIMLynx
another project, invite the robot to it. To take a project away, remove the robot from it. You
can do either in Forma at any time.

---

## Part D — Check and troubleshoot

### First test

In a new chat, ask: **"List my Forma hubs and projects."** You should see only the projects the
robot was invited to. Then try something read-only on one project, for example "List the open
issues in project X", or "What can BIMLynx do with issues in project X?".

Every **write** action (create issue, add comment, start review, ...) shows a preview first and
runs only after you approve it, the same way as the robot preview in B3: reply **"Yes, go ahead"**
to run it, or say what to change. Each call is recorded in the audit log in your data folder.

### Problems

| What you see | Cause | Fix |
|---|---|---|
| You type "set up BIMLynx" and Claude has no setup tool: it searches your computer, asks for folder access, or offers to edit a configuration file | The connector is installed but **switched off** | Turn it on (B2 step 4). Do not accept Claude's alternative suggestions |
| After restarting, Claude still offers only `setup_status` / `setup_create_robot` | The robot was not created, or the data folder changed | Ask "check BIMLynx setup status"; it reports what is missing |
| Setup status: *Client ID / Client Secret rejected* | Wrong secret | Re-copy both values: **Settings → Customize → Connectors → BIMLynx (self-host)** |
| Setup status: *APS does not recognize this Client ID* (AUTH-001) | Wrong Client ID, or app has no API access | Re-copy the Client ID; check app type is Server-to-Server (A2) |
| Setup status: *refused to list service accounts* | The app cannot manage service accounts | Check app type (A2); contact us with the exact message |
| Setup status: *all 10 service accounts are used* | Autodesk allows 10 robots per app | Delete unused ones, or request more through APS "Get Help" |
| Setup status: *belongs to a different APS app* | The data folder was used with another app before | Move `robot.json` and `robot-key.pem` out of the folder, then run setup again |
| A project you expect is missing from the list | The robot is not a member of it | Invite the robot (C2) |
| `Access denied (403)` on a project | Custom integration missing (C1), or the robot lacks a permission there (C2) | Complete C1 / C2 |
| `401` or `404` when opening a model by its id | The file is in a project the robot is not a member of | Expected — invite the robot to that project |
| `404 ... no access` on clash tools (`mc_*`) | Robot lacks Model Coordination on the project | Add the product in C2 |
| The connector does not start | — | Look at Claude Desktop's log for BIMLynx (Windows: `%APPDATA%\Claude\logs`, macOS: `~/Library/Logs/Claude`, file `mcp-server-BIMLynx (self-host) — Autodesk Forma.log`) and send it to us |

The data folder (`BIMLynx` in your home folder by default) is created when the robot is
written, not when the connector starts. An empty or missing folder before B3 is normal.

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
- Data Management, Issues, Reviews and Model Properties are currently not metered.

Watch actual usage per app in the developer hub: **Applications → your app → API usage**. Use
**Hub analytics → Token usage** for the whole hub. Check it after your first few days of use to
confirm that usage appears under your own app and team.

## What runs where

- The server is a single JavaScript file inside the connector. It runs under Claude Desktop's
  bundled Node.js.
- Claude Desktop keeps the Client Secret, entered as a masked field. The data folder holds the
  robot key and the audit log. Audit files older than 90 days are deleted automatically.
- Network traffic goes only to Autodesk APIs (`developer.api.autodesk.com`) and to the signed
  download links those APIs return.
- Every project call runs as the robot account. The app's own credentials are used for one thing
  only: creating the robot in B3, with service-account permissions and no access to project data.
- Privacy policy: [PRIVACY.md](../PRIVACY.md). Support: hello@bimlynx.com
