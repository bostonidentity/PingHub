import { NextRequest } from "next/server";
import { getAccessToken } from "@/lib/iga-api";
import { restGet } from "@/vendor/fr-config-manager/common/restClient.js";

/**
 * Validate environment credentials in-process — no CLI spawn.
 * Mirrors what `fr-config-pull test` used to do: fetch a token via the
 * service-account JWT, then make one cheap call to the tenant.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { envVars } = body as { envVars: Record<string, string>; debug?: boolean };

  const stream = new ReadableStream<string>({
    async start(controller) {
      const emit = (type: string, data: string) =>
        controller.enqueue(JSON.stringify({ type, data, ts: Date.now() }) + "\n");
      const done = (code: number) => {
        controller.enqueue(JSON.stringify({ type: "exit", code, ts: Date.now() }) + "\n");
        controller.close();
      };

      const tenantUrl = envVars.TENANT_BASE_URL;
      if (!tenantUrl) {
        emit("stderr", "TENANT_BASE_URL missing");
        return done(1);
      }

      let token: string;
      try {
        emit("stdout", "Acquiring access token...\n");
        token = await getAccessToken(envVars);
      } catch (err) {
        emit("stderr", `Token acquisition failed: ${err instanceof Error ? err.message : String(err)}\n`);
        return done(1);
      }

      try {
        // A cheap tenant-side call. /openidm/info/ping returns immediately
        // and requires auth, so any 2xx response confirms the credentials work.
        const pingUrl = `${tenantUrl}/openidm/info/ping`;
        emit("stdout", `GET ${pingUrl}\n`);
        await restGet(pingUrl, null, token);
        emit("stdout", "OK — credentials valid.\n");
        return done(0);
      } catch (err) {
        emit("stderr", `Test failed: ${err instanceof Error ? err.message : String(err)}\n`);
        return done(1);
      }
    },
  });

  return new Response(stream as unknown as ReadableStream<Uint8Array>, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
