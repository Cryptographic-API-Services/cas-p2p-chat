#!/usr/bin/env bash
# Lets only Cloudflare reach the Container App: one ingress "Allow" rule per Cloudflare IPv4
# range (https://www.cloudflare.com/ips-v4), which blocks everyone else, including direct
# requests to the app's default *.azurecontainerapps.io address. Re-run it when Cloudflare
# changes its ranges: it adds missing rules first, then removes stale ones, so the app is never
# left open in between. Container Apps ingress is IPv4-only, so Cloudflare always connects over
# IPv4.
#
# This is also what makes TRUST_PROXY=2 safe. Behind Cloudflare and Container Apps' proxy,
# X-Forwarded-For ends "<client>, <Cloudflare edge>", and the server takes the second address
# from the right. A client reaching the app directly could put any address there.
set -euo pipefail
export MSYS_NO_PATHCONV=1

RESOURCE_GROUP=${RESOURCE_GROUP:-cas-p2p-chat}
APP=${APP:-cas-p2p-chat-server}

ranges=$(curl -fsS https://www.cloudflare.com/ips-v4 | tr -d '\r' | grep -E '^[0-9.]+/[0-9]+$')
[ -n "$ranges" ] || { echo "Couldn't fetch Cloudflare's IP ranges" >&2; exit 1; }

rule_name() { echo "cloudflare-${1//[.\/]/-}"; }

existing=$(az containerapp ingress access-restriction list -g "$RESOURCE_GROUP" -n "$APP" --query "[].name" -o tsv 2>/dev/null | tr -d '\r')
wanted=""
for cidr in $ranges; do
  name=$(rule_name "$cidr")
  wanted="$wanted $name"
  if ! grep -qx "$name" <<<"$existing"; then
    az containerapp ingress access-restriction set -g "$RESOURCE_GROUP" -n "$APP" \
      --rule-name "$name" --ip-address "$cidr" --action Allow --description "Cloudflare" -o none
    echo "allowed $cidr"
  fi
done
for name in $existing; do
  if [[ "$name" == cloudflare-* && " $wanted " != *" $name "* ]]; then
    az containerapp ingress access-restriction remove -g "$RESOURCE_GROUP" -n "$APP" --rule-name "$name" -o none
    echo "removed $name"
  fi
done
echo "ingress allows $(wc -w <<<"$wanted") Cloudflare ranges"
