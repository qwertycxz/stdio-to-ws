import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  TunnelManagementHttpClient,
  ManagementApiVersions,
} from "@microsoft/dev-tunnels-management";
import {
  TunnelAccessScopes,
  TunnelAccessControlEntryType,
  type Tunnel,
  type TunnelPort,
} from "@microsoft/dev-tunnels-contracts";
import { TunnelRelayTunnelHost } from "@microsoft/dev-tunnels-connections";

let isQuiet = false;

function log(...args: unknown[]): void {
  if (!isQuiet) console.log("[tunnel]", ...args);
}

function logError(...args: unknown[]): void {
  if (!isQuiet) console.error("[tunnel]", ...args);
}

// --- Auth ---

interface TunnelAuthToken {
  token: string;
  provider: "github";
  expiresAt?: number;
}

const GITHUB_CLIENT_ID = "01ab8ac9400c4e429b23";
const GITHUB_SCOPES = "user:email read:org";

function getCachePath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "stdio-to-ws", "tunnel-auth.json");
}

async function loadCachedToken(): Promise<TunnelAuthToken | null> {
  try {
    const raw = await readFile(getCachePath(), "utf-8");
    const cached = JSON.parse(raw) as TunnelAuthToken;
    if (cached.expiresAt && Date.now() >= cached.expiresAt) return null;
    return cached;
  } catch {
    return null;
  }
}

async function cacheToken(token: TunnelAuthToken): Promise<void> {
  const path = getCachePath();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(token, null, 2), "utf-8");
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

async function startDeviceCodeFlow(): Promise<DeviceCodeResponse> {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `client_id=${GITHUB_CLIENT_ID}&scope=${encodeURIComponent(GITHUB_SCOPES)}`,
  });
  if (!res.ok) {
    throw new Error(
      `GitHub device code request failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as DeviceCodeResponse;
}

async function pollForDeviceCodeToken(
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<string> {
  const maxAttempts = Math.floor(expiresIn / interval);
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    let res: Response;
    try {
      res = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `client_id=${GITHUB_CLIENT_ID}&device_code=${deviceCode}&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
      });
    } catch {
      continue;
    }
    if (!res.ok) continue;
    const json = (await res.json()) as {
      access_token?: string;
      error?: string;
    };
    if (json.error === "authorization_pending") continue;
    if (json.error === "slow_down") {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    if (json.error) throw new Error(`GitHub auth error: ${json.error}`);
    if (json.access_token) return json.access_token;
  }
  throw new Error("Device code expired — please try again");
}

/**
 * Obtain a GitHub token for Dev Tunnels.
 * Strategy: cached token → gh CLI → device code flow.
 */
async function authenticate(): Promise<TunnelAuthToken> {
  // 1. Cached token
  const cached = await loadCachedToken();
  if (cached) {
    log("Using cached GitHub token");
    return cached;
  }

  // 2. Device code flow
  log("No cached token found. Starting GitHub device code authentication...");
  const dcr = await startDeviceCodeFlow();
  console.log();
  console.log(`  Open ${dcr.verification_uri} and enter code: ${dcr.user_code}`);
  console.log();

  const accessToken = await pollForDeviceCodeToken(
    dcr.device_code,
    dcr.interval,
    dcr.expires_in,
  );

  const token: TunnelAuthToken = {
    token: accessToken,
    provider: "github",
    // GitHub tokens from device code flow don't have explicit expiry,
    // but we cache for 30 days as a reasonable default
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  };
  await cacheToken(token);
  log("Authenticated successfully");
  return token;
}

// --- Tunnel Management ---

function createManagementClient(
  token: TunnelAuthToken,
): TunnelManagementHttpClient {
  const tokenCallback = async () => `github ${token.token}`;
  return new TunnelManagementHttpClient(
    "stdio-to-ws/0.2.0",
    ManagementApiVersions.Version20230927preview,
    tokenCallback,
  );
}

/**
 * Start a Dev Tunnel host that forwards a local port.
 * Creates or reuses a tunnel, then starts the relay host.
 */
export async function startTunnelHost(opts: {
  port: number;
  quiet?: boolean;
  tunnelName?: string;
}): Promise<void> {
  const { port, quiet = false, tunnelName } = opts;
  isQuiet = quiet;

  // 1. Authenticate
  const authToken = await authenticate();
  const managementClient = createManagementClient(authToken);

  try {
    // 2. Create or find tunnel
    let tunnel: Tunnel;
    if (tunnelName) {
      // Try to find existing tunnel by name
      try {
        const found = await managementClient.getTunnel(
          { name: tunnelName } as Tunnel,
          {
            includePorts: true,
            tokenScopes: [TunnelAccessScopes.Host],
          },
        );
        if (!found) throw new Error("not found");
        tunnel = found;
        log(`Found existing tunnel: ${tunnelName}`);
      } catch {
        // Create new tunnel with the given name
        tunnel = await managementClient.createTunnel(
          { name: tunnelName } as Tunnel,
          {
            tokenScopes: [TunnelAccessScopes.Host],
          },
        );
        log(`Created tunnel: ${tunnelName}`);
      }
    } else {
      // Create anonymous tunnel
      tunnel = await managementClient.createTunnel({} as Tunnel, {
        tokenScopes: [TunnelAccessScopes.Host],
      });
      log(`Created tunnel: ${tunnel.tunnelId}`);
    }

    // 3. Ensure port is registered
    const existingPort = tunnel.ports?.find((p) => p.portNumber === port);
    if (!existingPort) {
      const tunnelPort: TunnelPort = {
        portNumber: port,
        protocol: "https",
        accessControl: {
          entries: [
            {
              type: TunnelAccessControlEntryType.Anonymous,
              subjects: [],
              scopes: [TunnelAccessScopes.Connect],
            },
          ],
        },
      };
      await managementClient.createTunnelPort(tunnel, tunnelPort);
      log(`Registered port ${port} on tunnel`);
    }

    // Re-fetch tunnel to get updated access tokens
    const refreshed = await managementClient.getTunnel(tunnel, {
      includePorts: true,
      tokenScopes: [TunnelAccessScopes.Host],
    });
    if (!refreshed) {
      throw new Error("Failed to refresh tunnel after port registration");
    }
    tunnel = refreshed;

    // 4. Start relay host
    const host = new TunnelRelayTunnelHost(managementClient);
    host.forwardConnectionsToLocalPorts = true;

    await host.connect(tunnel);
    log("Tunnel host connected");

    // 5. Print the tunnel URL
    const tunnelId = tunnel.tunnelId ?? tunnel.name ?? "unknown";
    const clusterId = tunnel.clusterId ?? "global";
    const url = `https://${tunnelId}-${port}.${clusterId}.devtunnels.ms`;
    console.log();
    console.log(`  Tunnel URL: ${url}`);
    console.log();
    log(
      "Remote clients can connect to this URL from Agmente or any WebSocket client",
    );

    // Keep alive — clean up on process exit
    const cleanup = async () => {
      log("Shutting down tunnel host...");
      await host.dispose();
      await managementClient.dispose();
    };

    process.on("SIGINT", async () => {
      await cleanup();
      process.exit(0);
    });
    process.on("SIGTERM", async () => {
      await cleanup();
      process.exit(0);
    });
  } catch (error) {
    logError("Failed to start tunnel host:", error);
    await managementClient.dispose();
    throw error;
  }
}
