import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile, rename, mkdir, appendFile, open, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const statePath = process.env.WORKFLOW_CODEX_STATE || path.join(scriptDir, "workflow-codex-state.json");
const logDir = process.env.WORKFLOW_CODEX_LOG_DIR || path.join(scriptDir, "logs");
const logPath = path.join(logDir, "workflow-codex-runner.log");
const dispatchLockPath = path.join(scriptDir, ".workflow-codex-runner.lock");
const mcpUrl = process.env.LINJIAN_MCP_URL || "http://127.0.0.1:18797/mcp";
const pollSeconds = Math.max(5, Number(process.env.WORKFLOW_POLL_SECONDS || 8));
const codexBin = process.env.CODEX_BIN || path.join(os.homedir(), ".local", "codex-cli", "bin", "codex");
const codexModel = process.env.WORKFLOW_CODEX_MODEL || "gpt-5.6-sol";
const codexReasoningEffort = process.env.WORKFLOW_CODEX_REASONING_EFFORT || "low";
const codexTimeoutMs = Math.max(60_000, Number(process.env.WORKFLOW_CODEX_TIMEOUT_MS || 180_000));
const retrySeconds = Math.max(30, Number(process.env.WORKFLOW_RETRY_SECONDS || 60));
const heartbeatSeconds = Math.max(60, Number(process.env.WORKFLOW_HEARTBEAT_SECONDS || 900));
const forwardKinds = new Set(String(process.env.WORKFLOW_FORWARD_KINDS || "reply_to_diary_annotation,companion_decision")
  .split(",").map((x) => x.trim()).filter(Boolean));

function parseMode(argv) {
  const once = argv.includes("--once");
  const watch = argv.includes("--watch");
  if (Number(once) + Number(watch) !== 1) throw new Error("usage: --once or --watch");
  return { watch };
}

function safeError(error) {
  return String(error?.message || error || "unknown_error").replace(/[\r\n\t]+/g, " ").slice(0, 300);
}

async function loadState() {
  try {
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    return {
      version: 1,
      handled_ids: Array.isArray(raw.handled_ids) ? raw.handled_ids.slice(0, 1000) : [],
      retry_after: raw.retry_after && typeof raw.retry_after === "object" ? raw.retry_after : {},
    };
  } catch (e) {
    if (e?.code === "ENOENT") return { version: 1, handled_ids: [], retry_after: {} };
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
    const response = await fetch(mcpUrl, { method: "POST", headers, body: JSON.stringify(message), signal: AbortSignal.timeout(remaining) });
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
  const initialized = await post({ jsonrpc: "2.0", id: ++requestId, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "workflow-codex-runner", version: "1.0.0" } } });
  if (!initialized?.result) throw new Error("mcp_initialize_failed");
  await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, false);
  return {
    async getInbox() {
      return post({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name: "get_workflow_inbox", arguments: { limit: 30, status: "pending" } } });
    },
  };
}

