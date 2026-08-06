# AWS Free Plan deployment — complete beginner guide

This guide runs the complete WhatsApp agent on one AWS EC2 Ubuntu VM. It covers account creation, billing safeguards, Docker, private GitHub access, credentials, Google/Swiggy authorization, WhatsApp pairing, Android SMS synchronization, automatic restart, and backup.

## Read this before creating the account

AWS is the best practical alternative when Oracle signup or capacity is unusable, but it is not permanently free:

- new AWS customers can select the **Free account plan**, receive $100 in credits, earn up to $100 more, and use eligible services for at most six months or until credits are exhausted;
- AWS currently lists `t4g.small` as Free Tier eligible and advertises up to 750 free instance-hours per month through **December 31, 2026**;
- the Free account plan does not ordinarily bill the payment method unless you deliberately upgrade or activate a paid-only service, but the account closes when its free-plan period or credits end;
- storage, public IPv4, outbound traffic, and sustained burst CPU can consume credits even when EC2 instance-hours are promotional.

Back up the private state well before the free period ends. If you want to continue after that, migrate to another host or deliberately accept paid AWS pricing.

No application-code change is required. The existing `Dockerfile`, `compose.yaml`, ARM64 packages, persistent `/data` paths, schedules, private budget policy, and Tailscale layout work on AWS unchanged.

## Shell labels used below

- **Windows PowerShell** means a PowerShell window on your Windows computer.
- **AWS Ubuntu** means the terminal after SSH connects and the prompt looks like `ubuntu@...:~$`.

Do not paste PowerShell commands into the Ubuntu terminal or Ubuntu commands into PowerShell. Keep the current Windows `npm start` agent online until the WhatsApp cutover step.

## 1. Push the deployment files to private GitHub

Confirm the GitHub repository displays the **Private** badge. Then run in **Windows PowerShell**:

```powershell
Set-Location "C:\Users\ayush\OneDrive\Desktop\whatsapp-food-agent"
npm test
npm run test:stock
npm audit --omit=dev
git diff --check
git status
```

Expect every Node and Python test to pass and `found 0 vulnerabilities`. `budget_2026-07.html` being deleted from Git is expected; its ignored local copy remains on Windows.

Stage only the known files:

```powershell
git add -u
git add .dockerignore .env.cloud.example AWS_FREE_DEPLOYMENT.md CLOUD_DEPLOYMENT.md Dockerfile budget-access-policy.js cloud-check.js compose.yaml runtime-paths.js stock_intelligence.py test/budget-chat-guardrails.test.js test/budget-category-rules.test.js test/runtime-paths.test.js test/test_stock_intelligence.py
git diff --cached --check
git diff --cached --name-only
git status
```

Make sure `.env`, JSON credentials, OAuth tokens, `.wwebjs_auth`, `cloud-data`, reports, and logs are absent from the staged list. Then:

```powershell
git commit -m "Add persistent cloud deployment"
git push origin master
```

Complete the GitHub browser sign-in if Windows Git requests it. Do not put a personal access token in the remote URL.

## 2. Create an AWS Free account

1. Open <https://aws.amazon.com/free/> and choose **Create a free account**.
2. Enter an email address you control and an AWS account name such as `Ayush WhatsApp Agent`.
3. Verify the email and create the root-user password.
4. Choose **Personal** account unless this genuinely belongs to a business.
5. Enter the requested contact details, payment card, and phone verification. AWS uses the card for identity verification.
6. When AWS asks for the account plan, choose **Free plan**, not Paid plan.
7. Choose the **Basic support — Free** option.
8. Sign in to the AWS Management Console as the root user.

Do not click **Upgrade Plan**, do not join an AWS Organization, and do not activate paid-only services. Joining an Organization can end Free Plan eligibility and credits.

### Protect the AWS root account

In the AWS console:

1. Click the account name at the top right.
2. Open **Security credentials**.
3. Under **Multi-factor authentication (MFA)**, choose **Assign MFA device**.
4. Select an authenticator app, scan the QR, and finish setup.

### Confirm the free plan

Open **Billing and Cost Management** and confirm the home page shows:

- Free account plan;
- remaining credit balance;
- free-plan expiration date.

Check this page weekly. Do not upgrade to Paid merely to clear a console prompt.

## 3. Select the AWS region

In the AWS console, use the region menu in the top-right corner and choose:

