#!/usr/bin/env bash
# One-time Azure setup for the chat server, with the Azure CLI. This is what created the current
# deployment; it's safe to re-run (each step checks first or is idempotent). Run it from the
# repository root, signed in (`az login`) as an Entra admin of the PostgreSQL server, with `gh`
# signed in as a repository admin. On Windows Git Bash, it sets MSYS_NO_PATHCONV so resource IDs
# aren't rewritten into Windows paths.
#
# Creates, in its own resource group: a user-assigned managed identity (pulls the image, signs in
# to PostgreSQL), a container registry, a Log Analytics workspace, a Container Apps environment
# and the app itself. On an existing PostgreSQL Flexible Server with Entra ID authentication, it
# creates a database owned by a role for that identity. Then it creates the Entra app GitHub
# Actions signs in as (federated credential, Contributor on the resource group) and sets the
# repository secrets for .github/workflows/deploy-server.yml.
#
# The public hostname (chatp2p.cryptographicapiservices.com) is set up by hand, because it
# involves Cloudflare: see README, "Deploying to Azure". Once it is, run cloudflare-ingress.sh
# so only Cloudflare can reach the app. This script never touches the hostname binding or the
# ingress rules of an existing app.
set -euo pipefail
export MSYS_NO_PATHCONV=1

RESOURCE_GROUP=${RESOURCE_GROUP:-cas-p2p-chat}
LOCATION=${LOCATION:-centralus}
IDENTITY=${IDENTITY:-cas-p2p-chat-server}           # also the PostgreSQL role name
REGISTRY=${REGISTRY:-casp2pchat}
WORKSPACE=${WORKSPACE:-cas-p2p-chat-logs}
ENVIRONMENT=${ENVIRONMENT:-cas-p2p-chat-env}
APP=${APP:-cas-p2p-chat-server}
IMAGE=${IMAGE:-cas-p2p-chat-server}
PG_RESOURCE_GROUP=${PG_RESOURCE_GROUP:-Rust-Playground}
PG_SERVER=${PG_SERVER:-rust-playground-pg}
DATABASE=${DATABASE:-cas_p2p_chat}
GITHUB_REPO=${GITHUB_REPO:-Cryptographic-API-Services/cas-p2p-chat}
GITHUB_APP=${GITHUB_APP:-cas-p2p-chat-gh}

step() { printf '\n== %s\n' "$*"; }

step "Resource group, identity, registry, logs"
az group create -n "$RESOURCE_GROUP" -l "$LOCATION" -o none
az identity create -g "$RESOURCE_GROUP" -n "$IDENTITY" -o none
MI_ID=$(az identity show -g "$RESOURCE_GROUP" -n "$IDENTITY" --query id -o tsv)
MI_CLIENT=$(az identity show -g "$RESOURCE_GROUP" -n "$IDENTITY" --query clientId -o tsv)
MI_PRINCIPAL=$(az identity show -g "$RESOURCE_GROUP" -n "$IDENTITY" --query principalId -o tsv)
az acr show -n "$REGISTRY" -o none 2>/dev/null || az acr create -g "$RESOURCE_GROUP" -n "$REGISTRY" --sku Basic --admin-enabled false -o none
ACR_ID=$(az acr show -n "$REGISTRY" --query id -o tsv)
az role assignment create --assignee-object-id "$MI_PRINCIPAL" --assignee-principal-type ServicePrincipal \
  --role AcrPull --scope "$ACR_ID" -o none
az monitor log-analytics workspace create -g "$RESOURCE_GROUP" -n "$WORKSPACE" --retention-time 30 -o none

step "Container Apps environment"
if ! az containerapp env show -g "$RESOURCE_GROUP" -n "$ENVIRONMENT" -o none 2>/dev/null; then
  az containerapp env create -g "$RESOURCE_GROUP" -n "$ENVIRONMENT" -l "$LOCATION" \
    --logs-workspace-id "$(az monitor log-analytics workspace show -g "$RESOURCE_GROUP" -n "$WORKSPACE" --query customerId -o tsv)" \
    --logs-workspace-key "$(az monitor log-analytics workspace get-shared-keys -g "$RESOURCE_GROUP" -n "$WORKSPACE" --query primarySharedKey -o tsv)" \
    -o none
fi
ENV_ID=$(az containerapp env show -g "$RESOURCE_GROUP" -n "$ENVIRONMENT" --query id -o tsv)

step "Database $DATABASE on $PG_SERVER, owned by the identity's role"
PG_HOST=$(az postgres flexible-server show -g "$PG_RESOURCE_GROUP" -n "$PG_SERVER" --query fullyQualifiedDomainName -o tsv)
az postgres flexible-server db show -g "$PG_RESOURCE_GROUP" -s "$PG_SERVER" -d "$DATABASE" -o none 2>/dev/null \
  || az postgres flexible-server db create -g "$PG_RESOURCE_GROUP" -s "$PG_SERVER" -d "$DATABASE" -o none
