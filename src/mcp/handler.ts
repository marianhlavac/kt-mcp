/**
 * The MCP endpoint itself, independent of how the caller was authenticated.
 *
 * One McpServer and one transport per request. Streamable HTTP in stateless
 * mode needs no session, which is exactly the shape a Worker wants: nothing
 * survives the request, so a redeploy or a different isolate changes nothing.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { KtClient } from '../kt/client.js';
import { registerTools } from './tools.js';

export const SERVER_VERSION = '0.2.0';

const INSTRUCTIONS =
  "Logs food into the user's kaloricketabulky.cz diary. The food database is Czech: search with Czech terms for the best matches. " +
  'When the user gives a count rather than a weight ("3 eggs"), call get_food_portions and log a natural portion unit instead of estimating grams.';

export function jsonRpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export async function handleMcpRequest(request: Request, kt: KtClient, ctx: ExecutionContext): Promise<Response> {
  // Stateless mode has no GET stream to open and no session to DELETE.
  if (request.method !== 'POST') {
    return jsonRpcError(405, -32601, 'Method not allowed', { Allow: 'POST' });
  }

  const server = new McpServer(
    { name: 'kaloricketabulky', version: SERVER_VERSION },
    {
      instructions: INSTRUCTIONS,
      // The SDK's default validator (Ajv) compiles schemas with `new Function`,
      // which Workers forbid. This one interprets schemas instead.
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );
  registerTools(server, kt);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // Plain JSON responses: the tools never stream, and a complete body is
    // simpler to proxy than an SSE stream held open on a Worker.
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (error) {
    console.error('[mcp] request failed:', error);
    return jsonRpcError(500, -32603, 'Internal server error');
  } finally {
    // In JSON mode the body is complete once handleRequest resolves, so
    // tearing down after the response is safe. waitUntil keeps it off the
    // response's critical path.
    ctx.waitUntil(server.close());
  }
}