```text
Asia Pacific (Mumbai) — ap-south-1
```

Keeping AWS near India improves WhatsApp and SSH latency. Every EC2 item—key pair, security group, and instance—is region-specific, so keep the console on Mumbai for the remaining AWS steps.

## 4. Create the SSH key on Windows

Run in **Windows PowerShell**:

```powershell
$AwsSshDirectory = "$env:USERPROFILE\.ssh"
$AwsSshKey = "$AwsSshDirectory\aws-whatsapp-agent"
New-Item -ItemType Directory -Force -Path $AwsSshDirectory | Out-Null

if (-not (Test-Path -LiteralPath $AwsSshKey)) {
    ssh-keygen -t ed25519 -f $AwsSshKey -C "aws-whatsapp-agent"
}

Get-Content "$AwsSshKey.pub"
```

Do not overwrite an existing key. Copy the complete `.pub` line. Never upload or share the private file without `.pub`.

## 5. Import the public SSH key into EC2

In AWS:

1. Open **Services > EC2**.
2. In the left menu, open **Network & Security > Key pairs**.
3. Choose **Actions > Import key pair**.
4. Name: `whatsapp-agent`.
5. Paste the complete public key from Windows.
6. Choose **Import key pair**.

## 6. Launch the EC2 VM

In **EC2 > Instances**, choose **Launch instances** and use exactly these settings:

### Name

```text
whatsapp-agent
```

### Application and OS image

Choose **Ubuntu**, then select:

```text
Ubuntu Server 24.04 LTS
64-bit (Arm)
Canonical owner
```

Do not select an x86/AMD64 image because `t4g` is ARM64. Avoid Marketplace images with software charges.

### Instance type

```text
t4g.small
```

This provides 2 vCPUs and 2 GiB RAM. Confirm the console marks it Free Tier eligible for your account.

### Key pair

Choose:

```text
whatsapp-agent
```

Do not choose **Proceed without a key pair**.

### Network settings

Choose **Edit** and set:

- VPC: default VPC;
- subnet: no preference/default;
- auto-assign public IP: **Enable**;
- create security group;
- security-group name: `whatsapp-agent-ssh`;
- inbound rule: SSH, TCP 22, source **My IP**.

Remove HTTP and HTTPS rules if the wizard added them. Do not open ports `8787`, `3000`, `3001`, `16148`, or `21621`. OAuth tunnels use SSH and SMS uses private Tailscale Serve.

### Storage

Use one encrypted root volume:

```text
30 GiB gp3
```

Do not add another volume.

### Advanced details

- detailed CloudWatch monitoring: disabled;
- tenancy: shared;
- purchasing option: On-Demand, not Spot;
- credit specification: **Standard** if the field is shown;
- termination protection: enabled is recommended;
- IAM instance profile: none;
- user data: blank.

Standard CPU credit mode avoids surplus-credit charges; a long stock batch may run more slowly after burst credits are consumed.

Review the summary, confirm it says Free Tier eligible, and choose **Launch instance**.

## 7. Connect to EC2 from Windows

Wait until the instance state is **Running** and both status checks pass. Copy its **Public IPv4 address**.

Run in **Windows PowerShell**:

```powershell
$AwsVmIp = "REPLACE_WITH_EC2_PUBLIC_IP"
$AwsSshKey = "$env:USERPROFILE\.ssh\aws-whatsapp-agent"
ssh -i $AwsSshKey "ubuntu@$AwsVmIp"
```

Enter `yes` at the first host-key prompt. The Ubuntu username is `ubuntu`.

If SSH times out, edit the instance security group and refresh the port-22 source to your current **My IP** value.

## 8. Add swap for Chromium and Docker builds

The VM has 2 GiB RAM. Add a private 4 GiB swap file to handle image builds and temporary Chromium/Python peaks. Run in **AWS Ubuntu**:

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

The final output should show approximately 4 GiB of swap. Swap prevents many out-of-memory crashes but is slower than RAM, so stock batches can take longer than on Oracle.

## 9. Install Docker, Git, and Tailscale

Run in **AWS Ubuntu**:

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

Reconnect from **Windows PowerShell**:

```powershell
$AwsVmIp = "REPLACE_WITH_EC2_PUBLIC_IP"
$AwsSshKey = "$env:USERPROFILE\.ssh\aws-whatsapp-agent"
ssh -i $AwsSshKey "ubuntu@$AwsVmIp"
```

