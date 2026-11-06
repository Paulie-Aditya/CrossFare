# Deploy on AWS EC2

One small instance runs the API, with Caddy in front for HTTPS. It can serve the UI too, or the UI can run on [Vercel](deploy-vercel.md), which forwards API requests here. These steps are written for Ubuntu 24.04 and haven't been run on a real instance yet. A local rehearsal with only the variables below and no web build did start, load the token list and pay for a testnet quote.

**Using an instance you already have?** Check three things first:

```sh
cat /etc/os-release                  # these commands assume Ubuntu or Debian
which node && node --version         # the service runs /usr/bin/node, which must be 22.18 or newer
sudo ss -ltnp | grep -E ':(80|443) ' # Caddy needs these ports free
```

If something already holds ports 80 and 443, such as nginx, proxy a new name to `127.0.0.1:8787` from it instead of installing Caddy.

## 1. Create the instance

- **Type:** `t3.small`, because building the web app needs more memory than a `t3.micro` has.
- **Disk:** 16 GB.
- **Security group:** allow ports 80 and 443 from anywhere, and port 22 from your own IP only. Don't open port 8787.
- **Elastic IP:** attach one, so the URL survives a restart.

If you have a domain, point it at the Elastic IP. If not, use `<elastic-ip>.sslip.io`, which resolves to that IP with no setup.

## 2. Install Node.js, pnpm and Caddy

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs caddy
sudo npm install -g pnpm@10
```

If `apt` can't find Caddy, follow [Caddy's install steps](https://caddyserver.com/docs/install#debian-ubuntu-raspbian).

## 3. Get the code and build it

```sh
sudo useradd --system --home /opt/crossfare --shell /usr/sbin/nologin crossfare
sudo git clone <this repo's URL> /opt/crossfare
sudo chown -R "$USER" /opt/crossfare
cd /opt/crossfare
pnpm install --frozen-lockfile
pnpm --filter @crossfare/web build   # skip this if the UI is on Vercel
sudo chown -R crossfare:crossfare /opt/crossfare
```

## 4. Add the secrets

Create `/etc/crossfare/crossfare.env`, readable only by root and the service:

```sh
sudo mkdir -p /etc/crossfare
sudo install -m 640 -o root -g crossfare /dev/null /etc/crossfare/crossfare.env
sudo nano /etc/crossfare/crossfare.env
```

Copy these values from your local `.env`, and add the database path:

```sh
UNISWAP_API_KEY=
SWAPKIT_API_KEY=
ARKIV_PRIVATE_KEY=
ARKIV_ACCESS_KEY=
HEDERA_OPERATOR_ID=
HEDERA_OPERATOR_KEY=
HEDERA_PAY_TO_ACCOUNT=
HEDERA_HCS_TOPIC_ID=
AGENT_HEDERA_ACCOUNT=
AGENT_HEDERA_KEY=
DATABASE_PATH=/var/lib/crossfare/crossfare.db
DEMO_LIMIT_PER_IP_HOUR=200
DEMO_LIMIT_PER_DAY=500
```

The higher per-IP limit is for the UI on Vercel. Behind Vercel and Caddy the API probably sees Vercel's address rather than each visitor's, so visitors could share one limit. The daily limit is what caps spending.

**Never put `AGENT_EVM_PRIVATE_KEY` on the server.** It signs swaps with real money, and only the agent needs it. The server uses `AGENT_HEDERA_*` to pay visitors' testnet fees, so that key must not also control real funds.

## 5. Start the service

```sh
sudo cp deploy/crossfare.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now crossfare
curl http://127.0.0.1:8787/healthz
```

The check should answer `{"ok":true}`. If it doesn't, read the logs with `journalctl -u crossfare -n 50`.

## 6. Turn on HTTPS

```sh
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile   # replace crossfare.example.com with your name
sudo systemctl reload caddy
```

Check `https://<your name>/healthz`. If the UI is on Vercel, put the same name in `apps/web/vercel.json`. Otherwise, open `https://<your name>` to see the UI. Then point the agent at it by setting `CROSSFARE_API_URL` in your local `.env`.

## Update to a new version

```sh
cd /opt/crossfare
sudo -u crossfare git pull
sudo -u crossfare pnpm install --frozen-lockfile
sudo -u crossfare pnpm --filter @crossfare/web build   # skip this if the UI is on Vercel
sudo systemctl restart crossfare
```
