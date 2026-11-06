# Deploy the web app to Vercel

The web app is static. The API stays on EC2 ([steps](deploy-ec2.md)), and Vercel forwards API requests to it, so the browser only ever talks to one address and CORS never comes up. All keys stay on EC2. Vercel needs no environment variables.

## 1. Create the project

1. In Vercel, import this repository.
2. Set **Root Directory** to `apps/web`.
3. Leave the rest as detected. `apps/web/vercel.json` sets the framework to Vite and the output to `dist`.
4. Deploy.

The page loads straight away, but it can't show tokens or quotes until step 2 is done.

## 2. Point it at your API

In `apps/web/vercel.json`, set each destination to your API's domain, then commit and push. Vercel redeploys on its own. It currently points at a temporary sslip.io name for the EC2 instance.

The API must answer over HTTPS at that domain, which the Caddy step in the EC2 guide sets up.

**No domain yet?** A service such as [sslip.io](https://sslip.io) gives your instance's IP a name, like `203-0-113-10.sslip.io`, which Caddy can get a certificate for. This hasn't been tried with Crossfare.

## 3. Check it

Open the Vercel URL, then:

1. **Tokens:** the token picker should list thousands of tokens.
2. **Prices:** typing an amount should show a price.
3. **Quotes:** Get quotes should return routes with Arkiv links. A quote can take several seconds, so this is also the check that Vercel's forwarding waits long enough.

## Worth knowing

- **Rate limits:** the demo's per-visitor limit reads `x-forwarded-for`. This hasn't been checked behind Vercel, and it probably sees Vercel's address rather than the visitor's, so the EC2 guide raises it. The daily limit applies either way.
- **The EC2 instance** still serves the web app too if you build it there, which is harmless. You can skip that build step.
