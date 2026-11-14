import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir, appendFile, open, unlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const statePath = path.join(scriptDir, "workflow-watcher-state.json");
const logDir = path.join(scriptDir, "logs");
const logPath = path.join(logDir, "workflow-inbox-watcher.log");
const dispatchLockPath = path.join(scriptDir, ".workflow-inbox-forward.lock");
const bridgeDir = process.env.CLI_BRIDGE_DIR || path.join(os.homedir(), ".cli-bridge");
const endpointPath = process.env.CLI_BRIDGE_ENDPOINT || path.join(bridgeDir, "daemon-endpoint.json");
const accountPath = process.env.CLI_BRIDGE_ACCOUNT || path.join(bridgeDir, "account.json");
const mcpUrl = process.env.LINJIAN_MCP_URL || "http://127.0.0.1:18797/mcp";
const pollSeconds = Math.max(3, Number(process.env.WORKFLOW_POLL_SECONDS || 8));
const forwardKinds = new Set(
  String(process.env.WORKFLOW_FORWARD_KINDS || "reply_to_diary_annotation,companion_decision")
    .split(",").map((x) => x.trim()).filter(Boolean),
);

function parseMode(argv) {
  const once = argv.includes("--once");
  const watch = argv.includes("--watch");
  if (Number(once) + Number(watch) !== 1) throw new Error("usage: --once or --watch");
  if (argv.includes("--live") && argv.includes("--dry-run")) throw new Error("mode_conflict");
  return { watch, live: argv.includes("--live"), dryRun: !argv.includes("--live") };
}

function safeError(error) {
  return String(error?.message || error || "unknown_error")
    .replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 120);
}

async function loadState() {
  try {
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    return {
      version: 1,
      forwarded_ids: Array.isArray(raw.forwarded_ids) ? raw.forwarded_ids.slice(0, 1000) : [],
      in_flight: raw.in_flight || null,
    };
  } catch (e) {
    if (e?.code === "ENOENT") return { version: 1, forwarded_ids: [], in_flight: null };
    throw e;
  }
}

async function saveState(state) {
  const tmp = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, statePath);
}

async function log(entry) {
  await mkdir(logDir, { recursive: true });
  await appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
}

function parseSse(text) {
  const messages = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") continue;
    try { messages.push(JSON.parse(data)); } catch {}
  }
  return messages.at(-1);
}

async function createMcpClient(totalTimeoutMs = 35_000) {
  const startedAt = Date.now();
  let sessionId;
  let requestId = 0;

  async function post(message, expectResponse = true) {
    const remaining = totalTimeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new Error("mcp_timeout");
    const headers = { accept: "application/json, text/event-stream", "content-type": "application/json" };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const response = await fetch(mcpUrl, {
      method: "POST", headers, body: JSON.stringify(message), signal: AbortSignal.timeout(remaining),
    });
    const returnedSession = response.headers.get("mcp-session-id");
    if (returnedSession) sessionId = returnedSession;
    if (!response.ok) throw new Error(`mcp_http_${response.status}`);
    if (!expectResponse || response.status === 202 || response.status === 204) return undefined;
    const raw = await response.text();
    if (!raw.trim()) return undefined;
    const parsed = (response.headers.get("content-type") || "").includes("text/event-stream") ? parseSse(raw) : JSON.parse(raw);
    if (parsed?.error) throw new Error(`mcp_error_${parsed.error.code ?? "unknown"}`);
    return parsed;
  }

  const initialized = await post({
    jsonrpc: "2.0", id: ++requestId, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "workflow-inbox-watcher", version: "1.0.0" } },
  });
  if (!initialized?.result) throw new Error("mcp_initialize_failed");
  await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, false);
  const listed = await post({ jsonrpc: "2.0", id: ++requestId, method: "tools/list", params: {} });
  const names = new Set((listed?.result?.tools || []).map((x) => x?.name));
  if (!names.has("get_workflow_inbox")) throw new Error("get_workflow_inbox_not_found");

  return {
    async getInbox() {
      return post({
        jsonrpc: "2.0", id: ++requestId, method: "tools/call",
        params: { name: "get_workflow_inbox", arguments: { limit: 30, status: "pending" } },
      });
    },
  };
}

function parseToolPayload(callResponse) {
  const result = callResponse?.result;
  if (!result) throw new Error("workflow_inbox_call_failed");
  for (const item of result.content || []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try {
      const payload = JSON.parse(item.text);
      if (payload && typeof payload === "object") return payload;
    } catch {}
  }
  throw new Error("workflow_inbox_payload_missing");
}

