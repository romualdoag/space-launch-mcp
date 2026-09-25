/**
 * Protocol test: spawns the built server (dist/index.js) and speaks
 * real JSON-RPC MCP over stdio. Requires `npm run build` first.
 * Only offline assertions here (handshake + arg validation) so the suite
 * never depends on external launch APIs.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "index.js");

type RpcMsg = { jsonrpc: string; id?: number; result?: any; error?: any };

function sendReceive(requests: Array<object & { id?: number }>): Promise<RpcMsg[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [SERVER], {
      cwd: mkdtempSync(join(tmpdir(), "space-launch-mcp-test-")),
      stdio: ["pipe", "pipe", "ignore"],
    });
    const want = new Set(requests.map((r) => r.id).filter((x): x is number => x !== undefined));
    const seen = new Set<number>();
    const out: RpcMsg[] = [];
    let buf = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(out);
    };
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP server timed out"));
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as RpcMsg;
        out.push(msg);
        if (msg.id !== undefined) seen.add(msg.id);
        if (want.size > 0 && [...want].every((id) => seen.has(id))) finish();
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (!done) {
        done = true;
        reject(err);
      }
    });
    child.on("exit", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (buf.trim()) {
        try {
          out.push(JSON.parse(buf));
        } catch {
          /* partial line on early exit */
        }
      }
      resolve(out);
    });
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
    child.stdin.end();
  });
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };

const EXPECTED_TOOLS = [
  "get_launch",
  "get_spacex_launch",
  "list_launch_locations",
  "list_launch_pads",
  "list_launch_providers",
  "list_rocketlaunch_live",
  "list_spaceflight_news",
  "list_spacex_launches",
  "list_upcoming_launches",
];

describe("MCP protocol", () => {
  it("handshake + tools/list exposes the 9 tools", async () => {
    const msgs = await sendReceive([INIT, INITIALIZED, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
    const list = msgs.find((m) => m.id === 2);
    expect(list?.error).toBeUndefined();
    const names = (list?.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    expect(names).toEqual(EXPECTED_TOOLS);
  });

  it("tools/call with an invalid date returns a helpful error", async () => {
    const msgs = await sendReceive([
      INIT,
      INITIALIZED,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_upcoming_launches", arguments: { window_start_gte: "next friday" } },
      },
    ]);
    const call = msgs.find((m) => m.id === 3);
    // Erros de validação voltam como resultado estruturado (isError), não como JSON-RPC error.
    expect(call?.result?.isError).toBe(true);
    const text: string =
      call?.error?.message ?? call?.result?.content?.[0]?.text ?? JSON.stringify(call);
    expect(text).toMatch(/window_start_gte|ISO/);
  });

  it("tools/call with an invalid country returns a helpful error", async () => {
    const msgs = await sendReceive([
      INIT,
      INITIALIZED,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "list_launch_locations", arguments: { country_code: "US" } },
      },
    ]);
    const call = msgs.find((m) => m.id === 4);
    expect(call?.result?.isError).toBe(true);
    const text: string =
      call?.error?.message ?? call?.result?.content?.[0]?.text ?? JSON.stringify(call);
    expect(text).toMatch(/alpha-3/);
  });
});
