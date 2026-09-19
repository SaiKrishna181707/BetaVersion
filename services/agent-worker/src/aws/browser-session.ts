import {
  StartBrowserSessionCommand,
  StopBrowserSessionCommand,
  type BedrockAgentCoreClient,
} from '@aws-sdk/client-bedrock-agentcore';
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import type { AwsCredentialIdentityProvider, HttpRequest } from '@smithy/types';

/**
 * AgentCore Browser connectivity.
 *
 * One synthetic user is one AgentCore browser session, and the worker talks to it over the
 * automation stream's CDP WebSocket. That endpoint is authenticated with header-based SigV4
 * for the `bedrock-agentcore` service, which is what `signAgentCoreConnection` produces and
 * what Playwright sends on the upgrade request. Nothing here invents a protocol: the shape
 * comes from the AgentCore Browser API (`streams.automationStream.streamEndpoint`) and from
 * the documented `chromium.connect_over_cdp(ws_url, headers=...)` client usage.
 */
export interface BrowserSessionHandle {
  session_id: string;
  /** The CDP WebSocket the browser is driven through. */
  ws_endpoint: string;
  /** SigV4-signed headers for the WebSocket upgrade. */
  headers: Record<string, string>;
  stop(): Promise<void>;
}

export interface AgentCoreBrowserPort {
  readonly kind: string;
  start(input: { session_name: string; timeout_seconds: number; signal?: AbortSignal }): Promise<BrowserSessionHandle>;
}

export interface AgentCoreBrowserOptions {
  browser_id: string;
  region: string;
  client: Pick<BedrockAgentCoreClient, 'send'>;
  credentials: AwsCredentialIdentityProvider;
  /** Injected so the signature can be asserted in a test. */
  now?: () => Date;
}

/**
 * Signs the automation-stream endpoint for header-based SigV4 authentication.
 *
 * The signature covers the real request that will be sent: method, host, path, and query.
 * Values are never logged.
 */
export async function signAgentCoreConnection(input: {
  ws_endpoint: string;
  region: string;
  credentials: AwsCredentialIdentityProvider;
  now?: () => Date;
}): Promise<Record<string, string>> {
  const url = new URL(input.ws_endpoint);
  const signer = new SignatureV4({
    credentials: input.credentials,
    region: input.region,
    service: 'bedrock-agentcore',
    sha256: Sha256,
  });
  const request: HttpRequest = {
    method: 'GET',
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port.length > 0 ? Number(url.port) : undefined,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: { host: url.host },
  };
  const signed = await signer.sign(request, input.now === undefined ? {} : { signingDate: input.now() });

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(signed.headers)) {
    if (typeof value === 'string' && value.length > 0) headers[name] = value;
  }
  return headers;
}

export function createAgentCoreBrowser(options: AgentCoreBrowserOptions): AgentCoreBrowserPort {
  return {
    kind: 'agentcore-browser',

    async start(input) {
      const started = await options.client.send(new StartBrowserSessionCommand({
        browserIdentifier: options.browser_id,
        name: input.session_name,
        sessionTimeoutSeconds: input.timeout_seconds,
      }), { abortSignal: input.signal });
      const session_id = started.sessionId;
      const endpoint = started.streams?.automationStream?.streamEndpoint;
      const stop = async () => {
        if (session_id !== undefined) await options.client.send(new StopBrowserSessionCommand({ browserIdentifier: options.browser_id, sessionId: session_id }));
      };
      if (session_id === undefined || endpoint === undefined) {
        // Without an automation stream there is nothing to drive. Failing here is the honest
        // outcome: a session with no browser is not a synthetic user.
        await stop().catch(() => undefined);
        throw new Error('AgentCore Browser did not return an automation stream for this session.');
      }
      let headers: Record<string, string>;
      try { headers = await signAgentCoreConnection({
        ws_endpoint: endpoint,
        region: options.region,
        credentials: options.credentials,
        now: options.now,
      }); } catch (error) { await stop().catch(() => undefined); throw error; }
      return {
        session_id,
        ws_endpoint: endpoint,
        headers,
        stop,
      };
    },
  };
}
