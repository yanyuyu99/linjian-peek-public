# Workflow Inbox watcher

This is the event-driven bridge from the 掌心窗 Workflow Inbox to the existing local Solune/cli-chat-bridge daemon.

It is **not** a ChatGPT scheduled task. It is a small long-running local watcher.

## Modes

```powershell
node .\workflow-inbox-watcher.mjs --once
node .\workflow-inbox-watcher.mjs --watch
node .\workflow-inbox-watcher.mjs --once --live
node .\workflow-inbox-watcher.mjs --watch --live
```

Without `--live`, it is dry-run and never forwards anything to Sol.

Default polling interval is 8 seconds. Override with:

```powershell
$env:WORKFLOW_POLL_SECONDS = "8"
```

By default it only forwards inbox kinds that actually need Sol's judgment:

- `reply_to_diary_annotation`
- `companion_decision`

Override with a comma-separated list:

```powershell
$env:WORKFLOW_FORWARD_KINDS = "reply_to_diary_annotation,companion_decision"
```

It reuses the existing cli-chat-bridge daemon files:

- `~/.cli-bridge/daemon-endpoint.json`
- `~/.cli-bridge/account.json`

Set `CLI_BRIDGE_DIR` to use a different bridge directory, or set
`CLI_BRIDGE_ENDPOINT` and `CLI_BRIDGE_ACCOUNT` to override the files separately.
The watcher reads these local files to authenticate to the existing localhost
bridge; it never logs their contents.

The watcher stores only IDs it already forwarded in `workflow-watcher-state.json`. It does not acknowledge a Workflow Inbox item before Sol actually handles it. The wake prompt instructs Sol to call `ack_workflow_inbox` with `done` or `dismissed` after handling.

## Safety

The watcher itself never locks apps, starts full-phone Focus, or operates the phone. High-impact actions remain decisions made by Sol after reading current context, and the Workflow Engine only auto-executes those when an incoming event explicitly carries `explicit_consent=true`.
