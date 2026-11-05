import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from workflow_engine import WorkflowEngine  # noqa: E402


class WorkflowEngineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.phone_calls = []
        self.activity_calls = []
        self.engine = WorkflowEngine(
            Path(self.tmp.name),
            phone_command=lambda x: self.phone_calls.append(x) or {"queued": True},
            activity_event=lambda x: self.activity_calls.append(x) or x,
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_library_departure_rule(self):
        out = self.engine.emit_event(
            "chat.intent.leave_for_study",
            {"destination": "library"},
            event_id="leave-1",
        )
        self.assertEqual(out["fired_count"], 1)
        self.assertEqual(self.phone_calls[0]["action"], "send_notification")
        inbox = self.engine.list_inbox(kind="departure_check")
        self.assertEqual(len(inbox), 1)
        self.assertIn("手机、钥匙、水、线", inbox[0]["message"])

    def test_same_event_is_idempotent(self):
        self.engine.emit_event("diary.annotation.created", {"entry_id": "e1"}, event_id="anno-1")
        out = self.engine.emit_event("diary.annotation.created", {"entry_id": "e1"}, event_id="anno-1")
        self.assertEqual(out["results"][0]["reason"], "event_already_processed")
        self.assertEqual(len(self.engine.list_inbox(kind="reply_to_diary_annotation")), 1)

    def test_cooldown(self):
        self.engine.emit_event("chat.intent.leave_for_study", {}, event_id="leave-a")
        out = self.engine.emit_event("chat.intent.leave_for_study", {}, event_id="leave-b")
        self.assertEqual(out["results"][0]["reason"], "cooldown")

    def test_high_impact_phone_action_requires_explicit_consent(self):
        self.engine.upsert_rule({
            "id": "lock_test",
            "name": "lock test",
            "enabled": True,
            "trigger": {"event": "test.lock"},
            "conditions": [],
            "cooldown_minutes": 0,
            "actions": [{
                "type": "phone_command",
                "action": "screen_break_app",
                "app": "小红书",
                "package": "com.xingin.xhs",
                "payload": {"duration_minutes": 20},
            }],
        })
        blocked = self.engine.emit_event("test.lock", {}, event_id="lock-1")
        self.assertEqual(blocked["results"][0]["status"], "blocked")
        self.assertEqual(blocked["results"][0]["actions"][0]["error"], "explicit_consent_required")
        allowed = self.engine.emit_event("test.lock", {"explicit_consent": True}, event_id="lock-2")
        self.assertEqual(allowed["results"][0]["status"], "completed")
        self.assertEqual(self.phone_calls[-1]["action"], "screen_break_app")

    def test_template_preserves_event_values(self):
        out = self.engine.emit_event(
            "app.overuse.detected",
            {"app_name": "小红书", "package": "com.xingin.xhs", "minutes": 37},
            event_id="app-1",
        )
        self.assertEqual(out["fired_count"], 1)
        self.assertIn("37", self.phone_calls[-1]["payload"]["message"])
        inbox = self.engine.list_inbox(kind="companion_decision")
        self.assertEqual(inbox[0]["metadata"]["minutes"], 37)

    def test_persistence(self):
        self.engine.emit_event("diary.annotation.created", {"entry_id": "e2"}, event_id="anno-persist")
        engine2 = WorkflowEngine(Path(self.tmp.name))
        self.assertEqual(len(engine2.list_inbox(kind="reply_to_diary_annotation")), 1)
        self.assertTrue(engine2.get_rule("library_departure_check"))


if __name__ == "__main__":
    unittest.main()
