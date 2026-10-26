import { describe, expect, it } from "vitest";
import { GatewayRequestError, TimeoutError } from "../src/errors.js";
import { fetchJson } from "../src/http.js";

function respond(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

const never = (() => new Promise<Response>(() => {})) as typeof fetch;
const broken = (async () => {
  throw new TypeError("fetch failed");
}) as typeof fetch;

async function failure(f: typeof fetch, init: RequestInit = {}, timeoutMs = 1000) {
  return fetchJson("razorpay", "https://api.example.test/x", init, { fetch: f, timeoutMs }).then(
    () => {
      throw new Error("expected fetchJson to reject");
    },
    (e: unknown) => e,
  );
}

describe("fetchJson", () => {
  it("returns parsed JSON on 2xx", async () => {
    const out = await fetchJson<{ id: string }>(
      "razorpay",
      "https://api.example.test/x",
      { method: "GET" },
      { fetch: respond(200, { id: "abc" }), timeoutMs: 1000 },
    );
    expect(out).toEqual({ id: "abc" });
  });

  it("times out → TimeoutError classified gateway", async () => {
    const err = await failure(never, {}, 20);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toMatchObject({ classification: "gateway", reason: "timeout", httpStatus: null });
  });

  it("aborts the underlying request on timeout", async () => {
    let signal: AbortSignal | undefined;
    const spy = ((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    await failure(spy, {}, 20);
    expect(signal?.aborted).toBe(true);
  });

  it("network error → GatewayRequestError(null, gateway, network)", async () => {
    const err = await failure(broken);
    expect(err).toBeInstanceOf(GatewayRequestError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect(err).toMatchObject({ httpStatus: null, classification: "gateway", reason: "network" });
  });

  it("5xx → gateway, 4xx → unknown", async () => {
    const e5 = await failure(respond(502, { error: {} }));
    expect(e5).toBeInstanceOf(GatewayRequestError);
    expect(e5).toMatchObject({ httpStatus: 502, classification: "gateway" });

    const e4 = await failure(respond(400, { error: {} }));
    expect(e4).toBeInstanceOf(GatewayRequestError);
    expect(e4).toMatchObject({ httpStatus: 400, classification: "unknown" });
  });

  it("non-JSON 2xx body → GatewayRequestError classified gateway", async () => {
    const html = (async () => new Response("<html>oops</html>", { status: 200 })) as typeof fetch;
    const err = await failure(html);
    expect(err).toBeInstanceOf(GatewayRequestError);
    expect(err).toMatchObject({ httpStatus: 200, classification: "gateway" });
  });

  it("error message never contains the auth header", async () => {
    const secret = "rzp_test_KEY:SUPER_SECRET_VALUE";
    const encoded = Buffer.from(secret).toString("base64");
    const init: RequestInit = {
      method: "POST",
      headers: { authorization: `Basic ${encoded}` },
      body: JSON.stringify({ secret: "SUPER_SECRET_VALUE" }),
    };
    const fetches = [
      respond(401, { error: { description: "auth failed" } }),
      respond(500, {}),
      broken,
      never,
    ];
    for (const f of fetches) {
      const err = (await failure(f, init, 20)) as Error;
      expect(err).toBeInstanceOf(GatewayRequestError);
      const dump = `${err.message} ${err.stack ?? ""} ${JSON.stringify(err)}`;
      expect(dump).not.toContain("SUPER_SECRET_VALUE");
      expect(dump).not.toContain(encoded);
    }
  });
});
