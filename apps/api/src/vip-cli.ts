import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createStore, type Store, type VipScope } from "./store.ts";
import { generateVipKey, hashVipKey, isValidVipLabel } from "./vip.ts";

/**
 * Issues and manages VIP keys in the API's database. Run it next to the server:
 *   node --env-file=<env> src/vip-cli.ts create <label> [--scopes quote,swap] [--rate 60] [--quota N] [--fee-bps N]
 *   node --env-file=<env> src/vip-cli.ts list
 *   node --env-file=<env> src/vip-cli.ts fee <key-id> <bps|default>
 *   node --env-file=<env> src/vip-cli.ts revoke <key-id>
 *   node --env-file=<env> src/vip-cli.ts usage [--month YYYY-MM]
 */

const SCOPES: readonly VipScope[] = ["quote", "swap"];
const DEFAULT_RATE_PER_MINUTE = 60;
/** Uniswap refuses an integrator fee above 500 bips. */
const MAX_FEE_BPS = 500;
const FEE_HELP = `a fee is a whole number of basis points from 0 to ${MAX_FEE_BPS}`;

interface CliDeps {
  store: Store;
  now?: () => Date;
  print?: (line: string) => void;
  newId?: () => string;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

/** A whole number of at least 1, or null when the option is absent. */
function count(value: string | undefined): number | null | "invalid" {
  if (value === undefined) return null;
  return /^[1-9][0-9]*$/.test(value) ? Number(value) : "invalid";
}

/** Basis points within Uniswap's cap, or null when the option is absent. */
function fee(value: string | undefined): number | null | "invalid" {
  if (value === undefined) return null;
  return /^(0|[1-9][0-9]*)$/.test(value) && Number(value) <= MAX_FEE_BPS ? Number(value) : "invalid";
}

const monthStart = (year: number, month: number) => new Date(Date.UTC(year, month, 1)).toISOString();

export function runVipCommand(args: string[], deps: CliDeps): number {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const print = deps.print ?? ((line: string) => console.log(line));
  const newId = deps.newId ?? (() => `vk_${randomUUID().replaceAll("-", "").slice(0, 12)}`);
  const fail = (message: string) => {
    print(message);
    return 1;
  };
  const [command, first] = args;

  switch (command) {
    case "create": {
      if (!first || first.startsWith("--") || !isValidVipLabel(first)) {
        return fail("A label is required: lower-case letters, digits and hyphens, up to 32. It is public on Arkiv.");
      }
      const scopes = (option(args, "scopes") ?? SCOPES.join(",")).split(",") as VipScope[];
      if (scopes.length === 0 || scopes.some((scope) => !SCOPES.includes(scope))) {
        return fail(`--scopes takes a comma-separated list of: ${SCOPES.join(", ")}`);
      }
      const rate = count(option(args, "rate"));
      if (rate === "invalid") return fail("--rate must be a whole number of requests a minute, at least 1");
      const quota = count(option(args, "quota"));
      if (quota === "invalid") return fail("--quota must be a whole number of calls a month, at least 1");
      const feeBps = fee(option(args, "fee-bps"));
      if (feeBps === "invalid") return fail(`--fee-bps: ${FEE_HELP}`);

      const key = generateVipKey();
      const id = newId();
      store.saveVipKey({
        id,
        label: first,
        keyHash: hashVipKey(key),
        scopes: [...new Set(scopes)],
        ratePerMinute: rate ?? DEFAULT_RATE_PER_MINUTE,
        monthlyQuota: quota,
        feeBps,
        createdAt: now().toISOString(),
      });
      const feeText = feeBps === null ? "the default fee" : `fee ${feeBps} bps`;
      print(`Created ${id} for "${first}" (scopes ${scopes.join(",")}, ${rate ?? DEFAULT_RATE_PER_MINUTE}/min, quota ${quota ?? "none"}, ${feeText}).`);
      print(`Key, shown only now: ${key}`);
      return 0;
    }

    case "list": {
      const since = monthStart(now().getUTCFullYear(), now().getUTCMonth());
      print("id,label,scopes,rate_per_minute,monthly_quota,fee_bps,calls_this_month,created_at,revoked_at");
      for (const key of store.listVipKeys()) {
        print(
          [key.id, key.label, key.scopes.join(" "), key.ratePerMinute ?? "", key.monthlyQuota ?? "", key.feeBps ?? "default", store.countVipUsage(key.id, since), key.createdAt, key.revokedAt ?? ""].join(","),
        );
      }
      return 0;
    }

    case "fee": {
      const value = args[2];
      if (!first || value === undefined) return fail("Give the key ID, from `list`, and a fee in basis points or `default`.");
      const feeBps = value === "default" ? null : fee(value);
      if (feeBps === "invalid") return fail(`Not a fee: ${FEE_HELP}, or \`default\`.`);
      if (!store.setVipKeyFee(first, feeBps)) return fail(`No key with ID ${first}.`);
      print(`${first} now pays ${feeBps === null ? "the default fee" : `${feeBps} bps`} on new quotes.`);
      return 0;
    }

    case "revoke": {
      if (!first) return fail("Give the key ID to revoke, from `list`.");
      if (!store.revokeVipKey(first, now().toISOString())) return fail(`No key with ID ${first}.`);
      print(`Revoked ${first}. It stops working on its next request.`);
      return 0;
    }

    case "usage": {
      const month = option(args, "month");
      let year = now().getUTCFullYear();
      let index = now().getUTCMonth();
      if (month) {
        const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
        if (!match) return fail("--month takes YYYY-MM");
        year = Number(match[1]);
        index = Number(match[2]) - 1;
      }
      print("label,key_id,endpoint,calls");
      for (const line of store.vipUsageSummary(monthStart(year, index), monthStart(year, index + 1))) {
        print([line.label, line.keyId, line.endpoint, line.calls].join(","));
      }
      return 0;
    }

    default:
      return fail("Commands: create <label> [--scopes quote,swap] [--rate N] [--quota N] [--fee-bps N] | list | fee <id> <bps|default> | revoke <id> | usage [--month YYYY-MM]");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runVipCommand(process.argv.slice(2), { store: createStore(process.env.DATABASE_PATH || "crossfare.db") });
}
