/** Talking to the MCP endpoint as a client does: tokens, JSON-RPC messages and tool calls. */
import { Browser } from "./helpers";

export interface Created {
  token: string;
  info: {
    id: string;
    name: string;
    prefix: string;
    scope: "read" | "write";
    expiresAt: number | null;
  };
}

/** Makes a token (read-only unless `scope` says write). */
export async function makeToken(
  browser: Browser,
  name = "Claude Code",
  expiresInDays: number | null = 90,
  scope?: "read" | "write",
) {
  return browser.json<Created>("/api/account/tokens", {
    method: "POST",
    json: { name, expiresInDays, ...(scope ? { scope } : {}) },
  });
}

/** One JSON-RPC message to the MCP endpoint, as an MCP client sends it (no cookie, no Origin). */
export async function rpc(
  token: string | null,
  message: unknown,
  headers: Record<string, string> = {},
) {
  const res = await new Browser().fetch("/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

let nextId = 1;
export async function call(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
  headers?: Record<string, string>,
) {
  const { body } = await rpc(
    token,
    {
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    },
    headers,
  );
  return body.result as {
    isError: boolean;
    structuredContent: Record<string, unknown>;
    content: Array<{ type: string; text: string }>;
  };
}