Verify in **AWS Ubuntu**:

```bash
docker version
docker compose version
docker run --rm hello-world
free -h
```

Install Tailscale:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Open the printed login link on Windows and sign in with the same Tailscale account as the Android phone. Then:

```bash
tailscale status
```

In the Tailscale Admin Console, open **Machines**, find the AWS VM, open its three-dot menu, and choose **Disable key expiry** for this trusted server.

## 10. Give EC2 read-only access to private GitHub

Run in **AWS Ubuntu**:

```bash
cd ~
ssh-keygen -t ed25519 -N "" -f ~/.ssh/github-whatsapp-agent -C "aws-whatsapp-agent-github"
cat ~/.ssh/github-whatsapp-agent.pub
```

Copy the line. In the private GitHub repository:

1. Open **Settings > Deploy keys > Add deploy key**.
2. Title: `AWS WhatsApp VM`.
3. Paste the public key.
4. Leave **Allow write access** unchecked.
5. Save.

Back in **AWS Ubuntu**:

```bash
cd ~
GIT_SSH_COMMAND='ssh -i ~/.ssh/github-whatsapp-agent -o IdentitiesOnly=yes' git clone git@github.com:ayushbhaimehta/whatsApp-agent.git
cd ~/whatsApp-agent
git config core.sshCommand "ssh -i ~/.ssh/github-whatsapp-agent -o IdentitiesOnly=yes"
ls -la
```

At the first GitHub host prompt, verify GitHub's published SSH fingerprint and enter `yes`.

## 11. Configure persistent data and `.env.cloud`

Run in **AWS Ubuntu**:

```bash
cd ~/whatsApp-agent
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

Copy the values from the working Windows `.env` into matching fields:

```dotenv
GEMINI_API_KEY=...
GEMINI_MODEL=
SPREADSHEET_ID=...
COOK_CHAT_ID=...
PERSONAL_CHAT_ID=...
USER_GOAL="..."
WHATSAPP_HEADLESS=true
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SMS_INGESTION_ENABLED=true
SMS_INGESTION_HOST=127.0.0.1
SMS_INGESTION_PORT=8787
SMS_SCAN_MAX_AGE_HOURS=12
SWIGGY_ORDER_HISTORY_ENABLED=true
SWIGGY_ORDER_SYNC_CRON="10 3 * * *"
MONTHLY_BUDGET_INR=...
BUDGET_ALLOW_INITIAL_CATCH_UP=false
REPORT_PUBLIC_BASE_URL=
```

`PERSONAL_CHAT_ID` must be the exact direct `@lid` or `@c.us` ID. It cannot be a group and cannot conflict with `COOK_CHAT_ID`. Keep the SMS host loopback-only and the public-report URL blank.

Save nano with `Ctrl+O`, Enter, `Ctrl+X`.

## 12. Copy private credentials from Windows

Open a separate **Windows PowerShell** window:

```powershell
$AwsVmIp = "REPLACE_WITH_EC2_PUBLIC_IP"
$AwsVm = "ubuntu@$AwsVmIp"
$AwsSshKey = "$env:USERPROFILE\.ssh\aws-whatsapp-agent"
$AgentProject = "C:\Users\ayush\OneDrive\Desktop\whatsapp-food-agent"
$SmsSecret = "$env:LOCALAPPDATA\WhatsAppFoodAgent\secrets\sms-ingestion-secret.txt"

