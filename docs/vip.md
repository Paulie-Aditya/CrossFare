# VIP keys

A VIP key lets a service call Crossfare without paying x402 for each request. It is meant for integrators, such as a wallet's backend, that make many calls and settle usage some other way. Everyone else keeps paying per call, exactly as before.

This covers FR-29 to FR-32 in the [requirements](prd.md). The x402-paid pass for agents (FR-33) isn't built yet. A key doesn't change fees: any caller can add its own fee to its swaps, as [fees](fees.md) explains.

## What a key changes

| | x402 caller | VIP caller |
| --- | --- | --- |
| `POST /v1/quote` | Pays 0.01 USDC on Hedera | Free, counted against the key |
| `POST /v1/swap` | Free now; pays if `SWAP_PRICE_USDC` is set | Free, counted against the key when the swap is priced |
| Payer on Arkiv | The Hedera account that paid | `vip:<label>`, never the key |
| Response | Includes `payment` | No `payment` field |

Only calls that succeed are counted, just as only successful x402 calls are charged. A `409`, `422` or `502` costs nothing.

## Signing a request

Send three headers with every request:

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer cf_live_…`, the key |
| `X-Crossfare-Timestamp` | The current Unix time in seconds |
| `X-Crossfare-Sign` | Hex HMAC-SHA256 of the message below |

The message is the timestamp, method, path and raw body, joined by newlines:

```
<timestamp>\n<METHOD>\n<path>\n<raw body>
```

The HMAC secret is the hex SHA-256 of the key, as text. Crossfare stores only that hash, so someone with a copy of the database still can't pass the `Authorization` check, and a captured request stops working after 60 seconds.

Send exactly the bytes you signed. Serialise the body once, sign that string and send that string.

### Python

```python
import hashlib, hmac, json, os, time
import requests

KEY = os.environ["CROSSFARE_VIP_KEY"]
SECRET = hashlib.sha256(KEY.encode()).hexdigest().encode()

def crossfare_post(base_url: str, path: str, payload: dict) -> requests.Response:
    body = json.dumps(payload, separators=(",", ":"))
    timestamp = str(int(time.time()))
    message = f"{timestamp}\nPOST\n{path}\n{body}".encode()
    headers = {
        "Authorization": f"Bearer {KEY}",
        "X-Crossfare-Timestamp": timestamp,
        "X-Crossfare-Sign": hmac.new(SECRET, message, hashlib.sha256).hexdigest(),
        "Content-Type": "application/json",
    }
    return requests.post(base_url + path, data=body, headers=headers, timeout=60)
```

### TypeScript

```ts
import { createHash, createHmac } from "node:crypto";

const key = process.env.CROSSFARE_VIP_KEY!;
const secret = createHash("sha256").update(key).digest("hex");

export async function crossfarePost(baseUrl: string, path: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = createHmac("sha256", secret).update(`${timestamp}\nPOST\n${path}\n${body}`).digest("hex");
  return fetch(baseUrl + path, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "x-crossfare-timestamp": timestamp, "x-crossfare-sign": sign, "content-type": "application/json" },
    body,
  });
}
```

## Errors

| Status | `error` | Meaning |
| --- | --- | --- |
| `402` | `invalid_vip_key` | Unknown or revoked key |
| `402` | `vip_signature_missing` | No `X-Crossfare-Sign` or `X-Crossfare-Timestamp` |
| `402` | `vip_timestamp_out_of_window` | The timestamp is more than 60 seconds from the server's clock |
| `402` | `vip_signature_invalid` | The signature doesn't match the method, path or body |
| `403` | `vip_scope_missing` | The key can't call this endpoint |
| `429` | `vip_rate_limited` | Over the key's requests per minute |
| `429` | `vip_quota_exceeded` | Over the key's metered calls this month (UTC) |

A `402` from a bad credential is the normal x402 answer with the reason added, so a caller that can also pay may fall back to paying. A `429` or `403` asks no venue and writes nothing.

## Managing keys

Keys live in the API's SQLite database, next to quotes and swaps. The command runs beside the server and changes take effect on the next request, with no restart.

| Command | Does |
| --- | --- |
| `create <label> [--scopes quote,swap] [--rate N] [--quota N]` | Issues a key and prints it once. Defaults: both scopes, 60 requests a minute, no monthly quota |
| `list` | Every key with its limits and this month's calls. Never prints a key or hash |
| `revoke <key-id>` | Stops a key at once |
| `usage [--month YYYY-MM]` | Metered calls per key and endpoint for a month, as CSV for billing. Defaults to this month |
| `earnings [--month YYYY-MM]` | Callers' fees on completed SwapKit swaps, which SwapKit paid to the operator, totalled per payer and asset as CSV for payouts. See [fees](fees.md) |

The label is public: it's the payer on every Arkiv record the key creates. Use lower-case letters, digits and hyphens, up to 32 characters.

Locally, from `apps/api`:

```sh
pnpm vip create my-service --rate 120
```

On the EC2 server, see [the deployment guide](deploy-ec2.md#vip-keys).

Hand the key over through a channel you trust and store it as a secret on the caller's side. If it leaks, revoke it and issue a new one.
