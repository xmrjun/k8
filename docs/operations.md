# K8 read-only API operations

## Runtime requirements

Keep Google Chrome open with the signed-in k81128 and IM Sports tabs available. Chrome must have **View > Developer > Allow JavaScript from Apple Events** enabled, and the process running the API must be allowed to control Google Chrome in **System Settings > Privacy & Security > Automation**.

The public data path is:

```text
https://k8.nbmrjun.top
  -> Cloudflare Tunnel
  -> http://127.0.0.1:8788
  -> signed-in Chrome tabs through Apple Events
```

Only the bearer-token-protected HTTP API is published. Chrome automation and CDP ports must never be added to the tunnel.

## Start

Start the API from a normal macOS Terminal session so it uses the Terminal-to-Chrome Automation permission:

```bash
cd /Users/apple/Documents/Codex/2026-07-19/chrome-cookie-local-storage/k8/.worktrees/browser-bridge
set -a
source .env.local
set +a
npm start
```

In another Terminal window, start the existing tunnel:

```bash
/opt/homebrew/bin/cloudflared tunnel \
  --config /Users/apple/.cloudflared/sporttery.yml run
```

Both processes and Chrome must remain running. Mac sleep, Chrome exit, session expiry, or closing either process makes the public API unavailable.

## Safe verification

Validate the tunnel configuration without showing any secret:

```bash
/opt/homebrew/bin/cloudflared tunnel \
  --config /Users/apple/.cloudflared/sporttery.yml ingress validate
```

An unauthenticated public request must return `401`:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  'https://k8.nbmrjun.top/api/sports?scope=live'
```

For an authenticated check, read `API_TOKEN` from `.env.local` and print only the HTTP status and sanitized shape/count fields. Never paste the token into shell history, logs, documentation, or chat.

## Existing tunnel route

The existing `odds.nbmrjun.top -> http://localhost:8787` ingress rule is intentionally unchanged. If its local service is stopped, Cloudflare returns an origin error such as `502`; start the service on port `8787` before treating that hostname as healthy.

## Rollback

The pre-deployment configuration backup is:

```text
/Users/apple/.cloudflared/sporttery.yml.backup-20260719-1634
```

To roll back the Mac ingress configuration:

1. Stop the running `cloudflared tunnel ... run` process.
2. Copy the backup over `/Users/apple/.cloudflared/sporttery.yml`.
3. Run `cloudflared tunnel --config /Users/apple/.cloudflared/sporttery.yml ingress validate`.
4. Restart the tunnel and verify `odds.nbmrjun.top` behaves as it did before deployment.
5. Remove the `k8.nbmrjun.top` CNAME from Cloudflare DNS if the public hostname must also be withdrawn.

Do not delete the tunnel credentials JSON or modify the existing `odds.nbmrjun.top` DNS record during rollback.

## Secret rotation

Rotate any Cloudflare Global API Key that was pasted into a terminal or chat. The running tunnel uses its tunnel credentials JSON and does not need the Global API Key after the DNS record has been created.

Rotate `API_TOKEN` by replacing it in `.env.local`, restarting the API, updating the calling server secret, and confirming that the old token returns `401`.
