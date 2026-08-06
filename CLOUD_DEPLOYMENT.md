# Zero-hosting-cost cloud deployment (Oracle Cloud Always Free)

This guide moves the whole agent from the Windows PC to one persistent Linux VM. After the move, Docker starts the agent again after a reboot, so the PC does not need to remain on and you do not run `npm start` locally.

## The short answer

Use an **Oracle Cloud Ampere A1 Always Free Ubuntu VM**. This can make the hosting charge zero; Gemini and other APIs can still have separate quotas or charges.

Do not deploy this application to Vercel. The agent is not a website function: it must keep one Chromium/WhatsApp Web session alive continuously, save a browser profile and OAuth tokens, accept SMS uploads, run Python reports that can take several minutes, and keep in-process schedules alive. Vercel functions are time-limited and their writable storage is temporary.

AWS's current free offer is temporary, and most free app hosts sleep or provide too little memory for Chromium. Oracle's free A1 VM is the closest fit, but it is not a promise of perfect forever-free availability: phone and payment-card verification are normally required, capacity can be unavailable, and Oracle documents that idle free instances may be reclaimed. Oracle may place a temporary card authorization hold and says it does not charge for Always Free usage unless you deliberately upgrade or use paid resources. Always Free has no SLA or regular Oracle technical support. Keep an encrypted backup of `cloud-data`.

## What the cloud deployment contains

```text
Phone WhatsApp
       |
       v
Oracle Always Free Ubuntu VM
  `- Docker container (automatically restarted)
       |- Node WhatsApp agent + headless Chromium
       |- nutrition, shopping, macro, meal and budget commands
       |- Python stock-report engine
       |- weekday 6:00 PM stock schedule
       |- monthly 26th budget schedule
       `- private SMS receiver on 127.0.0.1:8787
                    ^
                    | private HTTPS through Tailscale Serve
                    |
             Android SMS companion

Container-persistent files: ~/whatsApp-agent/cloud-data
```

The directory survives container restarts and image rebuilds, but not VM/boot-volume deletion or provider reclamation.

Only SSH port 22 is public. Do **not** open port 8787, 3000, 3001, 16148, or 21621 in Oracle's firewall. Tailscale Serve carries phone-to-agent traffic over your private tailnet. Google callbacks and SMS bind to loopback; the third-party Swiggy callback process may briefly bind its two callback ports on all VM interfaces during interactive authorization, so the closed cloud firewall is mandatory.

## Before starting

You need:

- an Oracle Cloud Free Tier account (normally requiring a valid phone number and credit/debit card for verification);
- a free Tailscale Personal account already signed in on the Android phone;
- this project pushed to a GitHub repository, without `.env`, JSON keys, tokens, logs, or WhatsApp profile data;
- the working `service-account.json` from the Windows installation;
- the values from the local `.env` file;
- about 45–90 minutes for the first setup.

Do not stop the working Windows agent until the final cutover step. Do not run the local and cloud copies together: two listeners using the same WhatsApp account can process a message twice.

## 1. Put the deployment files on GitHub

### Confirm the repository is private before pushing

The GitHub repository was previously public and an older commit contains `budget_2026-07.html`. That is private financial data. You have now changed the repository to private. Before running any Git command below, confirm it still shows the **Private** badge:

1. Open `https://github.com/ayushbhaimehta/whatsApp-agent` while signed in.
2. Open **Settings > General**.
3. Scroll to **Danger Zone > Change repository visibility**.
4. Confirm the page shows that the repository is private. If not, choose **Make private** and complete GitHub's confirmation.

The deletion prepared in this workspace removes the report from the newest revision, but it does not remove it from old commits. Keep the repository private. If you ever want to make it public again, first use a reviewed Git history-rewrite procedure and treat any secrets that were ever committed as compromised. No `.env`, Google token, or service-account key is currently known to be tracked, but still inspect the staged list below.

In PowerShell on Windows:

```powershell
Set-Location "C:\Users\ayush\OneDrive\Desktop\whatsapp-food-agent"
git status
git diff --check
npm test
npm audit --omit=dev
```

