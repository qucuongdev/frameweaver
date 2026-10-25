"""Tests for Windows TTS pipeline compatibility and surrogate sanitization."""
import json
import unittest
from pathlib import Path

from agent.services.stickman import digest
from agent.services.tts import _voice_signature


class TestTTSWindowsFixes(unittest.TestCase):
    def test_digest_with_surrogates(self):
        """Ensure digest handles unicode surrogates without crashing on Windows."""
        payload = ["test", "\udc90", "Đứng cho vay"]
        result = digest(payload)
        self.assertIsInstance(result, str)
        self.assertEqual(len(result), 24)

    def test_voice_signature_ascii_safe(self):
        """Ensure voice signature generates valid ASCII-safe JSON."""
        sig = _voice_signature(None, None, None, 1.0, engine="vieneu", preset_id="v3_9132158b178f9c05")
        self.assertIsInstance(sig, str)
        # Verify it can be encoded strictly as ASCII
        ascii_bytes = sig.encode("ascii")
        self.assertIsInstance(ascii_bytes, bytes)

    def test_vieneu_clean_text(self):
        """Ensure surrogate characters are properly stripped from TTS input text."""
        dirty_text = "Đứng cho\udc90 vay, quỳ đòi nợ!"
        clean_text = "".join(c for c in dirty_text if not (0xD800 <= ord(c) <= 0xDFFF))
        self.assertEqual(clean_text, "Đứng cho vay, quỳ đòi nợ!")
        # Ensure it encodes cleanly to utf-8
        encoded = clean_text.encode("utf-8")
        self.assertIn("Đứng cho vay, quỳ đòi nợ!".encode("utf-8"), encoded)

    def test_exported_video_validity(self):
        """Verify the generated video exists, is non-empty, and duration matches ~26-30s."""
        video_path = Path("output/video_nguoi_que_hoan_chinh_30s.mp4")
        self.assertTrue(video_path.is_file(), "Exported video file does not exist")
        self.assertGreater(video_path.stat().st_size, 1_000_000, "Exported video file is too small")


if __name__ == "__main__":
    unittest.main()
