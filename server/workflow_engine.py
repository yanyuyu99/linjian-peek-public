#!/usr/bin/env python3
"""Small event-driven workflow/rules engine for 掌心窗.

Design goals:
- stdlib only (matches linjian_server.py)
- durable JSON state under server data/
- exact event triggers + simple conditions
- per-rule cooldown and event-id idempotency
- safe-by-default phone actions
- an inbox for actions that need Sol/model judgment

The engine deliberately does *not* call an LLM. It turns local/semantic events into
safe phone actions and/or durable inbox items that a companion can consume later.
"""
from __future__ import annotations

import calendar
import copy
import json
import re
import time
import uuid
from pathlib import Path
from threading import RLock
from typing import Any, Callable

WORKFLOW_VERSION = "1.0"
RUN_HISTORY_LIMIT = 500
INBOX_LIMIT = 500

# These may run from background/local events without a fresh user confirmation.
AUTO_SAFE_PHONE_ACTIONS = {
    "noop",
    "send_notification",
    "set_alarm",
}

# These are permitted only when the triggering event explicitly carries consent.
EXPLICIT_CONSENT_PHONE_ACTIONS = {
    "trigger_guidian",
    "screen_break_app",
    "end_screen_break",
    "extend_screen_break",
    "open_app",
    "screen_off",
    "start_focus_mode",
    "end_focus_mode",
    "set_focus_plan",
}


def utc_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _read_json(path: Path, fallback: Any) -> Any:
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return copy.deepcopy(fallback)


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _get_path(obj: Any, dotted: str, default: Any = None) -> Any:
    cur = obj
    for part in str(dotted or "").split("."):
        if not part:
            continue
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return default
    return cur