The expected result is 110 passing tests and `found 0 vulnerabilities`. In `git status`, `deleted: budget_2026-07.html` is expected: the private report still exists locally and is ignored, but the next commit removes it from Git tracking.

Confirm that none of these appears as a tracked/staged file:

```text
.env
service-account.json
google-tasks-token.json
google-budget-token.json
.wwebjs_auth/
cloud-data/
```

Stage the already tracked source updates plus the new, known-safe deployment files. Do not use `git add .` for this step:

```powershell
git add -u
git add .dockerignore .env.cloud.example AWS_FREE_DEPLOYMENT.md CLOUD_DEPLOYMENT.md Dockerfile budget-access-policy.js cloud-check.js compose.yaml runtime-paths.js test/budget-chat-guardrails.test.js test/runtime-paths.test.js
git status
git diff --cached --check
git diff --cached --name-only
git commit -m "Add persistent free-cloud deployment"
git push origin master
```

Before committing, inspect the printed filename list again for `.env`, credentials, tokens, logs, or session data. Never place a GitHub access token inside the remote URL.

This workspace previously tracked `budget_2026-07.html`. The deployment changes remove it from Git tracking while preserving the local file, and `.gitignore` now blocks future root-level budget HTML/JSON reports.

## 2. Create the free Oracle VM

