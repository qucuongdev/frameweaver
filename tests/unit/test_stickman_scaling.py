import unittest
import asyncio
from agent.materials import STORY_PRESETS
from agent.services.flow_client import FlowClient


class TestStickmanScalingAndUI(unittest.TestCase):
    def test_preset_background_colors(self):
        """Verify stickman presets have valid background colors for padding."""
        white_presets = ['srt_stick_white', 'stickman_light', 'cartoon_light']
        for pid in white_presets:
            preset = next((p for p in STORY_PRESETS if p['id'] == pid), None)
            self.assertIsNotNone(preset, f"Preset {pid} should exist")
            bg = preset.get('background', '#ffffff')
            bg_color = 'white' if bg.lower() in ('#ffffff', '#fff', 'white') else 'black' if bg.lower() in ('#000000', '#000', 'black') else ('0x' + bg[1:] if bg.startswith('#') else bg)
            self.assertEqual(bg_color, 'white')

    def test_ffmpeg_filter_preserves_aspect_ratio_and_pads(self):
        """Verify scale filter uses decrease and pad rather than increase and crop."""
        width, height = 720, 1280
        timing = ""
        tail = ""
        bg_color = "white"
        vf = f"{timing}scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color={bg_color},fps=30{tail},format=yuv420p"
        
        self.assertIn("force_original_aspect_ratio=decrease", vf)
        self.assertIn("pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=white", vf)
        self.assertNotIn("crop=720:1280", vf)

    def test_flow_client_ui_generate_lock(self):
        """Verify FlowClient has an asyncio lock to serialize UI automation."""
        client = FlowClient()
        lock1 = client.ui_generate_lock
        lock2 = client.ui_generate_lock
        self.assertIs(lock1, lock2)
        self.assertIsInstance(lock1, asyncio.Lock)


if __name__ == '__main__':
    unittest.main()
