"""
Speech-to-Text utilities.

Currently implements local Vosk-based transcription and is structured to
allow adding other backends (e.g., OpenAI Whisper) later without changing
call sites in the app.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional
import io
import json
import os
import wave


# ---- Vosk model management -------------------------------------------------
_vosk_models_by_path: Dict[str, object] = {}


def find_vosk_model_path(requested: Optional[str] = None) -> Optional[Path]:
    """Locate a Vosk model directory.

    Priority order:
    1) VOSK_MODEL_PATH environment variable
    2) Known local paths in the repository (large preferred for accuracy)

    Args:
        requested: A hint for the model to pick (e.g., "auto", "small", "large").

    Returns:
        Path to the model directory, or None if not found.
    """
    # Highest priority: environment override
    env_path = os.getenv("VOSK_MODEL_PATH")
    if env_path:
        p = Path(env_path)
        if p.exists():
            return p

    requested = (requested or "auto").lower()
    small_candidates = [
        Path("static/models/vosk-model-small-en-us-0.15"),
        Path("assets/speech_to_text/vosk-model-small-en-us-0.15"),
    ]
    large_candidates = [
        Path("static/models/vosk-model-en-us-0.22"),
        Path("assets/speech_to_text/vosk-model-en-us-0.22"),
    ]

    candidates: List[Path] = []
    if requested in ("large", "big", "0.22", "en-us-0.22"):
        candidates = large_candidates + small_candidates
    elif requested in ("small", "0.15", "small-en-us-0.15"):
        candidates = small_candidates + large_candidates
    else:  # auto: prefer large for better accuracy if available
        candidates = large_candidates + small_candidates
    for c in candidates:
        if c.exists():
            return c
    return None


def load_vosk_model(requested: Optional[str] = None):
    """Load and cache a Vosk model instance, returning it or None on failure."""
    try:
        import vosk  # type: ignore
        model_path = find_vosk_model_path(requested)
        if not model_path:
            return None
        key = str(model_path.resolve())
        if key not in _vosk_models_by_path:
            print(f"Loading Vosk model from: {model_path}")
            _vosk_models_by_path[key] = vosk.Model(str(model_path))
        return _vosk_models_by_path[key]
    except Exception as e:
        print(f"Vosk model init failed: {e}")
        return None


# ---- Transcription ---------------------------------------------------------
class STTError(Exception):
    pass


def transcribe_wav_bytes_vosk(wav_bytes: bytes, model: Optional[str] = "auto") -> str:
    """Transcribe a mono 16 kHz 16-bit PCM WAV byte stream using Vosk.

    Accepts any WAV; best results with mono 16kHz 16-bit PCM. Non-optimal
    encodings are tolerated but may impact accuracy.
    """
    vosk_model = load_vosk_model(model)
    if vosk_model is None:
        raise STTError(
            "Vosk model not available. Set VOSK_MODEL_PATH env var or place a model at one of the known locations."
        )

    import vosk  # type: ignore

    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        # We'll accept non-mono/non-16bit too, but warn in logs if needed.
        sample_rate = wf.getframerate()
        rec = vosk.KaldiRecognizer(vosk_model, sample_rate)
        while True:
            buf = wf.readframes(4000)
            if len(buf) == 0:
                break
            rec.AcceptWaveform(buf)
        final = rec.FinalResult()
        try:
            j = json.loads(final)
            return j.get("text", "")
        except Exception:
            return ""


def transcribe_wav_bytes(
    wav_bytes: bytes, *, backend: str = "vosk", model: Optional[str] = "auto"
) -> str:
    """Transcribe WAV bytes using the specified backend (default: Vosk).

    Args:
        wav_bytes: WAV file content as bytes.
        backend: "vosk" for local model; future values may include "whisper".
        model: Backend-specific model hint (e.g., "auto", "small", "large").

    Returns:
        Transcribed text.
    """
    backend = (backend or "vosk").lower()
    if backend == "vosk":
        return transcribe_wav_bytes_vosk(wav_bytes, model)
    # Placeholder for future Whisper integration
    raise STTError(f"Unsupported STT backend: {backend}")
