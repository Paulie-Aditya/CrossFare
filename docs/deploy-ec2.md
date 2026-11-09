# Deploy on AWS EC2

One small instance runs the API, with Caddy in front for HTTPS. It can serve the UI too, or the UI can run on [Vercel](deploy-vercel.md), which forwards API requests here. These steps are written for Ubuntu 24.04. The live site runs this way, using the nginx path in step 6 on an instance shared with another service. The Caddy path hasn't been run on a real instance.

**Using an instance you already have?** Check three things first:

```sh
cat /etc/os-release                  # these commands assume Ubuntu or Debian
which node && node --version         # the service runs /usr/bin/node, which must be 22.18 or newer
sudo ss -ltnp | grep -E ':(80|443) ' # Caddy needs these ports free
free -h                              # the install peaks near 400 MB and the API uses about 300 MB
```

**Don't attach an Elastic IP to a shared instance without checking.** It changes the public address, which breaks any DNS already pointing at the old one.

Also check that nothing already uses port 8787, and don't upgrade a system Node.js that another app relies on. If nginx already holds ports 80 and 443, skip Caddy and follow "If nginx is already running" in step 6.

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
# With the UI on Vercel, this installs only the API and uses far less memory:
pnpm --filter "@crossfare/api..." install --frozen-lockfile
# Otherwise, install everything and build the UI:
# pnpm install --frozen-lockfile && pnpm --filter @crossfare/web build
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

The API reads receipts, deposits and unlisted tokens on all 21 chains Uniswap trades on, through each chain's public RPC. Public RPCs rate-limit, so for chains you expect traffic on, add a provider's URL as `RPC_URL_<chainId>`, for example `RPC_URL_42161=` for Arbitrum. `BASE_RPC_URL` and `ETHEREUM_RPC_URL` still work.

To charge a fee on Uniswap swaps, add `UNISWAP_FEE_RECIPIENT` (the EVM address that receives it) and, for callers without a fee on their VIP key, `UNISWAP_FEE_BPS`. Set a caller's own fee on its VIP key, below.

To quote NEAR Intents and THORChain directly and keep their affiliate fees, add `NEAR_INTENTS_FEE_RECIPIENT` and `NEAR_INTENTS_FEE_BPS`, and `THORCHAIN_AFFILIATE` and `THORCHAIN_AFFILIATE_BPS`. Leave them out and SwapKit routes both, as before. `.env.example` and the README's "Direct venues" paragraph explain the values.

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

**If nginx is already running,** don't install or start Caddy. Add a site instead, which leaves the existing ones untouched:

```sh
sudo cp deploy/crossfare.nginx.conf /etc/nginx/sites-available/crossfare
sudo sed -i 's/crossfare.example.com/<your name>/' /etc/nginx/sites-available/crossfare
sudo ln -s /etc/nginx/sites-available/crossfare /etc/nginx/sites-enabled/crossfare
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx   # if certbot isn't there already
sudo certbot --nginx -d <your name>
```

`nginx -t` stops a bad config from reaching the running sites.

Check `https://<your name>/healthz`. If the UI is on Vercel, put the same name in `apps/web/vercel.json`. Otherwise, open `https://<your name>` to see the UI. Then point the agent at it by setting `CROSSFARE_API_URL` in your local `.env`.

## Update to a new version

```sh
cd /opt/crossfare
sudo -u crossfare git pull
sudo -u crossfare pnpm --filter "@crossfare/api..." install --frozen-lockfile
# With the UI on this instance, install everything and run the web build instead.
sudo systemctl restart crossfare
```

## VIP keys

Keys live in the service's database, so issue them with the server's own settings. From the instance:

```sh
cd /opt/crossfare/apps/api
sudo -u crossfare node --env-file=/etc/crossfare/crossfare.env src/vip-cli.ts create my-service --rate 120 --fee-bps 100
sudo -u crossfare node --env-file=/etc/crossfare/crossfare.env src/vip-cli.ts fee vk_… 50
sudo -u crossfare node --env-file=/etc/crossfare/crossfare.env src/vip-cli.ts list
sudo -u crossfare node --env-file=/etc/crossfare/crossfare.env src/vip-cli.ts usage --month 2026-11
sudo -u crossfare node --env-file=/etc/crossfare/crossfare.env src/vip-cli.ts revoke vk_…
```

`create` prints the key once. Changes apply on the next request, with no restart. A caller on this same instance can call `http://127.0.0.1:8787` directly. See [VIP keys](vip.md) for how callers sign requests.