# Connects as you (an Entra admin) with an Entra token; your IP must be allowed by the server's firewall.
PG_ADMIN=$(az account show --query user.name -o tsv) \
PG_TOKEN=$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv) \
PG_HOST="$PG_HOST" DATABASE="$DATABASE" ROLE="$IDENTITY" PRINCIPAL="$MI_PRINCIPAL" \
node --input-type=module -e '
import pg from "pg";
const { PG_ADMIN: admin, PG_TOKEN: password, PG_HOST: host, DATABASE: database, ROLE: role, PRINCIPAL: oid } = process.env;
const connect = async (db) => { const c = new pg.Client({ host, user: admin, password, database: db, ssl: true }); await c.connect(); return c; };
let c = await connect("postgres");
if ((await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount === 0) {
    await c.query("SELECT * FROM pgaadauth_create_principal_with_oid($1, $2, $3, false, false)", [role, oid, "service"]);
}
await c.query(`GRANT "${role}" TO "${admin}"`);
await c.query(`ALTER DATABASE "${database}" OWNER TO "${role}"`);
await c.end();
c = await connect(database);
// Azure creates the public schema owned by azure_pg_admin.
await c.query(`GRANT ALL ON SCHEMA public TO "${role}"`);
await c.end();
console.log(`role ${role} owns ${database}`);
'

step "Server image (built in Azure)"
az acr build -r "$REGISTRY" --platform linux/amd64 -t "$IMAGE:latest" -f apps/server/Dockerfile . -o none

step "Container App $APP"
SPEC=$(mktemp)
cat > "$SPEC" <<EOF
location: $LOCATION
identity:
  type: UserAssigned
  userAssignedIdentities:
    $MI_ID: {}
properties:
  managedEnvironmentId: $ENV_ID
  configuration:
    activeRevisionsMode: Single
    ingress:
      external: true
      targetPort: 8787
      transport: auto
      allowInsecure: false
    registries:
      - server: $REGISTRY.azurecr.io
        identity: $MI_ID
  template:
    containers:
      - name: server
        image: $REGISTRY.azurecr.io/$IMAGE:latest
        resources:
          cpu: 0.25
          memory: 0.5Gi
        env:
          - name: DATABASE_URL
            value: postgres://$IDENTITY@$PG_HOST:5432/$DATABASE?sslmode=verify-full
          - name: USE_MANAGED_IDENTITY
            value: "1"
          - name: MANAGED_IDENTITY_CLIENT_ID
            value: $MI_CLIENT
          # Two proxies in front: Cloudflare, then Container Apps' own.
          - name: TRUST_PROXY
            value: "2"
        probes:
          - type: Liveness
            httpGet: { path: /health, port: 8787 }
            periodSeconds: 30
          - type: Readiness
            httpGet: { path: /health, port: 8787 }
            periodSeconds: 10
    # Exactly one replica: signaling presence lives in the server's memory.
    scale:
      minReplicas: 1
      maxReplicas: 1
EOF
if az containerapp show -g "$RESOURCE_GROUP" -n "$APP" -o none 2>/dev/null; then
  # Not --yaml: that replaces the whole ingress config, dropping the custom domain and the
  # Cloudflare-only rules. Only bring the settings up to date.
  az containerapp update -g "$RESOURCE_GROUP" -n "$APP" -o none --set-env-vars     "DATABASE_URL=postgres://$IDENTITY@$PG_HOST:5432/$DATABASE?sslmode=verify-full"     USE_MANAGED_IDENTITY=1 "MANAGED_IDENTITY_CLIENT_ID=$MI_CLIENT" TRUST_PROXY=2
else
  az containerapp create -g "$RESOURCE_GROUP" -n "$APP" --yaml "$SPEC" -o none
fi
rm -f "$SPEC"

step "GitHub Actions sign-in ($GITHUB_APP, federated credential for main)"
GH_APP_ID=$(az ad app list --display-name "$GITHUB_APP" --query "[0].appId" -o tsv)
[ -n "$GH_APP_ID" ] || GH_APP_ID=$(az ad app create --display-name "$GITHUB_APP" --query appId -o tsv)
GH_SP_ID=$(az ad sp show --id "$GH_APP_ID" --query id -o tsv 2>/dev/null || az ad sp create --id "$GH_APP_ID" --query id -o tsv)
SUBJECT="repo:$GITHUB_REPO:ref:refs/heads/main"
if [ -z "$(az ad app federated-credential list --id "$GH_APP_ID" --query "[?subject=='$SUBJECT'].name" -o tsv)" ]; then
  az ad app federated-credential create --id "$GH_APP_ID" -o none --parameters \
    "{\"name\":\"github-main\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"$SUBJECT\",\"audiences\":[\"api://AzureADTokenExchange\"]}"
fi
az role assignment create --assignee-object-id "$GH_SP_ID" --assignee-principal-type ServicePrincipal \
  --role Contributor --scope "$(az group show -n "$RESOURCE_GROUP" --query id -o tsv)" -o none
gh secret set AZURE_CLIENT_ID -R "$GITHUB_REPO" -b "$GH_APP_ID"
gh secret set AZURE_TENANT_ID -R "$GITHUB_REPO" -b "$(az account show --query tenantId -o tsv)"
gh secret set AZURE_SUBSCRIPTION_ID -R "$GITHUB_REPO" -b "$(az account show --query id -o tsv)"

step "Done"
echo "https://$(az containerapp show -g "$RESOURCE_GROUP" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)"
