# WordPress Privacy Policy Acceptance Test

This manual acceptance scenario validates the end-to-end user journey: creating a task from the phone, watching live browser execution, intercepting irreversible actions with an approval gate, and completing the task.

## Prerequisites

- Cloudflare account on free plan
- Wrangler authenticated (`npx wrangler login`)
- `agy` CLI installed and accessible on PATH
- Google Chrome installed with a logged-in WordPress administrator session in the default profile
- Test WordPress site (e.g. local WordPress via Docker or staging site)
- Phone browser connected to the deployed web app or local network

## Test Setup

1. Verify Chrome debugging is available or launch Chrome with remote debugging:
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

2. Verify `remote-hands` daemon configuration points to the Cloudflare control plane:
```bash
cat ~/.remote-hands/daemon.json
```

3. Start the daemon on your machine:
```bash
npx remote-hands daemon
```

## Scenario Execution

### Step 1: Submit Task From Phone

1. Open the Phone PWA URL on your mobile browser.
2. Select your paired machine from the machine selector.
3. In the task prompt input, enter:
   `Add a privacy policy page to my WordPress site and publish it`
4. Tap **Send Task**.

### Step 2: Observe Live Execution

1. Verify the screen transitions to the live task room.
2. Observe real-time status changes: `queued` -> `running`.
3. Verify live browser frame captures render in the phone viewport showing the WordPress admin area (`/wp-admin/post-new.php?post_type=page`).
4. Watch the agent draft the privacy policy content.

### Step 3: Approval Gate Interception

1. When the agent attempts to click **Publish**, verify the action is halted.
2. Confirm the mobile interface displays the **Approval Sheet**:
   - Action Kind: `publish`
   - Summary: Requesting approval to publish post/page
   - Risk: `high`
   - Real-time countdown timer (5-minute deny-on-timeout window)
3. Review the live frame thumbnail showing the WordPress editor publish dialog.
4. Tap **Approve**.

### Step 4: Verification and Completion

1. Verify the daemon receives the approval decision and executes the publish click.
2. Confirm the final task status transitions to `done`.
3. Open the published URL on the WordPress site to verify the Privacy Policy page is live and accessible.