scp -i $AwsSshKey "$AgentProject\service-account.json" "${AwsVm}:~/whatsApp-agent/cloud-data/secrets/service-account.json"
scp -i $AwsSshKey "$AgentProject\google-tasks-token.json" "${AwsVm}:~/whatsApp-agent/cloud-data/secrets/google-tasks-token.json"
scp -i $AwsSshKey $SmsSecret "${AwsVm}:~/whatsApp-agent/cloud-data/secrets/sms-ingestion-secret.txt"
```

`google-budget-token.json` is currently absent locally, so do not copy it and do not create an empty file. Authorize Gmail fresh on AWS later. Do not copy `.env` or the Windows `.wwebjs_auth` profile.

Back in **AWS Ubuntu**:

```bash
cd ~/whatsApp-agent
sudo chown -R 1000:1000 cloud-data
chmod 600 .env.cloud
find cloud-data -type d -exec chmod 700 {} +
find cloud-data/secrets -type f -exec chmod 600 {} +
```

## 13. Build and validate

Run in **AWS Ubuntu**:

```bash
cd ~/whatsApp-agent
docker compose build
docker compose run --rm agent npm test
docker compose run --rm agent npm run test:stock
docker compose run --rm agent npm run cloud:check
```

The build can take 10–30 minutes on a burstable 2 GiB VM. Do not interrupt it. Expect every Node and Python test to pass and `Cloud preflight passed`; optional Gmail/Swiggy warnings are acceptable until authorization.

If only the SMS secret is missing:

```bash
docker compose run --rm agent npm run setup:sms
docker compose run --rm agent npm run cloud:check
```

Save a newly generated SMS secret in the Android companion.

## 14. Authorize Google and Swiggy through SSH

In Google Cloud Console, ensure the OAuth web client permits:

```text
http://localhost:3000/oauth2callback
http://localhost:3001/oauth2callback
```

If Google Auth Platform > Audience shows External/Testing, publish the app to Production for unattended refresh tokens and authorize only your own account.

Open **Windows PowerShell** and keep this tunnel open:

```powershell
$AwsVmIp = "REPLACE_WITH_EC2_PUBLIC_IP"
$AwsSshKey = "$env:USERPROFILE\.ssh\aws-whatsapp-agent"
ssh -i $AwsSshKey `
  -L 3000:127.0.0.1:3000 `
  -L 3001:127.0.0.1:3001 `
  -L 16148:127.0.0.1:16148 `
  -L 21621:127.0.0.1:21621 `
  "ubuntu@$AwsVmIp"
```

Inside that SSH session, authorize Google Tasks:

```bash
cd ~/whatsApp-agent
docker compose run --rm agent npm run auth:tasks
```

Open the printed URL on Windows and approve. Then authorize Gmail receipt reading:

```bash
docker compose run --rm agent npm run auth:budget
```

Then authorize Swiggy Food and Instamart:

```bash
docker compose run --rm agent npm run auth:swiggy
```

Complete both Swiggy phone/OTP flows when prompted. Verify afterward:

```bash
docker compose run --rm agent npm run cloud:check
```

Enter `exit` when authorization is complete. Swiggy authorization can expire periodically; the background agent sends its one-time notice only to `PERSONAL_CHAT_ID`.

## 15. Cut over WhatsApp from Windows to AWS

On Windows, press `Ctrl+C` in the terminal running `npm start`. Confirm no old agent remains:

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*node*index.js*' } |
  Select-Object ProcessId, Name, CommandLine
```

Do not run both copies together.

In **AWS Ubuntu**:

```bash
cd ~/whatsApp-agent
docker compose up -d
docker compose logs --no-log-prefix -f agent
```

On the phone, open **WhatsApp > Settings > Linked devices > Link a device** and scan the terminal QR.

If the QR is difficult to scan, leave the container running and copy its PNG from **Windows PowerShell**:

```powershell
$AwsVmIp = "REPLACE_WITH_EC2_PUBLIC_IP"
$AwsSshKey = "$env:USERPROFILE\.ssh\aws-whatsapp-agent"
scp -i $AwsSshKey "ubuntu@${AwsVmIp}:~/whatsApp-agent/cloud-data/status/whatsapp-qr.png" "$env:USERPROFILE\Downloads\whatsapp-aws-qr.png"
```

Open the PNG on Windows and scan it. Wait for:

```text
Agent is online! Watching for NEW messages only...
```

Press `Ctrl+C` to leave the log display; the detached container remains online.

## 16. Point the Android SMS companion to AWS

Run in **AWS Ubuntu** after WhatsApp is ready:

```bash
curl http://127.0.0.1:8787/health
sudo tailscale serve --bg http://127.0.0.1:8787
tailscale serve status
```

If Serve is disabled, approve the exact URL Tailscale prints and run the last two commands again. Copy the HTTPS hostname shown by `tailscale serve status`.

On Android:

1. Connect Tailscale.
2. Open SMS Budget Companion.
3. Set its endpoint to `https://EXACT-AWS-TAILSCALE-HOST/v1/sms/transactions`.
4. Enter the same SMS shared secret stored on AWS.
5. Save and tap **Sync current month now**.
6. Wait for the completed scan timestamp.

