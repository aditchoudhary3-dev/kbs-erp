# Putting KBS School ERP online

This guide takes the app from your computer to a secure web address that the office, teachers and parents can all use from their phones. You do not need to know programming. Follow the steps in order; each one says exactly what to click or type.

## How it works

```
Parents' phones ───┐
Teachers' phones ──┼── https://fees.yourschool.in ──► Cloud server (Oracle Cloud, Mumbai)
Office computers ──┘          (HTTPS, padlock)         ├─ KBS School ERP
                                                        ├─ the school's database (one, central)
                                                        └─ daily backup ──► Oracle Object Storage (a second copy)
```

- There is **one central database** on the server. A student added in the office appears on the teacher's phone straight away; a fee paid online appears in the office straight away. Nothing is stored only on one phone or computer.
- Phones install the app from the browser (no Play Store needed). It opens full screen with the school logo.
- Every page is private: staff log in with email and password; parents with their mobile number and a PIN; teachers see only their own classes.

## Why this setup

We compared the usual free options against this app:

| Option | Fits this app? | Why |
| --- | --- | --- |
| **Oracle Cloud "Always Free" server** | **Yes (chosen)** | A real always-on server in India (Mumbai or Hyderabad) that runs the app exactly as it is, with its database. Free within the Always Free limits. |
| Google Cloud free server | Yes, second choice | Also free and always on, but only in US regions (slower from India), 1 GB RAM, and only 1 GB of free data transfer a month. |
| Vercel (free "Hobby" plan) | No | Only for non-commercial use, and collecting fees counts as commercial. It also cannot keep this app's database. |
| Render (free plan) | No | The free server sleeps after 15 minutes and has no permanent storage: the database would be lost. |
| Supabase / Firebase | Not now | The app would have to be rewritten around them. Supabase's free projects also pause after 7 days without use (school holidays). |

The app does not depend on Oracle: the same installer works on any Ubuntu server (Google Cloud, DigitalOcean, Hetzner, a computer in the school office). Moving later is a matter of restoring a backup.

## What it costs

| Item | Cost | Notes |
| --- | --- | --- |
| Oracle Cloud server | ₹0 within Always Free limits | Needs a credit or debit card to verify your identity. Use only "Always Free" resources (see step 2). |
| Off-site backups (Oracle Object Storage) | ₹0 up to 20 GB | Each backup is a few MB. |
| Web address (domain) | about ₹500–1,000 a year | Optional: a free address like `kbsschool.duckdns.org` also works. |
| Razorpay (online fees) | about 2% per payment | Only when you switch on online payments. No monthly fee. |
| WhatsApp Business API | Meta's per-message price | Optional. Without it, the clerk sends receipts from WhatsApp for free. |
| KBS AI with Claude | pay per use | Optional. Without a key, the built-in assistant answers common questions for free. |
| SMS login codes | per SMS, plus DLT registration | Optional. Parents can log in with a PIN instead, for free. |

**Free plans are not unlimited**, and providers change their terms. Oracle cut its free ARM allowance in 2026. To avoid surprises:

1. In Oracle Cloud, open **Billing & Cost Management → Budgets → Create Budget**, set the amount to **₹100** (or $1), and add an alert to your email at 1%. You will hear about any charge at once.
2. Create only resources marked **Always Free-eligible**. Do not change the server's shape or add storage without checking.
3. Oracle may reclaim an Always Free server that sits idle for a week. A school app in daily use is not idle, but to be safe you can upgrade the account to **Pay As You Go**. That stops reclamation while Always Free resources stay free, but anything that is not free would then be charged, so keep the budget alert.

---

## Step 1. Put the code on GitHub (15 minutes)

GitHub keeps the code safe and lets the server update itself.