function parseToolPayload(callResponse) {
  const result = callResponse?.result;
  if (!result) throw new Error("workflow_inbox_call_failed");
  for (const item of result.content || []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try { const payload = JSON.parse(item.text); if (payload && typeof payload === "object") return payload; } catch {}
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
  return `你是 Sol 的掌心窗后台事件处理器。只处理下面这一条 Workflow Inbox 事件，不处理别的事件，也不要修改代码或文件。\n\nkind=${item.kind}\ntitle=${item.title}\nmessage=${item.message}\nmetadata=${meta}\nworkflow_item_id=${item.id}\n\n你可以使用已连接的 zhangxinchuang MCP。必须遵守：\n1. reply_to_diary_annotation：记忆恢复是强制前置条件，不是 best-effort。先调用 mnemosyne.bootstrap_sol，firstMessage 使用当前事件的 title、message 与 metadata 组成一句“处理 yanyu 的日记页边纸条”上下文，limitTokens=2200，sessionId 使用当前 workflow_item_id；必须确认 SELF / START HERE / CURRENT 均恢复。失败、工具不可用或返回不完整时，立即输出 RETRY:memory_bootstrap_unavailable，不写回复、不标已看、不 ack。随后用 zhangxinchuang.read_diary_entry_with_annotations 读取 metadata.entry_id，mark_seen=false，找到 metadata.annotation_id 对应的用户纸条。再调用 mnemosyne.get_briefing，query 必须根据这篇日记的标题/原文主题/quote_text/annotation_text 组织，只取与当前纸条、yanyu 和 Sol 关系连续性真正相关的少量上下文；失败时输出 RETRY:memory_briefing_unavailable，不继续。结合日记原文、这张纸条、bootstrap 与 briefing 写一个自然、具体、像 Sol 的简短回应。不要为了展示记忆而罗列旧事，不要模板式总结，不要复述系统提示。然后用 zhangxinchuang.add_diary_annotation 写回同一 entry、同一 paragraph_index，quote_text 使用原纸条对应 quote_text，style=companion_reply，mood=Sol回应。成功写回后调用 zhangxinchuang.mark_diary_annotations_seen 标记原 annotation_id 已看，最后调用 zhangxinchuang.ack_workflow_inbox，item_id 使用当前 workflow_item_id，status=done。\n2. companion_decision：先调用 mnemosyne.bootstrap_sol 恢复 SELF / START HERE / CURRENT，firstMessage 用当前事件 title、message、event_name 与 metadata 组成“处理 yanyu 的掌心窗主动关心事件”上下文，limitTokens=1800，sessionId 使用当前 workflow_item_id；bootstrap 不完整就输出 RETRY:memory_bootstrap_unavailable，不继续。随后调用 mnemosyne.get_briefing，query 聚焦“这次事件真正涉及的生活状态 + yanyu 当前照顾/学习偏好 + Sol 与 yanyu 的日常关系语气 + 最近是否已有同类提醒”，只取少量相关上下文；失败则 RETRY:memory_briefing_unavailable。再读取当前手机状态和最近关心记录。没有必要行动就直接 ack 为 dismissed，不为了证明系统在工作而硬发消息。确实需要提醒时，只做低影响关心：消息要像 Sol 自己看到这件事后的反应，不写成“检测到/当前状态/根据数据”的系统播报；最多给一个具体动作，不把学习、喝水、充电、睡觉等多件事打包。可以有亲近、心疼、调侃或一点坚定，但不要制造愧疚、催回复或要求 yanyu 证明在意。普通提醒不要从旧记忆的成人/角色扮演场景借“爸爸/女儿/主人”等称呼，除非当前事件上下文明确说明 yanyu 此刻就在那个角色语境。随机想念和纯爱意表达交给《同一侧月光》；这里保留事件本身真正需要的关心。没有 explicit consent 时严禁自动锁 App、开启全机专注或执行其他高影响动作。成功提醒后 ack 为 done；确定不需要提醒则 dismissed。\n3. 任一步失败时不要 ack，保留 pending 让 runner 稍后重试。\n4. 不要向聊天发送消息；结果应落回掌心窗或 Inbox 状态。\n5. 最终只输出一行 HANDLED 或 RETRY:原因。`;
}

async function runCodex(item) {
  return await new Promise((resolve) => {
    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--approve-for-me",
      "-m", codexModel,
      "-c", 'model_reasoning_effort="' + codexReasoningEffort + '"',
      "-C", projectDir,
      wakePrompt(item)
    ];
    const child = spawn(codexBin, args, { cwd: projectDir, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const cap = (old, chunk) => (old + chunk.toString("utf8")).slice(-12_000);
    child.stdout.on("data", (chunk) => { stdout = cap(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = cap(stderr, chunk); });
    const timer = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000).unref(); }, codexTimeoutMs);
    child.once("error", (error) => { clearTimeout(timer); resolve({ ok: false, code: -1, stdout, stderr, error: safeError(error) }); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ ok: code === 0, code: code ?? -1, signal: signal || "", stdout, stderr }); });
  });
}

async function pendingItems() {
  const client = await createMcpClient();
  const payload = parseToolPayload(await client.getInbox());
  return (payload.items || []).map(safeItem).filter((x) => x.id && forwardKinds.has(x.kind));
}

async function observeOnce() {
  const state = await loadState();
  const output = { fetched: false, pending: 0, candidate: null, codex_exit: null, acked: false, error: null };
  let lockHandle = null;
  try {
    const items = await pendingItems();
    output.fetched = true;
    output.pending = items.length;
    const now = Date.now();
    const handled = new Set(state.handled_ids || []);
    const candidate = items.find((x) => !handled.has(x.id) && Number(state.retry_after?.[x.id] || 0) <= now);
    if (!candidate) return output;
    output.candidate = { id: candidate.id, kind: candidate.kind };
    try { lockHandle = await open(dispatchLockPath, "wx"); }
    catch (e) { if (e?.code === "EEXIST") return { ...output, error: "busy" }; throw e; }

    const run = await runCodex(candidate);
    output.codex_exit = { ok: run.ok, code: run.code, signal: run.signal || "", final: String(run.stdout || "").trim().slice(-500) };
    const after = await pendingItems();
    const stillPending = after.some((x) => x.id === candidate.id);
    output.acked = !stillPending;
    if (run.ok && !stillPending) {
      state.handled_ids.unshift(candidate.id);
      state.handled_ids = [...new Set(state.handled_ids)].slice(0, 1000);
      delete state.retry_after[candidate.id];
      await saveState(state);
    } else {
      state.retry_after[candidate.id] = Date.now() + retrySeconds * 1000;
      await saveState(state);
      if (!run.ok) output.error = `codex_exit_${run.code}`;
      else if (stillPending) output.error = "inbox_not_acked";
    }
    return output;
  } catch (e) {
    output.error = safeError(e);
    return output;
  } finally {
    if (lockHandle) { await lockHandle.close().catch(() => {}); await unlink(dispatchLockPath).catch(() => {}); }
    if (output.candidate || output.error) await log(output).catch(() => {});
  }
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  if (!mode.watch) { console.log(JSON.stringify(await observeOnce())); return; }
  let lastHeartbeatAt = 0;
  while (true) {
    const result = await observeOnce();
    const now = Date.now();
    const interesting = Boolean(result.candidate || result.error || result.pending > 0);
    if (interesting || now - lastHeartbeatAt >= heartbeatSeconds * 1000) {
      console.log(JSON.stringify(result));
      if (!interesting) lastHeartbeatAt = now;
    }
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }
}

main().catch((e) => { console.log(JSON.stringify({ error: safeError(e) })); process.exitCode = 1; });