1. Create or sign in to an [Oracle Cloud Free Tier account](https://www.oracle.com/cloud/free/).
2. Always Free compute and block volumes must be created in the tenancy's **home region**. Confirm that the console is showing that home region; it cannot simply be changed later.
3. In the Oracle console, open **Compute > Instances > Create instance**.
4. Name it `whatsapp-agent`.
5. Select **Ubuntu 24.04** as the image.
6. Select the **VM.Standard.A1.Flex** shape and keep it inside the displayed **Always Free-eligible** allowance. `2` OCPUs and `12 GB` RAM fit the current allowance and provide useful headroom for Chromium and a stock batch. A smaller allocation can be used if capacity is tight, but reports will run more slowly.
7. A 50 GB boot volume is sufficient. Make sure every selected resource is marked Always Free-eligible before creating it.
8. Create the default VCN/subnet if this is a new account, and assign a public IPv4 address for SSH.
9. In the subnet security list, allow inbound TCP `22` for SSH, preferably only from your current public IPv4 address using a `/32` source. Do not add `8787`, `3000`, `3001`, `16148`, or `21621`.

Your home public IP can change. If SSH later times out, look up your new public IPv4 address, open the Oracle subnet's security list, and replace the old port-22 `/32` source with the new one. A key-only `0.0.0.0/0` SSH rule avoids that lockout but exposes SSH attempts to the whole internet; use it only if you understand that tradeoff, never enable password login, and keep the private SSH key safe.

Oracle sometimes reports that the A1 shape is out of capacity. That is a provider-capacity issue, not an application error. Try another availability domain if the console offers one, or retry later. Do not accidentally select a paid shape as a workaround.

### Create an SSH key on Windows

In PowerShell:

```powershell
$AgentSshKey = "$env:USERPROFILE\.ssh\oci-whatsapp-agent"
ssh-keygen -t ed25519 -f $AgentSshKey -C "oracle-whatsapp-agent"
Get-Content "$AgentSshKey.pub"
```

Paste the printed public key into the VM's **Add SSH keys** field. Keep the private file on Windows.

After Oracle displays the VM's public IP:

```powershell
$AgentVmIp = "REPLACE_WITH_ORACLE_PUBLIC_IP"
$AgentSshKey = "$env:USERPROFILE\.ssh\oci-whatsapp-agent"
ssh -i $AgentSshKey "ubuntu@$AgentVmIp"
```

All commands in the next sections run in this Ubuntu SSH terminal unless a section explicitly says **Windows PowerShell**.

## 3. Install Docker, Git, and Tailscale

On the VM:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git nano openssl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
exit
```

Reconnect from Windows, then verify Docker:

```powershell
ssh -i $AgentSshKey "ubuntu@$AgentVmIp"
```

```bash
docker version
docker compose version
docker run --rm hello-world
```

Install and connect Tailscale on the VM:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Open the login link printed by `tailscale up` on Windows and use the same Tailscale account as the Android phone. Confirm the VM appears in the Tailscale admin page.

For unattended operation, open the Tailscale **Admin Console > Machines**, find this Oracle VM, open its three-dot menu, and choose **Disable key expiry**. Do this only for this trusted server: a non-expiring device key is convenient but increases the impact if the VM is compromised. Leave key expiry enabled on ordinary devices unless you have a reason to change it.

## 4. Download and configure the agent

The repository must now be private. Give only this VM read-only access:

```bash
cd ~
ssh-keygen -t ed25519 -f ~/.ssh/github-whatsapp-agent -C "oracle-whatsapp-agent-github"
cat ~/.ssh/github-whatsapp-agent.pub
```

Copy the one printed `.pub` line. In GitHub, open this repository, then **Settings > Deploy keys > Add deploy key**. Name it `Oracle WhatsApp VM`, paste the line, leave **Allow write access** unchecked, and save.

Back on the VM, clone with that key:

```bash
cd ~
GIT_SSH_COMMAND='ssh -i ~/.ssh/github-whatsapp-agent -o IdentitiesOnly=yes' git clone git@github.com:ayushbhaimehta/whatsApp-agent.git
cd whatsApp-agent
git config core.sshCommand "ssh -i ~/.ssh/github-whatsapp-agent -o IdentitiesOnly=yes"
cp .env.cloud.example .env.cloud
install -d -m 700 \
  cloud-data/secrets \
  cloud-data/budget-data \
  cloud-data/budget-reports \
  cloud-data/stock-reports \
  cloud-data/logs \
  cloud-data/status \
  cloud-data/whatsapp-auth
nano .env.cloud
```

The first SSH connection may ask whether GitHub's host key is trusted. Confirm that the displayed fingerprint matches [GitHub's published SSH fingerprints](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints) before entering `yes`. Do not paste a personal access token into a command or remote URL.

Copy these values from the working Windows `.env` into `.env.cloud`:

```dotenv
GEMINI_API_KEY=...
SPREADSHEET_ID=...
COOK_CHAT_ID=...
PERSONAL_CHAT_ID=...
USER_GOAL="..."
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
MONTHLY_BUDGET_INR=...
```

Leave `SMS_INGESTION_HOST=127.0.0.1`. Paths such as `/data/secrets/...` are already supplied by `compose.yaml`; do not replace them with Windows paths.

`PERSONAL_CHAT_ID` is mandatory for budget access and must be the exact direct-chat ID observed in the working agent log, for example `123456789012345@lid` or `919999999999@c.us`. A group ID ending in `@g.us` is invalid. `COOK_CHAT_ID` must not identify the same direct chat. The cloud preflight deliberately fails if this privacy configuration is unsafe.

In `nano`, press `Ctrl+O`, Enter, then `Ctrl+X` to save and exit.

## 5. Copy the private credentials securely

Keep the SSH session open. In a separate **Windows PowerShell** window:

```powershell
$AgentVmIp = "REPLACE_WITH_ORACLE_PUBLIC_IP"
$AgentVm = "ubuntu@$AgentVmIp"
$AgentSshKey = "$env:USERPROFILE\.ssh\oci-whatsapp-agent"
$AgentProject = "C:\Users\ayush\OneDrive\Desktop\whatsapp-food-agent"

scp -i $AgentSshKey "$AgentProject\service-account.json" "${AgentVm}:~/whatsApp-agent/cloud-data/secrets/service-account.json"
scp -i $AgentSshKey "$AgentProject\google-tasks-token.json" "${AgentVm}:~/whatsApp-agent/cloud-data/secrets/google-tasks-token.json"
scp -i $AgentSshKey "$env:LOCALAPPDATA\WhatsAppFoodAgent\secrets\sms-ingestion-secret.txt" "${AgentVm}:~/whatsApp-agent/cloud-data/secrets/sms-ingestion-secret.txt"
```

The Google Tasks token copy is optional if it is expired; section 7 can create a fresh one. If Gmail receipt access was already authorized and this file exists, copy it too:

```powershell
scp -i $AgentSshKey "$env:LOCALAPPDATA\WhatsAppFoodAgent\google-budget-token.json" "${AgentVm}:~/whatsApp-agent/cloud-data/secrets/google-budget-token.json"
```

Do not copy the Windows `.wwebjs_auth` directory. Chromium profiles are not reliably portable between Windows and Linux; WhatsApp will be paired fresh in section 8.

Back in the VM SSH terminal:

```bash
cd ~/whatsApp-agent
sudo chown -R 1000:1000 cloud-data
chmod 600 .env.cloud
find cloud-data -type d -exec chmod 700 {} +
find cloud-data/secrets -type f -exec chmod 600 {} +
```

Always use `1000:1000` here: it is the fixed UID/GID of the non-root `node` user inside the container, regardless of the SSH user's host UID. Directories retain execute permission while secret files are private.

### Moving existing SMS history is optional

The Android app scans the entire current month, so normally you can leave the cloud SMS store empty and tap **Sync current month now** after changing its endpoint. If you copy an existing encrypted SMS store, you must also copy the exact existing SMS secret; otherwise it cannot be decrypted.

## 6. Build and validate the container

This will be the first complete Linux/ARM64 image build for this package because Docker was not running in the Windows validation environment. Treat it as a required proof: do not start the live agent unless both commands below succeed.

On the VM:

```bash
cd ~/whatsApp-agent
docker compose build
docker compose run --rm agent npm run cloud:check
```

The check must end with `Cloud preflight passed`. Optional Gmail or Swiggy warnings are acceptable if those sources are intentionally disabled. Fix every item marked `ERROR` before continuing.

If the only error is a missing SMS secret and there was no existing file to copy, create one inside the persistent volume:

```bash
docker compose run --rm agent npm run setup:sms
docker compose run --rm agent npm run cloud:check
```

Copy the newly printed secret into the Android companion in section 9. Treat it like a password and do not post it in WhatsApp, GitHub, or a screenshot.

## 7. Authorize cloud OAuth integrations when needed

`cloud:check` confirms only that token files have the expected shape; it cannot prove that Google or Swiggy will still accept them. You may initially skip a present token, then confirm it in normal logs/use. Reauthorize on `invalid_grant`, HTTP 401, or a Swiggy reauthorization warning.

For authorization, establish one tunnel from **Windows PowerShell** and keep it open:

```powershell
$AgentVmIp = "REPLACE_WITH_ORACLE_PUBLIC_IP"
$AgentSshKey = "$env:USERPROFILE\.ssh\oci-whatsapp-agent"
ssh -i $AgentSshKey `
  -L 3000:127.0.0.1:3000 `
  -L 3001:127.0.0.1:3001 `
  -L 16148:127.0.0.1:16148 `
  -L 21621:127.0.0.1:21621 `
  "ubuntu@$AgentVmIp"
```

Run the required command inside that tunneled SSH session. Open the long URL printed by the command in a browser on Windows. Its localhost callback travels securely to the VM.

Google Tasks:

```bash
cd ~/whatsApp-agent
docker compose run --rm agent npm run auth:tasks
```

Optional Gmail receipt reading:

```bash
docker compose run --rm agent npm run auth:budget
```

Optional Swiggy Food and Instamart order history:

```bash
docker compose stop agent
docker compose run --rm agent npm run auth:swiggy
docker compose up -d
```

For Swiggy, complete both phone/OTP flows. Its current authorization is short-lived, so this command may need to be repeated approximately every five days. The regular background agent never opens an interactive login by itself.

For unattended Google access, open **Google Cloud Console > Google Auth Platform > Audience**. If the app is **External** and its publishing status is **Testing**, click **Publish app**, confirm **In production**, and keep your own account as the only user you authorize. Google documents that External/Testing refresh tokens for these scopes expire after seven days. A personal app can show an unverified-app warning; do not grant access to anyone else's account. Google Workspace users may instead use an Internal app where supported.

## 8. Stop Windows and pair WhatsApp on the VM

This is the cutover. First stop the local Windows copy with `Ctrl+C` and make sure no other `node index.js` process is running.

On the VM:

```bash
cd ~/whatsApp-agent
docker compose up -d
docker compose logs --no-log-prefix -f agent
```

When the terminal shows a QR code, on the phone open:

```text
WhatsApp > Settings > Linked devices > Link a device
```

Scan the terminal QR. If it is hard to scan, leave the container running and open a separate **Windows PowerShell** window to copy the generated PNG:

```powershell
$AgentVmIp = "REPLACE_WITH_ORACLE_PUBLIC_IP"
$AgentSshKey = "$env:USERPROFILE\.ssh\oci-whatsapp-agent"
scp -i $AgentSshKey "ubuntu@${AgentVmIp}:~/whatsApp-agent/cloud-data/status/whatsapp-qr.png" "$env:USERPROFILE\Downloads\whatsapp-cloud-qr.png"
```

Open that PNG on Windows and scan it. The file is automatically removed after successful pairing. Wait for:

```text
Agent is online! Watching for NEW messages only...
```

Press `Ctrl+C` to leave the log view; that does not stop the detached container.

## 9. Connect the Android SMS companion through Tailscale

On the VM, while the WhatsApp agent is online:

```bash
curl http://127.0.0.1:8787/health
sudo tailscale serve --bg http://127.0.0.1:8787
tailscale serve status
```

If Tailscale says Serve is disabled, open the exact enablement link it prints, approve Serve for the tailnet, and run the last two commands again.

`tailscale serve status` prints an HTTPS hostname similar to:

```text
https://whatsapp-agent.your-tailnet.ts.net
```

On the Android phone:

1. Make sure Tailscale is connected.
2. Open **SMS Budget Companion**.
3. Change **HTTPS upload endpoint** to `https://THE-EXACT-TAILSCALE-HOST/v1/sms/transactions`.
4. Keep the same shared secret if it was copied to the VM. Otherwise enter the new secret from `cloud-data/secrets/sms-ingestion-secret.txt`.
5. Save, then tap **Sync current month now**.
6. Wait for the app to display a completed scan timestamp.

In Android **Settings > Apps**, allow background activity and choose **Unrestricted** battery use for both **Tailscale** and **SMS Budget Companion** if your phone offers those controls. Keep Tailscale connected. Phone manufacturers can otherwise delay the companion's background scans; a manual **Sync current month now** before a budget request remains the safest check.

Do not add `/health` to the companion endpoint. Do not open port 8787 publicly.

## 10. Verify every important path

Send these from `PERSONAL_CHAT_ID`, one at a time:

```text
macro summary
suggest me a dinner meal
stock report for AAPL
budget for the month
```

Privacy test: send `budget for the month` in the cook chat or any group. It must receive no budget reply, create no budget report for that chat, and must not call Gemini for a recognizable text request. Budget output and the monthly scheduled report always go only to the exact configured `PERSONAL_CHAT_ID`.

Send a food message from either the personal or cook chat:

```text
2 servings of poha for breakfast
```

Send a shopping request from either chat:

```text
buy paneer and milk
```

The existing schedules remain inside the one agent process:

- complete configured stock batch: Monday–Friday at 6:00 PM Asia/Kolkata;
- monthly budget report: the 26th of each month;
- Swiggy cache refresh: daily at the configured time while authorization remains valid.

## Normal operation

The only process command needed after setup is:

```bash
docker compose up -d
```

Docker's `restart: unless-stopped` policy starts the agent after VM or Docker restarts. You no longer run `npm start` on Windows.

Useful commands from `~/whatsApp-agent`:

```bash
# Current state
docker compose ps

# Follow logs
docker compose logs -f --tail=200 agent

# Restart cleanly
docker compose restart agent

# Stop intentionally (it remains stopped after reboot)
docker compose stop agent

# Start after an intentional stop
docker compose up -d
```

### Updating the application

After pushing new code to GitHub:

```bash
cd ~/whatsApp-agent
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose logs --tail=100 agent
```

The `cloud-data` bind mount survives image rebuilds.

### Check disk space monthly

Docker's console logs rotate automatically, but WhatsApp audit logs and generated reports are retained until you archive or remove them. Check usage at least monthly:

```bash
df -h /
du -sh cloud-data cloud-data/*
```

If usage grows, make the encrypted backup below first, stop the agent, and manually archive only old files you have reviewed. Do not run a broad recursive delete against `cloud-data`; it also contains the live WhatsApp session, encryption secret, and OAuth tokens.

### Back up the private state

The most important directory is:

```text
~/whatsApp-agent/cloud-data
```

It contains WhatsApp session material, Google/Swiggy tokens, the SMS encryption secret, encrypted transaction data, and reports. `.env.cloud` contains the configuration and API keys needed to restore those services. Anyone with either may gain access to sensitive data, so back them up together, encrypt the archive, and never commit or upload it publicly.

Create a consistent encrypted backup on the VM (choose a strong password when OpenSSL prompts):

```bash
cd ~/whatsApp-agent
docker compose stop agent
AgentBackupFile="/home/ubuntu/whatsapp-agent-backup-$(date +%F).tar.gz.enc"
tar -C ~/whatsApp-agent -czf - cloud-data .env.cloud | openssl enc -aes-256-cbc -salt -pbkdf2 -out "$AgentBackupFile"
docker compose up -d
ls -lh "$AgentBackupFile"
```

Copy it to **Windows PowerShell** and store the password separately:

```powershell
scp -i $AgentSshKey "ubuntu@${AgentVmIp}:/home/ubuntu/whatsapp-agent-backup-YYYY-MM-DD.tar.gz.enc" "$env:USERPROFILE\Downloads\"
```

On a replacement VM, put the encrypted file in `/home/ubuntu`, stop the agent, preserve any current data under a different name, and restore:

```bash
cd ~/whatsApp-agent
docker compose stop agent
mv cloud-data "cloud-data.before-restore-$(date +%s)"
openssl enc -d -aes-256-cbc -pbkdf2 -in /home/ubuntu/whatsapp-agent-backup-YYYY-MM-DD.tar.gz.enc | tar -xzf - -C ~/whatsApp-agent
sudo chown -R 1000:1000 cloud-data
find cloud-data -type d -exec chmod 700 {} +
find cloud-data/secrets -type f -exec chmod 600 {} +
chmod 600 .env.cloud
docker compose up -d
```

An Oracle free instance may be reclaimed under the provider's documented idle-resource policy. A backup lets you recreate the VM and re-pair only where necessary. Do not generate artificial traffic to evade an idle policy.

## Keeping the hosting bill at zero

- Select only resources explicitly labelled Always Free-eligible.
- Keep the A1 CPU, RAM, and total block storage within Oracle's displayed free allowance.
- Do not create a paid load balancer, NAT Gateway, database, additional paid disk, or paid backup schedule.
- Use Tailscale Serve instead of a public reverse proxy/load balancer.
- Keep the devices inside Tailscale's free Personal-plan limits.
- Check Oracle **Billing & Cost Management > Cost Analysis** after setup.
- Oracle may place a temporary verification hold on a payment card during signup. Do not upgrade the account to Pay As You Go unless you intentionally accept possible charges.
- Gemini and other external APIs are separate from hosting. Their quota exhaustion can reduce AI enrichment or require a paid API plan even when the VM remains free.

## Why the other free choices were rejected

| Service | Why it does not fit this agent |
|---|---|
| Vercel Hobby | No permanent process, time-limited functions, temporary writable filesystem, and Hobby cron cannot reliably run an exact 6:00 PM five-days-a-week job. |
| AWS Free Plan | A VM can run it, but the current new-account free plan is limited by time/credits rather than being an ongoing no-cost host. |
| Google `e2-micro` | The ongoing free VM allowance is much smaller; about 1 GB RAM is not a reliable home for Chromium plus Node and Python, and an ordinary in-use external IPv4 is billed separately. |
| Railway Free | Its small monthly credit, memory, and storage are not enough for an always-running Chromium agent. |
| Render/Koyeb free | Services sleep and free persistent storage is unavailable or insufficient. |
| Fly.io | New users receive a short trial rather than a permanent free VM allowance. |

Provider limits change. Recheck the provider's pricing page before creating resources.

## Troubleshooting

### `docker compose` says `.env.cloud` is missing

```bash
cp .env.cloud.example .env.cloud
nano .env.cloud
```

### Chromium fails or exits

Check that the image installed it and that shared memory is configured:

```bash
docker compose run --rm agent sh -lc 'chromium --version && df -h /dev/shm'
```

Do not remove `shm_size: 1gb` from `compose.yaml`.

### WhatsApp says the browser/session is already running

Only one agent container may use the profile:

```bash
docker compose ps
docker compose down
docker compose up -d
```

Also stop the old Windows process. Never start two Compose projects against the same `cloud-data` directory.

### WhatsApp asks to pair again or the saved session is invalid

First open **WhatsApp > Settings > Linked devices** on the phone and remove the broken Oracle-linked session if it is listed. Preserve the old profile instead of deleting it:

```bash
cd ~/whatsApp-agent
docker compose stop agent
mv cloud-data/whatsapp-auth "cloud-data/whatsapp-auth.invalid-$(date +%Y%m%d-%H%M%S)"
install -d -m 700 cloud-data/whatsapp-auth
sudo chown 1000:1000 cloud-data/whatsapp-auth
docker compose up -d
docker compose logs --no-log-prefix -f agent
```

Scan the new QR exactly as in section 8. After the new link has worked for several days and after an encrypted backup, you may manually remove the specifically named `.invalid-...` directory.

### The SMS companion cannot sync

Check in this order:

```bash
docker compose ps
docker compose logs --tail=100 agent
curl http://127.0.0.1:8787/health
tailscale status
tailscale serve status
```

The SMS listener starts only after WhatsApp is paired and ready. The phone must be connected to the same tailnet and must use the exact HTTPS endpoint plus `/v1/sms/transactions`.

### Google OAuth callback does not open

Keep the SSH tunnel open, confirm the corresponding `docker compose run` command is still waiting, and ensure the Google OAuth client's authorized redirect URIs include:

```text
http://localhost:3000/oauth2callback
http://localhost:3001/oauth2callback
```

### Swiggy callback fails

Use the four-port SSH tunnel from section 7. Re-run `npm run auth:swiggy` only when the normal logs say reauthorization is required. Swiggy may change the capabilities or lifetime of its service independently of this application.

### The scheduled job did not run

```bash
docker compose ps
docker compose logs --since=24h agent
```

The schedules run only while the container is online and WhatsApp is ready. The container timezone is fixed to `Asia/Kolkata`. The budget schedule also stays disabled if `PERSONAL_CHAT_ID` is not a valid direct `@lid`/`@c.us` ID or conflicts with `COOK_CHAT_ID`; run `docker compose run --rm agent npm run cloud:check` to see that error safely.

## Official provider references

- [Oracle Always Free resource limits and idle reclamation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [Oracle Free Tier FAQ](https://www.oracle.com/cloud/free/faq/)
- [Vercel function limits](https://vercel.com/docs/functions/limitations)
- [Vercel function filesystem behavior](https://vercel.com/docs/functions/runtimes)
- [Vercel cron pricing and Hobby restrictions](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- [AWS Free Tier plan documentation](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-FAQ.html)
- [Google Cloud Free Program](https://docs.cloud.google.com/free/docs/free-cloud-features)
- [Google Cloud external IPv4 pricing](https://cloud.google.com/vpc/pricing)
- [Tailscale plans](https://tailscale.com/pricing)
- [Tailscale device key expiry](https://tailscale.com/docs/features/access-control/key-expiry)
- [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Google OAuth refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Railway pricing](https://railway.com/pricing)
- [Render free-service limitations](https://render.com/docs/free)
- [Koyeb instance limits](https://www.koyeb.com/docs/reference/instances)
- [Fly.io free trial](https://fly.io/docs/about/free-trial/)