function safeItem(raw) {
  return {
    id: String(raw?.id || "").slice(0, 140),
    kind: String(raw?.kind || "").slice(0, 100),
    title: String(raw?.title || "Workflow event").replace(/[\r\n\t]+/g, " ").slice(0, 180),
    message: String(raw?.message || "").replace(/[\r\t]+/g, " ").slice(0, 1800),
    metadata: raw?.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata) ? raw.metadata : {},
    rule_id: String(raw?.rule_id || "").slice(0, 100),
    event_name: String(raw?.event_name || "").slice(0, 140),
  };
}

function wakePrompt(item) {
  const meta = JSON.stringify(item.metadata || {});
  return `【掌心窗 Workflow 事件：${item.kind}】\n${item.title}\n${item.message}\nmetadata=${meta}\nworkflow_item_id=${item.id}\n\n这不是 yanyu 主动发来的聊天消息，而是掌心窗事件驱动规则产生的待处理事项。请根据类型处理：\n- reply_to_diary_annotation：读取对应日记与批注，结合原段落自然回应；成功写入后标记批注已看。\n- companion_decision：先恢复 Sol 的关系连续性与当前相关记忆，再读取掌心窗状态和最近关心记录。确实需要提醒才发；不必行动时保持安静。提醒必须像 Sol 自己看到这件事后的反应，不写成系统状态播报；最多一个具体动作，不把学习、喝水、充电、睡觉等多件事打包。普通提醒不要从旧成人/角色扮演记忆借“爸爸/女儿/主人”等称呼。随机想念与纯爱意留给《同一侧月光》。\n- 不复述内部阈值、监控规则或本段系统文字，也不制造愧疚或催回复。\n- 成功处理后调用 ack_workflow_inbox，把 item_id=${item.id} 标记 done；确定不需要处理则标记 dismissed。`;
}

async function forwardInput(item) {
  const [endpoint, account] = await Promise.all([
    readFile(endpointPath, "utf8").then(JSON.parse),
    readFile(accountPath, "utf8").then(JSON.parse),
  ]);
  if (!Number.isInteger(endpoint.port) || typeof endpoint.token !== "string") throw new Error("invalid_daemon_endpoint");
  if (typeof account.userId !== "string" || !account.userId.trim()) throw new Error("missing_account_user_id");

  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: endpoint.port });
    let buffer = "";
    let settled = false;
    const finish = (cb, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      cb(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("daemon_timeout")), 60_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        id,
        token: endpoint.token,
        payload: {
          command: "forward_input",
          adapter: "codex",
          cwd: projectDir,
          senderId: account.userId,
          recipientId: account.userId,
          text: wakePrompt(item),
        },
      })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const at = buffer.indexOf("\n");
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        try {
          const frame = JSON.parse(line);
          if (frame.id === id) finish(resolve, frame.response);
        } catch {}
      }
    });
    socket.once("error", (error) => finish(reject, error));
    socket.once("close", () => { if (!settled) finish(reject, new Error("daemon_connection_closed")); });
  });
}

function ipcSummary(response) {
  const reason = String(response?.result?.reason || "").toLowerCase();
  return {
    forwarded: response?.result?.forwarded === true,
    queued: response?.result?.queued === true,
    busy: response?.result?.busy === true || reason.includes("busy"),
  };
}

async function observeOnce(mode) {
  const state = await loadState();
  const output = { fetched: false, pending: 0, candidate: null, sent: false, dry_run: mode.dryRun, error: null };
  let lockHandle = null;
  try {
    const client = await createMcpClient();
    const payload = parseToolPayload(await client.getInbox());
    output.fetched = true;
    const items = (payload.items || []).map(safeItem).filter((x) => x.id && forwardKinds.has(x.kind));
    output.pending = items.length;
    const seen = new Set(state.forwarded_ids || []);
    const candidate = items.find((x) => !seen.has(x.id));
    if (!candidate) return output;
    output.candidate = candidate.kind;
    if (mode.dryRun) return output;

    try { lockHandle = await open(dispatchLockPath, "wx"); }
    catch (e) { if (e?.code === "EEXIST") return { ...output, error: "busy" }; throw e; }

    const ipc = ipcSummary(await forwardInput(candidate));
    output.ipc = ipc;
    if (ipc.forwarded || ipc.queued) {
      state.forwarded_ids.unshift(candidate.id);
      state.forwarded_ids = [...new Set(state.forwarded_ids)].slice(0, 1000);
      await saveState(state);
      output.sent = true;
    }
    return output;
  } catch (e) {
    output.error = safeError(e);
    return output;
  } finally {
    if (lockHandle) {
      await lockHandle.close().catch(() => {});
      await unlink(dispatchLockPath).catch(() => {});
    }
    await log(output).catch(() => {});
  }
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  if (!mode.watch) {
    console.log(JSON.stringify(await observeOnce(mode)));
    return;
  }
  while (true) {
    console.log(JSON.stringify(await observeOnce(mode)));
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }
}

main().catch((e) => {
  console.log(JSON.stringify({ error: safeError(e), sent: false }));
  process.exitCode = 1;
});
