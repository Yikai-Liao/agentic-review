# Lark App and Authorizing User Guide

Central review has paused Lark evidence and judgment and consumes none of the authorization or tools below; token authorization and automatic renewal stay in place. This guide covers local verification by maintainers, keeping the renewal chain alive, and a future restore of reading.

Use it when a central repository maintainer connects Lark for the first time, switches the Lark app, or hands over the authorizing user. Run local commands from this repository's root; write secrets to the local `.env` or GitHub secrets, never to chat, PRs, or logs.

## What Gets Linked

The App ID and App Secret identify the app, and the read-only scopes in the app console decide which API capabilities it may request. **Only when you confirm authorization on the OAuth page is the app linked to a specific Lark enterprise user identity.** From then on Lark decides each read by that identity's document permissions.

Authorization is not limited to the one table provided for testing. The app's readable range is the intersection of "API scopes the app enabled and the user granted" and "the material permissions of the authorizing enterprise user identity". Review behavior after a restore is defined by `central/lark-context.md`, not by OAuth isolation per document.

Switching tenants under the same phone number may be a different user identity. Pick the tenant that can open the target material when authorizing, and during acceptance check the returned `name`, `open_id`, and `tenant_key`, not just the display name.

## First-Time Setup: Who Does What

| Step | What you do | What the maintenance session or workflow does | Done when |
|---|---|---|---|
| 1. Prepare the app | Create a dedicated Lark app, enable read-only user scopes and publish; availability includes the authorizing user | Checks scopes against the [deployment guide](deploy-central-review.md#create-the-lark-app) | App published and authorizable |
| 2. Provide configuration | Fill `APP_ID` and `APP_SECRET` in the local `.env` and provide Docx/wiki/base links approved for testing | Reads configuration without printing secrets; prepares the pinned CLI | Configuration usable |
| 3. Link the user | Open the Lark link generated this round, pick the enterprise identity, and approve; tell the maintenance session | Collects this round's device flow result | Login succeeded with no required scope missing |
| 4. Verify material | Confirm the expected account and test material came back | Reads bodies or a few table records with `--as user` | Expected content actually returned |
| 5. Connect Actions | Prepare the dedicated GitHub Rotator App and configure admin-side credentials | Configures environment secrets per the deployment guide and starts production authorization from the default-branch workflow | Production authorization and one renewal both succeed |

Writing only `APP_ID` and `APP_SECRET` to `.env` neither logs in nor syncs to GitHub. A successful local OAuth does not mean Actions is connected; production authorization follows the Actions steps below.

## Local Verification with an Existing `.env`

This is for maintainer testing and never runs in the review agent. The commands target Linux x86_64 (same as Actions) and need Node.js 24, curl, tar, sha256sum, awk, and network access to GitHub and Lark. `.env` looks like this with real values in place of the placeholders; this repository ignores `.env`:

```dotenv
APP_ID=cli_your_app_id
APP_SECRET=your_app_secret
```

### 1. Prepare the CLI and a Separate Config Directory

```bash
set -euo pipefail
chmod 600 .env
lark_cli_version="$(awk '$1 == "LARK_CLI_VERSION:" { print $2 }' .github/workflows/review-execution.yml)"
lark_cli_sha256="$(awk '$1 == "LARK_CLI_SHA256_LINUX_AMD64:" { print $2 }' .github/workflows/review-execution.yml)"
lark_cli_dir="$(mktemp -d)"
lark_cli_archive="lark-cli-$lark_cli_version-linux-amd64.tar.gz"
curl --fail --location --silent --show-error \
  "https://github.com/larksuite/cli/releases/download/v$lark_cli_version/$lark_cli_archive" \
  --output "$lark_cli_dir/$lark_cli_archive"
echo "$lark_cli_sha256  $lark_cli_dir/$lark_cli_archive" | sha256sum --check --strict
tar --extract --gzip --file "$lark_cli_dir/$lark_cli_archive" --directory "$lark_cli_dir" lark-cli
export PATH="$lark_cli_dir:$PATH"
lark-cli --version
export LARKSUITE_CLI_CONFIG_DIR="$(mktemp -d)"
```

The version and expected SHA-256 both come from `.github/workflows/review-execution.yml` in the current trusted checkout; the official archive is prepared by hand and its integrity checked, while current reviews never install or restore the CLI. A failed check must stop: never extract and run it or go on to enter credentials. Even with the same CLI version installed locally, use the file just verified and extracted; a version number proves no integrity. Other operating systems or architectures need their own release artifact and trusted checksum first; never reuse the Linux archive or skip the check. Official CLI installation and authentication are in [larksuite/cli](https://github.com/larksuite/cli/tree/v1.0.88#readme).

Run the following commands in the same terminal and config directory to avoid overwriting other CLI identities. This directory will contain local credentials; never commit it or upload it as an Actions cache. Do not set external credential variables such as `LARKSUITE_CLI_USER_ACCESS_TOKEN` in this terminal, or the CLI's `auth` management commands become unavailable.

### 2. Bind the App from `.env` to the CLI

```bash
node --env-file=.env -p 'process.env.APP_SECRET' \
  | lark-cli config init \
      --app-id "$(node --env-file=.env -p 'process.env.APP_ID')" \
      --app-secret-stdin --brand feishu
```

The App Secret goes through stdin so it never appears in process arguments. Node parses `.env`; do not `source .env` and execute its contents. First confirm both fields are filled and no environment variables of the same name override them in the terminal.

### 3. Start Your Own Authorization

Read the single scope list from the production script:

```bash
lark_scopes="$(node --input-type=module -e 'import { larkScopes } from "./scripts/refresh-lark-user-token.ts"; process.stdout.write(larkScopes)')"
lark-cli auth login --scope "$lark_scopes" --no-wait --json
```

Open the returned `verification_url` and confirm with the expected user and enterprise identity. When a maintenance agent runs this, it sends the link to the user and ends its turn; after the user replies that it is done, the same maintenance session runs:

```bash
lark-cli auth login --device-code '<device_code returned this round>' --json
```

The success response should show no missing required scope. The authorization link and device code lifetimes follow this round's response; when expired, start again rather than reusing old links. The test table given to the maintenance session is not the only object OAuth makes readable.

### 4. Verify User Identity and Actual Reads

```bash
lark-cli api GET /open-apis/authen/v1/user_info --as user --format json \
  --jq '.data | {name, open_id, tenant_key}'

lark-cli docs +fetch --as user --doc '<full Docx or wiki URL>' \
  --scope outline --max-depth 3 --doc-format markdown
```

For a base, first resolve the base token, table ID, and view ID from the URL, then list fields:

```bash
lark-cli base +url-resolve --as user --url '<full base URL>' --format json
lark-cli base +field-list --as user --base-token '<BASE_TOKEN>' \
  --table-id '<TABLE_ID>' --format json
lark-cli base +record-list --as user --base-token '<BASE_TOKEN>' \
  --table-id '<TABLE_ID>' --view-id '<VIEW_ID>' \
  --field-id '<ID field>' --field-id '<title field>' --field-id '<status field>' \
  --limit 3 --format json
```

Omit `--view-id` when the URL names no view. Use the real field IDs from the previous command. Verify only a few records rather than scanning the whole table; listing fields does not mean records are readable, and an empty result does not prove complete permissions.

## Connecting Actions Renewal

Production configuration follows [section 4 of the deployment guide](deploy-central-review.md#4-lark-user-oauth-and-automatic-renewal): create two environments, configure the dedicated Rotator GitHub App, and place the App ID and long-lived credentials accordingly. Never copy the local CLI login directory or refresh token to Actions; the two sides must not consume the same renewal chain.

The workflow must already be on the default branch. First setup and user switches both authorize again from the default branch:

```bash
gh api --method POST repos/Qiyin-Tech/agentic-review/dispatches \
  -f event_type=authorize-lark-user
```

Open the Lark link in Actions → **Refresh Lark User Token** → the current run → the **Refresh and rotate Lark user token** log and confirm with the expected account. This round the workflow collects the result and saves the tokens itself; do not run `--device-code` locally.

After the run succeeds and both environment token secrets show new update times, send a `refresh-lark-user` event and confirm the renewal succeeds too; that completes the Actions authorization and renewal kept for now. Central review reads no material at present; after a future restore, trigger a review with relevant links per the deployment guide and check the actual read evidence.

## Switching the Lark App or User

| What changes | What to update | Re-authorize the user? |
|---|---|---|
| Only the user or enterprise identity, same app | Keep App ID / Secret, replace the whole user token pair | Yes, by the new user under the expected enterprise identity |
| The app, with the same or a new user | The new app's read-only user scopes, availability, App ID, App Secret, and the whole user token pair | Yes, old tokens never pair with a new app |
| Only the visible document range | Share material with the current authorizing identity; update downstream source declarations | Not when scopes already suffice |
| Additional API scopes | Enable and publish the scopes in the app, then authorize again | Yes, updating app scopes does not mean the user consented |

### 1. Verify the New Combination First

Run the local flow above for the new app or user in a new config directory, including authorization and reads of representative material. Record the expected user and tenant identifiers; never take results the old user could read as verification of the new user. When only the Lark app or user changes, the existing Rotator GitHub App keeps working.

### 2. Pause Production and Wait for Old Runs

Central review consumes no Lark credentials now, so switching the app or user only needs the renewal workflow paused. The central review stop/start commands below apply only after Lark reading is restored. Plan a maintenance window and pause the relevant workflows:

```bash
gh workflow disable agentic-review.yml --repo Qiyin-Tech/agentic-review
gh workflow disable lark-token-refresh.yml --repo Qiyin-Tech/agentic-review
gh run list --repo Qiyin-Tech/agentic-review --workflow agentic-review.yml
gh run list --repo Qiyin-Tech/agentic-review --workflow lark-token-refresh.yml
```

Confirm on the Actions page that every queued, waiting, and running old task has finished before changing credentials. Disabling a workflow only blocks new triggers and does not end old runs; never cancel a renewal while it exchanges the refresh token. Review triggers missed during maintenance need rerunning afterwards. GitHub's disable and enable steps are in the [official docs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows).

### 3. Replace Configuration and Remove Old Tokens

Skip the app configuration update when only the user changes; when the app changes, update `AGENTIC_REVIEW_LARK_APP_ID` and `AGENTIC_REVIEW_LARK_APP_SECRET` in `lark-rotation` per the deployment guide. Editing the local `.env` does not update them.

Delete the old tokens from both GitHub environments so a new app never pairs with an old refresh token and a failed authorization never keeps the old user:

```bash
gh secret delete AGENTIC_REVIEW_LARK_REFRESH_TOKEN --env lark-rotation --repo Qiyin-Tech/agentic-review
gh secret delete AGENTIC_REVIEW_LARK_USER_ACCESS_TOKEN --env lark-review --repo Qiyin-Tech/agentic-review
```

These cannot be retrieved from GitHub after deletion, and restoring the old identity also needs a fresh authorization; long-lived app and Rotator configuration are not deleted.

### 4. Authorize Again and Resume

After enabling the renewal workflow, immediately send `authorize-lark-user` and have the new user confirm. A scheduled renewal that happens to fire before authorization completes fails explicitly for lack of a refresh token; that does not mean the authorization event failed.

```bash
gh workflow enable lark-token-refresh.yml --repo Qiyin-Tech/agentic-review
gh api --method POST repos/Qiyin-Tech/agentic-review/dispatches -f event_type=authorize-lark-user
```

Once authorization and one `refresh-lark-user` renewal both succeed, the rotation is complete. If Lark reading had been restored and review was disabled for maintenance, also run:

```bash
gh workflow enable agentic-review.yml --repo Qiyin-Tech/agentic-review
```

With Lark reading enabled, rerun a test review and confirm identity, documents, and records are as expected. If that acceptance fails, keep Lark reading disabled and fix configuration, scopes, or sharing; never backfill expired tokens. To return to the old app or user, restore that app's configuration and have the old user authorize again. After the handover, the old user revokes the no-longer-needed app authorization on the Lark side; a local `auth logout` does not replace server-side revocation.

## Common Snags

- **`.env` is filled but my documents are not linked**: user OAuth is not done yet; app credentials do not represent you.
- **Did I authorize only one test table?** No; the table link is for acceptance, and OAuth grants API capabilities under the user identity.
- **The name is right but the document is unreadable**: check the enterprise identity, document sharing, and table row and column permissions; a matching display name is not enough.
- **Local reads work but Actions fails**: check GitHub configuration and production authorization; local logins never sync to Actions.
- **Refresh fails after switching apps**: check whether the old app's refresh token is still in use; authorize again to get a new token pair.
- **The authorization link expired**: restart the matching local login or `authorize-lark-user` event and open the new link.