Allow background activity and unrestricted battery use for Tailscale and SMS Budget Companion. Do not expose port 8787 in the AWS security group.

## 17. Verify all functionality

From the personal self-chat, send one at a time:

```text
macro summary
suggest me a dinner meal
stock report for AAPL
stock report of the day
budget for the month
```

From personal or cook chat:

```text
2 servings of poha for breakfast
buy paneer and milk
```

Send `budget for the month` in the cook chat as a privacy test; it must receive no budget information.

Schedules continue inside the one container:

- stock batch Monday–Friday at 6:00 PM Asia/Kolkata;
- monthly budget on the 26th;
- daily Swiggy cache refresh while its authorization is valid.

## 18. Confirm unattended restart

In **AWS Ubuntu**:

```bash
cd ~/whatsApp-agent
docker compose ps
sudo reboot
```

Wait about two minutes, reconnect from Windows, and check:

```powershell
$AwsVmIp = "REPLACE_WITH_EC2_PUBLIC_IP"
$AwsSshKey = "$env:USERPROFILE\.ssh\aws-whatsapp-agent"
ssh -i $AwsSshKey "ubuntu@$AwsVmIp"
```

```bash
cd ~/whatsApp-agent
docker compose ps
docker compose logs --tail=100 agent
free -h
```

The agent should restart automatically. A normal reboot keeps the public IP; stopping and starting the EC2 instance can assign a new public IP. Tailscale's private hostname remains stable.

## 19. Normal commands

Run from `~/whatsApp-agent` on AWS:

```bash
# Status
docker compose ps

# Logs
docker compose logs -f --tail=200 agent

# Restart
docker compose restart agent

# Stop intentionally
docker compose stop agent

# Start
docker compose up -d
```

After pushing a future update:

```bash
cd ~/whatsApp-agent
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose logs --tail=100 agent
```

Do not run `npm start` on Windows after cutover.

## 20. Back up before the AWS free period ends

Create an encrypted backup in **AWS Ubuntu**:

```bash
cd ~/whatsApp-agent
docker compose stop agent
AgentBackupFile="/home/ubuntu/whatsapp-agent-backup-$(date +%F).tar.gz.enc"
tar -C ~/whatsApp-agent -czf - cloud-data .env.cloud | openssl enc -aes-256-cbc -salt -pbkdf2 -out "$AgentBackupFile"
docker compose up -d
ls -lh "$AgentBackupFile"
```

Copy it to **Windows PowerShell** and store the encryption password separately:

```powershell
$AwsVmIp = "REPLACE_WITH_EC2_PUBLIC_IP"
$AwsSshKey = "$env:USERPROFILE\.ssh\aws-whatsapp-agent"
scp -i $AwsSshKey "ubuntu@${AwsVmIp}:/home/ubuntu/whatsapp-agent-backup-YYYY-MM-DD.tar.gz.enc" "$env:USERPROFILE\Downloads\"
```

The archive contains WhatsApp session material, OAuth tokens, the SMS encryption secret, encrypted transaction data, reports, and API keys. Never upload it unencrypted or commit it to GitHub.

## 21. Free-plan monitoring and shutdown

At least weekly, open AWS **Billing and Cost Management** and check:

- remaining credits;
- Free Plan days remaining;
- EC2 usage;
- EBS storage;
- public IPv4 usage.

Do not create NAT Gateway, load balancer, Elastic IP, snapshots, databases, or additional volumes without reviewing their cost. Tailscale replaces the need for a load balancer or public SMS port.

Before the Free Plan or T4g promotion ends:

1. create and download the encrypted backup;
2. verify that the backup exists on Windows;
3. migrate to another host or intentionally decide whether to upgrade to Paid;
4. if not continuing, terminate the EC2 instance and delete its EBS volume from the AWS console.

## Official references

- [AWS Free Tier plans and credits](https://aws.amazon.com/free/)
- [AWS EC2 Free Tier eligibility](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-free-tier-usage.html)
- [AWS T4g specifications and current promotion](https://aws.amazon.com/ec2/instance-types/t4/)
- [AWS EC2 launch parameters](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-launch-parameters.html)
- [AWS EC2 key pairs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-key-pairs.html)
- [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Tailscale key expiry](https://tailscale.com/docs/features/access-control/key-expiry)
- [Google OAuth token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
