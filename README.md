# n8n-nodes-ahel

An n8n community node for [Ahel](https://ahel.ai): pay-per-call data tasks from one prepaid balance. Find and verify work emails, check European companies in their official registers, or run any task in Ahel's catalog. Every output item carries the exact cost of its run.

## Install

In n8n: **Settings → Community nodes → Install**, enter `n8n-nodes-ahel`, and confirm.

Self-hosted from the command line: `npm install n8n-nodes-ahel` in your n8n custom nodes folder (`~/.n8n/nodes`), then restart n8n.

## Credentials

1. Sign in at [ahel.ai](https://ahel.ai). New workspaces start with **$1 free**, no card needed.
2. Open [ahel.ai/app/team](https://ahel.ai/app/team?tab=keys), tab **API keys**, and create a key (`ahel_tk_...`). A key can carry a daily spending cap.
3. In n8n, create an **Ahel API** credential and paste the key. The node sends it in the `X-Ahel-Token` header. Leave **Base URL** as `https://ahel.ai`.

The credential test reads your balance (`GET /api/platform/v2/balance`). It costs nothing.

## Operations

| Operation | What it runs | Inputs |
|---|---|---|
| **Find Work Email** | `people.email.find` | Full name, company domain (a website URL works too), **Verify** (on by default: checks in the same run that the address accepts mail) |
| **Check a European Company** | `companies.register.search` | Company name, two-letter country code (EE, DE, FR, GB, ...) |
| **Run Task** | Any catalog task | Task (search the catalog in the dropdown, or type an id), arguments as JSON or key/value pairs, **Quote Only** |
| **Run a List** | One task per incoming item | Task, **Arguments From Fields** (`full_name=Name, domain` sends the field `Name` as `full_name` and `domain` as is; empty sends every field), extra arguments for every row, parallel runs (1 to 5) |

Options on every operation:

- **Max Cost per Run (USD)**: Ahel only tries providers that fit under it and refuses a run quoted above it, holding and charging nothing.
- **Tag**: shows the run under that tag in Activity on ahel.ai, for example one tag per client. It is never sent to a provider.
- **Max Results**: how many answer rows a run may return (default 1).
- **Timeout (Seconds)**: how long a run may take (5 to 180).

## Output

One item per run. The first answer row's fields are on the item. When a run returns several rows, all of them are under `results`. Every item also has:

| Field | Meaning |
|---|---|
| `cost_usd` | What this run was charged, exactly as Ahel's ledger records it (provider cost plus Ahel's 10% margin). A miss is usually free. While a run is still going, this is the amount held for it. |
| `charge_status` | `charged`, `released` or `not_charged` once settled; `pending` while running |
| `provider` | The provider that answered |
| `run_id` | Ahel's run id. Look it up in Activity on ahel.ai. |
| `found` | Whether the run returned any rows |
| `verification` | Find Work Email with Verify: `valid`, `invalid` or `risky` |
| `task`, `state` | The capability that ran and the run's final state |

**Quote Only** runs nothing. Its item has `quote_only: true`, `cost_usd` (the most the run can reserve; only the exact cost is ever charged), the providers in the order they would be tried (`attempt_plan`), `available_usd` and `quote_id`.

**Run a List** keeps the input item's fields next to the answer (turn off **Keep Input Fields** to drop them), so a Google Sheets `row_number` survives for the write-back. A row that is refused or fails keeps its place with `error` and `error_code`, so the rows already paid for are never lost. The node fails only when every row failed, or always continues if you set the node's **On Error** to continue.

## Errors

When Ahel refuses a call, the node error carries Ahel's own message and code. Common ones:

| Code | What to do |
|---|---|
| `insufficient_balance` | Top up at ahel.ai/app/team?tab=billing |
| `max_cost_exceeded` | The run is quoted above your Max Cost; raise it or leave it at 0 |
| `spend_cap_exceeded` | The API key's daily cap is reached |
| `invalid_arguments` | An argument is missing or has the wrong form; the message names it |
| `invalid_token`, `token_revoked` | Create a new key and update the credential |

Ahel allows 30 requests a minute for the whole workspace. The node spaces its requests to stay under that and, on a `429 rate_limited`, waits the `Retry-After` seconds and tries again. Each run carries an idempotency key, so a retried request never runs or charges twice.

## Example workflows

Import from `examples/` (in n8n: **Workflows → Import from File**):

- [`enrich-google-sheet-with-work-emails.json`](examples/enrich-google-sheet-with-work-emails.json): Google Sheet rows with `full_name` and `domain` → Run a List on `people.email.find` with `verify = true`, at most $0.05 a row → email, verdict, provider and cost written back to each row.
- [`check-new-crm-companies-in-register.json`](examples/check-new-crm-companies-in-register.json): a CRM's "company created" webhook → Check a European Company → exact matches get the registry code and status, everything else goes to review with up to three candidates.

## Prices

Prices come from Ahel at run time; the node never prices anything itself. As checked on 3 Nov 2026: a work email found from a name and domain from $0.0053174, the address check $0.0011, a register lookup $0.004. Inspect any task on [ahel.ai](https://ahel.ai) or use **Quote Only** to see its price first.

Work emails are personal data. Use them for relevant B2B outreach, honour opt-outs and follow the rules where you sell, such as the GDPR in the EU.

## Development

```sh
npm install
npm run build   # n8n-node build
npm run lint    # n8n's community node lint rules
npm test        # unit tests: request building and output mapping against a fake fetch
npm run dev     # a local n8n with the node loaded (needs Docker or Podman)
```

The package has no runtime dependencies. HTTP goes through n8n's own request helper with the credential.

Tested on 3 Nov 2026 against a self-hosted n8n 2.46.4 (Docker, the built package mounted at `~/.n8n/custom/n8n-nodes-ahel`): credential test, the catalog dropdown, and all four operations ran against ahel.ai and returned rows with `cost_usd`, `provider` and `run_id`. To repeat it:

```sh
npm run build
mkdir -p /tmp/n8n/custom/n8n-nodes-ahel && cp -R package.json dist /tmp/n8n/custom/n8n-nodes-ahel/
docker run -d --name n8n -p 5678:5678 -e N8N_CUSTOM_EXTENSIONS=/home/node/.n8n/custom \
  -e N8N_SECURE_COOKIE=false -v /tmp/n8n:/home/node/.n8n docker.n8n.io/n8nio/n8n:latest
```

Then open http://localhost:5678, add an **Ahel API** credential and search for "Ahel" in the node panel.

## Links

- [Ahel in n8n and Make](https://ahel.ai/guides/ahel-in-n8n-and-make): the same calls from an HTTP Request node or the MCP Client Tool node
- [n8n community nodes](https://docs.n8n.io/integrations/community-nodes/)
- Support: support@ahel.ai

## Licence

[MIT](LICENSE)
