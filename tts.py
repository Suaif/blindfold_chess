import base64
import subprocess
import tempfile
from pathlib import Path
from typing import Dict, Optional


class TTSGenerationError(Exception):
    """Raised when Piper fails to synthesize audio."""


class PiperTTS:
    """Lightweight helper around Piper.exe for local text-to-speech."""

    def __init__(self, default_voice: str = "bryce"):
        self.project_root = Path(__file__).resolve().parent
        self.piper_dir = self.project_root / "assets" / "text_to_speech" / "piper"
        self.piper_exe = self.piper_dir / "piper.exe"
        self.voices: Dict[str, Path] = {
            "bryce": Path("bryce-medium") / "en_US-bryce-medium.onnx",
            "hfc_male": Path("hfc_male-medium") / "en_US-hfc_male-medium.onnx",
        }

        if default_voice not in self.voices:
            default_voice = "bryce"
        self.default_voice = default_voice

    def synthesize(self, text: str, voice: Optional[str] = None) -> bytes:
        """Generate spoken audio for the given text and return raw WAV bytes."""
        if not text or not text.strip():
            raise ValueError("Cannot synthesize empty text.")

        if not self.piper_exe.exists():
            raise TTSGenerationError(f"Piper executable not found at {self.piper_exe}")

        voice_name = voice or self.default_voice
        if voice_name not in self.voices:
            raise TTSGenerationError(f"Voice '{voice_name}' is not configured.")

        model_path = self.piper_dir / self.voices[voice_name]
        if not model_path.exists():
            raise TTSGenerationError(f"Piper model not found at {model_path}")

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_file:
            tmp_path = Path(tmp_file.name)

        try:
            cmd = [
                str(self.piper_exe),
                "-m",
                str(model_path),
                "-f",
                str(tmp_path),
            ]
            subprocess.run(
                cmd,
                input=text.encode("utf-8"),
                check=True,
                cwd=self.piper_dir,
            )
            return tmp_path.read_bytes()
        except subprocess.CalledProcessError as exc:
            raise TTSGenerationError(f"Piper synthesis failed: {exc}") from exc
        finally:
            try:
                tmp_path.unlink()
            except FileNotFoundError:
                pass


_tts_engine: Optional[PiperTTS] = None


def get_tts_engine() -> PiperTTS:
    global _tts_engine
    if _tts_engine is None:
        _tts_engine = PiperTTS()
    return _tts_engine


def synthesize_to_base64(text: str, voice: Optional[str] = None) -> Optional[str]:
    """Return Piper-generated WAV audio as a base64 string, or None on failure."""
    try:
        engine = get_tts_engine()
        audio_bytes = engine.synthesize(text, voice)
        return base64.b64encode(audio_bytes).decode("ascii")
    except (TTSGenerationError, ValueError) as error:
        print(f"TTS synthesis skipped: {error}")
        return None