def _truthy(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() not in ("", "0", "false", "no", "off", "none", "null")
    return bool(value)


def _compare(actual: Any, op: str, expected: Any = None) -> bool:
    op = (op or "eq").lower()
    if op == "truthy":
        return _truthy(actual)
    if op == "falsy":
        return not _truthy(actual)
    if op == "exists":
        return actual is not None
    if op == "not_exists":
        return actual is None
    if op == "eq":
        return actual == expected
    if op == "neq":
        return actual != expected
    if op == "contains":
        try:
            return expected in actual
        except Exception:
            return str(expected) in str(actual)
    if op == "not_contains":
        try:
            return expected not in actual
        except Exception:
            return str(expected) not in str(actual)
    if op == "in":
        try:
            return actual in expected
        except Exception:
            return False
    if op in ("gt", "gte", "lt", "lte"):
        try:
            a = float(actual)
            b = float(expected)
        except Exception:
            return False
        return {
            "gt": a > b,
            "gte": a >= b,
            "lt": a < b,
            "lte": a <= b,
        }[op]
    return False


_TEMPLATE = re.compile(r"\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}")


def _render_string(value: str, context: dict) -> str:
    def repl(match: re.Match[str]) -> str:
        hit = _get_path(context, match.group(1), "")
        if isinstance(hit, (dict, list)):
            return json.dumps(hit, ensure_ascii=False)
        return "" if hit is None else str(hit)
    return _TEMPLATE.sub(repl, value)


def _render(value: Any, context: dict) -> Any:
    if isinstance(value, str):
        return _render_string(value, context)
    if isinstance(value, list):
        return [_render(v, context) for v in value]
    if isinstance(value, dict):
        # {"$event": "payload.foo", "default": 30} keeps primitive types.
        if "$event" in value:
            got = _get_path(context, str(value.get("$event") or ""), value.get("default"))
            return value.get("default") if got is None else got
        return {k: _render(v, context) for k, v in value.items()}
    return value


def default_rules() -> list[dict]:
    return [
        {
            "id": "library_departure_check",
            "name": "七秒猫出门检查",
            "enabled": True,
            "trigger": {"event": "chat.intent.leave_for_study"},
            "conditions": [],
            "cooldown_minutes": 10,
            "actions": [
                {
                    "type": "phone_command",
                    "action": "send_notification",
                    "payload": {
                        "title": "出门前先摸一遍",
                        "message": "七秒记忆猫：手机、钥匙、水、线。别只说带了，用手摸一遍再走。",
                    },
                },
                {
                    "type": "inbox",
                    "kind": "departure_check",
                    "title": "七秒猫出门检查已触发",
                    "message": "确认手机、钥匙、水、线；按当天场景再追加电脑、U 型枕、耳机等。",
                },
            ],
        },
        {
            "id": "diary_margin_note_inbox",
            "name": "日记页边纸条",
            "enabled": True,
            "trigger": {"event": "diary.annotation.created"},
            "conditions": [],
            "cooldown_minutes": 0,
            "actions": [
                {
                    "type": "inbox",
                    "kind": "reply_to_diary_annotation",
                    "title": "有新的日记页边纸条",
                    "message": "读取 entry_id={{payload.entry_id}} 的对应段落和批注，结合上下文回应；成功回应后再标记已看。",
                    "metadata": {
                        "entry_id": {"$event": "payload.entry_id", "default": ""},
                        "annotation_id": {"$event": "payload.annotation_id", "default": ""},
                        "book_id": {"$event": "payload.book_id", "default": ""},
                    },
                }
            ],
        },
        {
            "id": "app_overuse_soft_brake",
            "name": "刷手机软刹车",
            "enabled": True,
            "trigger": {"event": "app.overuse.detected"},
            "conditions": [
                {"field": "payload.minutes", "op": "gte", "value": 20},
            ],
            "cooldown_minutes": 30,
            "actions": [
                {
                    "type": "phone_command",
                    "action": "send_notification",
                    "payload": {
                        "title": "先从里面出来一下",
                        "message": "{{payload.app_name}} 已经刷了 {{payload.minutes}} 分钟。先停一下，眼睛和脑子都歇会儿；要继续也先回来跟我说一声。",
                    },
                },
                {
                    "type": "inbox",
                    "kind": "companion_decision",
                    "title": "需要判断是否进一步管束",
                    "message": "{{payload.app_name}} 连续/累计使用达到 {{payload.minutes}} 分钟。先提醒过一次；是否屏幕休息由 Sol 结合当前聊天和状态判断。",
                    "metadata": {
                        "app_name": {"$event": "payload.app_name", "default": ""},
                        "package": {"$event": "payload.package", "default": ""},
                        "minutes": {"$event": "payload.minutes", "default": 0},
                    },
                },
            ],
        },
    ]


class WorkflowEngine:
    def __init__(
        self,
        data_dir: Path,
        phone_command: Callable[[dict], dict] | None = None,
        activity_event: Callable[[dict], dict] | None = None,
    ) -> None:
        self.data_dir = Path(data_dir)
        self.rules_path = self.data_dir / "workflows.json"
        self.runs_path = self.data_dir / "workflow_runs.json"
        self.inbox_path = self.data_dir / "workflow_inbox.json"
        self.lock = RLock()
        self.phone_command = phone_command
        self.activity_event = activity_event

        self.rules = _read_json(self.rules_path, default_rules())
        self.runs = _read_json(self.runs_path, [])
        self.inbox = _read_json(self.inbox_path, [])
        if not isinstance(self.rules, list):
            self.rules = default_rules()
        if not isinstance(self.runs, list):
            self.runs = []
        if not isinstance(self.inbox, list):
            self.inbox = []
        # Seed defaults only for missing IDs; preserve user edits.
        by_id = {str(x.get("id")): x for x in self.rules if isinstance(x, dict)}
        changed = False
        for rule in default_rules():
            if rule["id"] not in by_id:
                self.rules.append(rule)
                changed = True
        if not self.rules_path.exists() or changed:
            self._save_rules()

    def _save_rules(self) -> None:
        _write_json(self.rules_path, self.rules)

    def _save_runs(self) -> None:
        _write_json(self.runs_path, self.runs[:RUN_HISTORY_LIMIT])

    def _save_inbox(self) -> None:
        _write_json(self.inbox_path, self.inbox[:INBOX_LIMIT])

    def list_rules(self, enabled_only: bool = False) -> list[dict]:
        with self.lock:
            items = copy.deepcopy(self.rules)
        if enabled_only:
            items = [x for x in items if x.get("enabled") is True]
        return items

    def get_rule(self, rule_id: str) -> dict | None:
        with self.lock:
            hit = next((x for x in self.rules if x.get("id") == rule_id), None)
            return copy.deepcopy(hit) if hit else None

    def upsert_rule(self, rule: dict) -> dict:
        clean = self.validate_rule(rule)
        with self.lock:
            idx = next((i for i, x in enumerate(self.rules) if x.get("id") == clean["id"]), None)
            if idx is None:
                self.rules.append(clean)
            else:
                self.rules[idx] = clean
            self._save_rules()
        return copy.deepcopy(clean)

    def set_enabled(self, rule_id: str, enabled: bool) -> dict | None:
        with self.lock:
            hit = next((x for x in self.rules if x.get("id") == rule_id), None)
            if not hit:
                return None
            hit["enabled"] = bool(enabled)
            hit["updated_at"] = utc_iso()
            self._save_rules()
            return copy.deepcopy(hit)

    def validate_rule(self, rule: dict) -> dict:
        if not isinstance(rule, dict):
            raise ValueError("rule must be object")
        rid = str(rule.get("id") or "").strip()
        if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,80}", rid):
            raise ValueError("rule.id must match [a-zA-Z0-9_.-]{1,80}")
        trigger = rule.get("trigger") or {}
        if not isinstance(trigger, dict):
            raise ValueError("rule.trigger must be object")
        events = trigger.get("events") or ([trigger.get("event")] if trigger.get("event") else [])
        events = [str(x).strip() for x in events if str(x or "").strip()]
        if not events:
            raise ValueError("rule.trigger requires event or events")
        actions = rule.get("actions") or []
        if not isinstance(actions, list) or not actions:
            raise ValueError("rule.actions must be non-empty array")
        if len(actions) > 12:
            raise ValueError("rule.actions max 12")
        conditions = rule.get("conditions") or []
        if not isinstance(conditions, list) or len(conditions) > 20:
            raise ValueError("rule.conditions max 20")
        clean = copy.deepcopy(rule)
        clean["id"] = rid
        clean["name"] = str(clean.get("name") or rid)[:100]
        clean["enabled"] = bool(clean.get("enabled", True))
        clean["trigger"] = {"events": events}
        clean["conditions"] = conditions
        clean["actions"] = actions
        clean["cooldown_minutes"] = max(0, min(10080, int(clean.get("cooldown_minutes") or 0)))
        clean["updated_at"] = utc_iso()
        clean.setdefault("created_at", clean["updated_at"])
        return clean

    def _matches_trigger(self, rule: dict, event_name: str) -> bool:
        trigger = rule.get("trigger") or {}
        events = trigger.get("events") or ([trigger.get("event")] if trigger.get("event") else [])
        return event_name in events or "*" in events

    def _matches_conditions(self, rule: dict, context: dict) -> tuple[bool, str]:
        for idx, condition in enumerate(rule.get("conditions") or []):
            if not isinstance(condition, dict):
                return False, f"condition_{idx}_invalid"
            actual = _get_path(context, str(condition.get("field") or ""), None)
            if not _compare(actual, str(condition.get("op") or "eq"), condition.get("value")):
                return False, f"condition_{idx}_not_met"
        return True, ""

    def _last_run_epoch(self, rule_id: str) -> float:
        for run in self.runs:
            if run.get("rule_id") != rule_id or run.get("status") not in ("completed", "partial"):
                continue
            try:
                return float(calendar.timegm(time.strptime(run.get("created_at") or "", "%Y-%m-%dT%H:%M:%SZ")))
            except Exception:
                return 0.0
        return 0.0

    def _event_already_processed(self, rule_id: str, event_id: str) -> bool:
        if not event_id:
            return False
        return any(r.get("rule_id") == rule_id and r.get("event_id") == event_id for r in self.runs[:RUN_HISTORY_LIMIT])

    def emit_event(
        self,
        event_name: str,
        payload: dict | None = None,
        *,
        device_id: str = "android-phone",
        source: str = "workflow",
        event_id: str = "",
    ) -> dict:
        event_name = str(event_name or "").strip()
        if not event_name:
            raise ValueError("event_name required")
        payload = dict(payload or {})
        event_id = str(event_id or payload.get("event_id") or uuid.uuid4())
        event = {
            "id": event_id,
            "name": event_name,
            "payload": payload,
            "device_id": device_id or "android-phone",
            "source": source or "workflow",
            "created_at": utc_iso(),
        }
        context = {"event": event, "payload": payload, "device_id": event["device_id"], "source": event["source"]}

        fired: list[dict] = []
        with self.lock:
            rules = copy.deepcopy(self.rules)
        for rule in rules:
            if not rule.get("enabled") or not self._matches_trigger(rule, event_name):
                continue
            if self._event_already_processed(rule["id"], event_id):
                fired.append({"rule_id": rule["id"], "status": "skipped", "reason": "event_already_processed"})
                continue
            ok, reason = self._matches_conditions(rule, context)
            if not ok:
                fired.append({"rule_id": rule["id"], "status": "skipped", "reason": reason})
                continue
            cooldown = int(rule.get("cooldown_minutes") or 0)
            last = self._last_run_epoch(rule["id"])
            if cooldown > 0 and last > 0 and time.time() - last < cooldown * 60:
                fired.append({"rule_id": rule["id"], "status": "skipped", "reason": "cooldown"})
                continue
            fired.append(self._execute_rule(rule, event, context))
        return {"ok": True, "event": event, "results": fired, "fired_count": sum(1 for x in fired if x.get("status") in ("completed", "partial"))}

    def _execute_rule(self, rule: dict, event: dict, context: dict) -> dict:
        run = {
            "id": str(uuid.uuid4()),
            "created_at": utc_iso(),
            "rule_id": rule.get("id"),
            "rule_name": rule.get("name"),
            "event_name": event.get("name"),
            "event_id": event.get("id"),
            "device_id": event.get("device_id"),
            "source": event.get("source"),
            "status": "completed",
            "actions": [],
        }
        success = 0
        for index, raw_action in enumerate(rule.get("actions") or []):
            action = _render(raw_action, context)
            result = self._execute_action(action, event, rule, run)
            result["index"] = index
            run["actions"].append(result)
            if result.get("ok"):
                success += 1
        if success == 0 and run["actions"]:
            run["status"] = "blocked"
        elif success < len(run["actions"]):
            run["status"] = "partial"
        with self.lock:
            self.runs.insert(0, run)
            self.runs = self.runs[:RUN_HISTORY_LIMIT]
            self._save_runs()
        return copy.deepcopy(run)

    def _execute_action(self, action: dict, event: dict, rule: dict, run: dict) -> dict:
        if not isinstance(action, dict):
            return {"ok": False, "type": "invalid", "error": "action_not_object"}
        typ = str(action.get("type") or "").strip()
        if typ == "inbox":
            item = {
                "id": str(uuid.uuid4()),
                "created_at": utc_iso(),
                "status": "pending",
                "kind": str(action.get("kind") or "workflow_task")[:80],
                "title": str(action.get("title") or rule.get("name") or "Workflow task")[:160],
                "message": str(action.get("message") or "")[:2000],
                "metadata": action.get("metadata") if isinstance(action.get("metadata"), dict) else {},
                "rule_id": rule.get("id"),
                "run_id": run.get("id"),
                "event_id": event.get("id"),
                "event_name": event.get("name"),
                "device_id": event.get("device_id"),
            }
            with self.lock:
                self.inbox.insert(0, item)
                self.inbox = self.inbox[:INBOX_LIMIT]
                self._save_inbox()
            return {"ok": True, "type": typ, "inbox_id": item["id"]}

        if typ == "activity_event":
            if not self.activity_event:
                return {"ok": False, "type": typ, "error": "activity_callback_unavailable"}
            data = action.get("event") if isinstance(action.get("event"), dict) else {}
            data = {**data, "device_id": data.get("device_id") or event.get("device_id"), "source": data.get("source") or "workflow"}
            try:
                out = self.activity_event(data)
                return {"ok": True, "type": typ, "result": out}
            except Exception as exc:
                return {"ok": False, "type": typ, "error": str(exc)[:300]}

        if typ == "phone_command":
            phone_action = str(action.get("action") or "").strip()
            explicit = _truthy((event.get("payload") or {}).get("explicit_consent"))
            if phone_action not in AUTO_SAFE_PHONE_ACTIONS:
                if phone_action not in EXPLICIT_CONSENT_PHONE_ACTIONS:
                    return {"ok": False, "type": typ, "action": phone_action, "error": "phone_action_not_allowed"}
                if not explicit:
                    return {"ok": False, "type": typ, "action": phone_action, "error": "explicit_consent_required"}
            if not self.phone_command:
                return {"ok": False, "type": typ, "action": phone_action, "error": "phone_callback_unavailable"}
            payload = action.get("payload") if isinstance(action.get("payload"), dict) else {}
            command = {
                "device_id": event.get("device_id") or "android-phone",
                "action": phone_action,
                "app": str(action.get("app") or payload.get("app") or ""),
                "package": str(action.get("package") or payload.get("package") or ""),
                "payload": payload,
            }
            try:
                out = self.phone_command(command)
                return {"ok": True, "type": typ, "action": phone_action, "result": out}
            except Exception as exc:
                return {"ok": False, "type": typ, "action": phone_action, "error": str(exc)[:300]}

        return {"ok": False, "type": typ or "unknown", "error": "unknown_action_type"}

    def list_runs(self, limit: int = 50, rule_id: str = "") -> list[dict]:
        with self.lock:
            items = copy.deepcopy(self.runs)
        if rule_id:
            items = [x for x in items if x.get("rule_id") == rule_id]
        return items[: max(1, min(500, int(limit or 50)))]

    def list_inbox(self, limit: int = 50, status: str = "pending", kind: str = "") -> list[dict]:
        with self.lock:
            items = copy.deepcopy(self.inbox)
        if status and status != "all":
            items = [x for x in items if x.get("status") == status]
        if kind:
            items = [x for x in items if x.get("kind") == kind]
        return items[: max(1, min(500, int(limit or 50)))]

    def ack_inbox(self, item_id: str, status: str = "done", note: str = "") -> dict | None:
        with self.lock:
            hit = next((x for x in self.inbox if x.get("id") == item_id), None)
            if not hit:
                return None
            hit["status"] = status or "done"
            hit["handled_at"] = utc_iso()
            if note:
                hit["handle_note"] = str(note)[:500]
            self._save_inbox()
            return copy.deepcopy(hit)
