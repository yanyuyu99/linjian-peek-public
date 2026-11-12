import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from linjian_server import State, whisper_text_from_completed_command  # noqa: E402


class CompanionWhisperTests(unittest.TestCase):
    def make_state(self, root: str) -> State:
        env = {
            "LINJIAN_TOKEN": "test-token",
            "LINJIAN_DATA_DIR": root,
            "LINJIAN_KEEP": "3",
        }
        with patch.dict(os.environ, env, clear=False):
            return State()

    def test_notification_message_becomes_candidate(self):
        cmd = {
            "status": "completed",
            "action": "send_notification",
            "payload": {"message": "去喝两口水，再回来。"},
        }
        self.assertEqual(whisper_text_from_completed_command(cmd), "去喝两口水，再回来。")

    def test_background_query_never_becomes_candidate(self):
        cmd = {
            "status": "completed",
            "action": "get_life_state",
            "payload": {"message": "internal"},
        }
        self.assertEqual(whisper_text_from_completed_command(cmd), "")

    def test_companion_diary_reply_becomes_candidate(self):
        cmd = {
            "status": "completed",
            "action": "add_diary_annotation",
            "payload": {
                "created_by": "companion",
                "annotation_text": "拳头收到了，忏悔也补在页边了。",
            },
        }
        self.assertEqual(
            whisper_text_from_completed_command(cmd),
            "拳头收到了，忏悔也补在页边了。",
        )

    def test_peek_reply_updates_whisper(self):
        with tempfile.TemporaryDirectory() as td:
            state = self.make_state(td)
            (state.shots_dir / "peek_123.jpg").write_bytes(b"fake-image")
            state.add_peek_reply({"content": "看到了，别再偷偷摸鱼。", "author": "Sol"})
            whisper = state.companion_state["whisper"]
            self.assertEqual(whisper["content"], "看到了，别再偷偷摸鱼。")
            self.assertEqual(whisper["author"], "Sol")


if __name__ == "__main__":
    unittest.main()
