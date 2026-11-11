import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from linjian_server import State  # noqa: E402


class PeekReplyStateTests(unittest.TestCase):
    def make_state(self, root: str) -> State:
        env = {
            "LINJIAN_TOKEN": "test-token",
            "LINJIAN_DATA_DIR": root,
            "LINJIAN_KEEP": "3",
        }
        with patch.dict(os.environ, env, clear=False):
            return State()

    def test_reply_defaults_to_latest_screenshot(self):
        with tempfile.TemporaryDirectory() as td:
            state = self.make_state(td)
            shot = state.shots_dir / "peek_123.jpg"
            shot.write_bytes(b"fake-image")
            reply = state.add_peek_reply({"content": "看到了，继续学习。", "author": "Sol"})
            self.assertEqual(reply["filename"], "peek_123.jpg")
            history = state.list_peek_history(10)
            self.assertEqual(history[0]["reply"]["content"], "看到了，继续学习。")
            self.assertEqual(history[0]["reply"]["author"], "Sol")

    def test_reply_rejects_missing_screenshot(self):
        with tempfile.TemporaryDirectory() as td:
            state = self.make_state(td)
            with self.assertRaisesRegex(ValueError, "peek_not_found"):
                state.add_peek_reply({"filename": "peek_missing.png", "content": "hello"})


if __name__ == "__main__":
    unittest.main()