1. Create a free account at **github.com** (use the school's email).
2. Click **+ → New repository**. Name: `kbs-erp`. Choose **Private**. Do not tick "Add a README". Click **Create repository**.
3. On your Mac, open **Terminal** and type (replace `YOUR-USERNAME`):

   ```bash
   cd ~/Downloads/"untitled folder"/schoolconnect
   git remote add origin https://github.com/YOUR-USERNAME/kbs-erp.git
   git push -u origin main
   ```

   When asked for a password, GitHub needs a **token**: on github.com go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**, give it access to the `kbs-erp` repository with **Contents: Read and write**, and paste it as the password.

   (The project is already a Git repository with everything committed. The database, backups and passwords are never uploaded: `.gitignore` keeps them out.)

4. On GitHub, open the **Actions** tab: the automatic checks run on every change.

## Step 2. Create the cloud server (30 minutes)

1. Sign up at **cloud.oracle.com** → **Start for free**. Choose **India West (Mumbai)** or **India South (Hyderabad)** as your **home region**. This cannot be changed later. The card is only used to verify you.
2. In the Oracle console, open the menu **☰ → Compute → Instances → Create instance**.
   - **Name:** `kbs-erp`
   - **Image:** click **Change image → Ubuntu → Canonical Ubuntu 24.04**.
   - **Shape:** click **Change shape**. Choose **Ampere → VM.Standard.A1.Flex** with **1 OCPU and 6 GB memory** (Always Free). If Ampere is not available in your region, choose **Specialty and previous generation → VM.Standard.E2.1.Micro** (Always Free). Make sure the label **Always Free-eligible** is shown.
   - **Networking:** keep the defaults (a new virtual cloud network and public subnet) and **Assign a public IPv4 address: Yes**.
   - **Add SSH keys:** choose **Generate a key pair for me** and click **Save private key**. Keep this file safe: it is the key to your server.
   - Click **Create**. When the instance shows **Running**, copy its **Public IP address** (for example `140.238.12.34`).
3. Open the web ports. On the instance page, click the **Subnet** link → the **Default Security List** → **Add Ingress Rules**:
   - Source CIDR `0.0.0.0/0`, IP Protocol **TCP**, Destination Port Range `80` → **Add Ingress Rules**
   - Repeat for port `443`.

## Step 3. Choose the web address (10 minutes)

**Option A: your own domain (recommended).** Buy one (for example `kbsschool.in`) from any registrar (GoDaddy, Hostinger, BigRock, Cloudflare). In its **DNS settings**, add an **A record**: name `fees`, value = the server's public IP. Your address is then `fees.kbsschool.in`.

**Option B: free address.** Go to **duckdns.org**, sign in, create a subdomain such as `kbsschool`, and set its IP to the server's public IP. Your address is `kbsschool.duckdns.org`.

DNS changes take from a few minutes to an hour to work.

## Step 4. Install the app on the server (15 minutes)

1. In the Oracle console, click the **Cloud Shell** icon (`>_`, top right). A terminal opens in your browser. Upload the private key file you saved (gear icon → **Upload**), then connect:

   ```bash
   chmod 600 ssh-key-*.key
   ssh -i ssh-key-*.key ubuntu@YOUR-SERVER-IP
   ```

2. Give the server read access to your private GitHub repository:

   ```bash
   ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 && cat ~/.ssh/id_ed25519.pub
   ```

   Copy the line it prints. On GitHub, open the `kbs-erp` repository → **Settings → Deploy keys → Add deploy key**, paste it, title it `server`, and save (leave "Allow write access" unticked).

3. Download the app and run the installer:

   ```bash
   git clone git@github.com:YOUR-USERNAME/kbs-erp.git
   cd kbs-erp
   sudo bash deploy/install.sh
   ```

   It asks for your web address (from step 3) and the first admin's name, email and password. It then installs everything, gets the HTTPS certificate and starts the app. When it says **Done**, open `https://YOUR-ADDRESS/admin` and log in.

## Step 5. Set up the school (in the app)

1. **Change your password**: menu → *Change password*.
2. **Staff Records** (School): add the clerks and teachers. Teachers and clerks get their own email and password; drivers, attendants and peons can be added as records without app access.
3. **Fee Structure** (Fees): add the fee types and each class's fees for the session.
4. **Add Student** (Students): add each student with the parent's mobile number. The fee account is created automatically. New sections (B, C…) are created when a student is added to them.
5. **Subjects & Teachers** (Academics): give each teacher their classes and mark the class teachers.
6. **Timetable** (Academics): click each period to set the subject and teacher.
7. **System Health** (System): every line should be green, except the optional services you have not set up.

## Step 6. Install the app on Android phones (no Play Store)

On each phone, open **Chrome** and go to the school's address:

- **Office staff and teachers:** `https://YOUR-ADDRESS/admin`
- **Parents:** `https://YOUR-ADDRESS`

Chrome shows **Install app** (or tap **⋮ → Install app / Add to Home screen**). The KBS School icon appears on the home screen and opens full screen like any app. Updates arrive automatically; nothing needs reinstalling.

## Step 7. Give parents access

1. Open **Parent App Access** (Students). Each family (the mobile number on their children's records) is listed.
2. Click **Give access code**. Send it with **Send on WhatsApp**, or **Print slip** and hand it over. Codes work once and expire after 14 days.
3. The parent opens the app → **First time? Use your access code** → enters their mobile number and the code → chooses a 6-digit PIN. From then on they log in with their number and PIN.
4. Forgotten PIN: give a new code. Lost phone or a family that has left: **Switch off** (admins).

## Step 8. Off-site backups (20 minutes, strongly recommended)

The server already keeps a backup of every day for 14 days. This step also copies each one to separate storage, so the data survives even if the server is lost.

1. Oracle console → **☰ → Storage → Buckets → Create Bucket**: name `kbs-backups`, **Standard**, keep "Encrypt using Oracle managed keys". Click **Create**.
2. Your **namespace** is shown on the bucket page (a short code such as `axk3abcd1234`).
3. Top right → your profile → **My profile → Customer secret keys → Generate secret key**, name it `kbs-backups`. Copy the **secret** at once (shown only once) and the **Access key**.
4. On the server (Cloud Shell → `ssh` as in step 4), run `nano ~/kbs-erp/.env` and add:

   ```
   BACKUP_S3_ENDPOINT=https://YOUR-NAMESPACE.compat.objectstorage.ap-mumbai-1.oraclecloud.com
   BACKUP_S3_REGION=ap-mumbai-1
   BACKUP_S3_BUCKET=kbs-backups
   BACKUP_S3_ACCESS_KEY=the access key
   BACKUP_S3_SECRET_KEY=the secret
   ```

   (Use `ap-hyderabad-1` instead of `ap-mumbai-1` if your region is Hyderabad.) Press Ctrl+O, Enter, Ctrl+X, then run `cd ~/kbs-erp && sudo docker compose up -d`.
5. In the app: **System Backup → Back up now**. **System Health** shows the last off-site copy.

Also download a backup to a school computer once a week (**System Backup → Download**).

### If something goes wrong: restoring

1. Get the backup file: from **System Backup**, or from the `kbs-backups` bucket in the Oracle console (… → Download).
2. On the server (or a new server set up with steps 2–4), copy it in and restart:

   ```bash
   cd ~/kbs-erp
   sudo docker compose stop app
   sudo docker run --rm -v kbs-erp_kbs-data:/data -v "$PWD":/backup alpine cp /backup/BACKUP-FILE-NAME.db /data/schoolconnect.db
   sudo docker compose start app
   ```

   (Upload the backup file to the server first, for example with the Cloud Shell upload button and `scp`.)

## Step 9. Automatic updates (optional, 10 minutes)

When the app's code changes on GitHub, the server can update itself:

1. On the server (Cloud Shell → `ssh` as in step 4), create a key for GitHub to log in with:

   ```bash
   ssh-keygen -t ed25519 -N "" -f ~/.ssh/github_deploy && cat ~/.ssh/github_deploy.pub >> ~/.ssh/authorized_keys && cat ~/.ssh/github_deploy
   ```

2. On GitHub → `kbs-erp` → **Settings → Secrets and variables → Actions → New repository secret**, add:
   - `SERVER_HOST`: the server's public IP
   - `SERVER_USER`: `ubuntu`
   - `SERVER_SSH_KEY`: the whole private key printed above (from `-----BEGIN` to `-----END…-----`)

From then on, every change pushed to `main` is tested, and if the tests pass the live server updates within a few minutes (**Actions** tab shows progress).

## Optional services

All of these are set in `~/kbs-erp/.env` on the server, followed by `sudo docker compose up -d`. The README has the details.

| Service | Settings |
| --- | --- |
| Online fee payments (Razorpay) | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`; webhook URL `https://YOUR-ADDRESS/api/webhooks/payments` |
| Automatic WhatsApp receipts | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE_NAME` |
| KBS AI with Claude | `ANTHROPIC_API_KEY` |
| SMS login codes for parents | an SMS provider connected in `server/sms.js`, then `SMS_PROVIDER` |

## Security checklist

- [x] HTTPS everywhere (Caddy gets and renews the certificate), secure cookies, HSTS.
- [x] Every page and record needs a login; permissions are checked on the server for every request.
- [x] Teachers reach only their own classes and no fee records; parents only their own children.
- [x] Passwords and PINs are stored as salted hashes; repeated wrong attempts are locked out.
- [x] Secrets (`.env`) stay on the server; they are never in the code, on GitHub, or sent to browsers.
- [x] The database is never directly reachable from the internet.
- [x] Daily backups, kept 14 days, plus off-site copies (step 8).
- [ ] Change the first admin's password after the first login.
- [ ] Set up the budget alert (see *What it costs*).
- [ ] Download a backup to a school computer every week.

## Later: an Android app in the Play Store

The installed web app is enough for most schools. If you later want a listing in the Play Store, the same app can be packaged as an Android app (a "Trusted Web Activity", for example with pwabuilder.com) without changing the code. It needs a Google Play developer account (one-time fee).
