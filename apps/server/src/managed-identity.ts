/**
 * Microsoft Entra ID access tokens for Azure Database for PostgreSQL, from the container's
 * managed identity, used as the database password (USE_MANAGED_IDENTITY). Azure Container Apps
 * provides the identity endpoint through IDENTITY_ENDPOINT and IDENTITY_HEADER. A token lasts
 * about an hour and is only checked when a connection opens, so it's cached and refreshed shortly
 * before it expires.
 */
const RESOURCE = "https://ossrdbms-aad.database.windows.net";
const REFRESH_BEFORE_MS = 5 * 60_000;

/**
 * Returns a function that resolves to a current token. `clientId` picks a user-assigned
 * identity; leave it out for the system-assigned one.
 */
export function managedIdentityToken(clientId?: string, env: NodeJS.ProcessEnv = process.env): () => Promise<string> {
    let cached: { token: string; expiresAt: number } | null = null;
    return async () => {
        if (cached && cached.expiresAt - Date.now() > REFRESH_BEFORE_MS) {
            return cached.token;
        }
        const endpoint = env.IDENTITY_ENDPOINT;
        const secret = env.IDENTITY_HEADER;
        if (!endpoint || !secret) {
            throw new Error("USE_MANAGED_IDENTITY is set, but there's no managed identity endpoint (IDENTITY_ENDPOINT, IDENTITY_HEADER)");
        }
        const url = new URL(endpoint);
        url.searchParams.set("resource", RESOURCE);
        url.searchParams.set("api-version", "2019-08-01");
        if (clientId) {
            url.searchParams.set("client_id", clientId);
        }
        const response = await fetch(url, { headers: { "X-IDENTITY-HEADER": secret }, signal: AbortSignal.timeout(10_000) });
        if (!response.ok) {
            throw new Error(`managed identity token request failed: HTTP ${response.status}`);
        }
        const body = (await response.json()) as { access_token?: unknown; expires_on?: unknown };
        if (typeof body.access_token !== "string" || body.access_token === "") {
            throw new Error("managed identity token response has no access_token");
        }
        // expires_on is Unix seconds, sent as a string.
        const expiresOn = Number(body.expires_on) * 1000;
        cached = { token: body.access_token, expiresAt: expiresOn > Date.now() ? expiresOn : Date.now() + 30 * 60_000 };
        return cached.token;
    };
}
