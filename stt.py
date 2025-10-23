"""
Speech-to-Text utilities.

Implements a unified AudioTranscriber interface with concrete backends:
- VoskTranscriber: Local Vosk-based transcription
- WhisperTranscriber: Faster-Whisper (CUDA-accelerated if available)

The class-based design makes it easy to add new backends and manage
backend-specific configuration without changing call sites.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Dict, List, Optional
import io
import json
import os
import wave
import tempfile
import vosk
import ctranslate2
from faster_whisper import WhisperModel


# ---- Exception class -------------------------------------------------------
class STTError(Exception):
    """Base exception for speech-to-text errors."""
    pass


# ---- Abstract base class ---------------------------------------------------
class AudioTranscriber(ABC):
    """Abstract base class for audio transcription backends."""
    
    @abstractmethod
    def transcribe(self, wav_bytes: bytes) -> str:
        """Transcribe WAV bytes to text.
        
        Args:
            wav_bytes: WAV file content as bytes.
            
        Returns:
            Transcribed text as a string.
            
        Raises:
            STTError: If transcription fails.
        """
        pass
    
    @abstractmethod
    def get_backend_name(self) -> str:
        """Return the backend identifier (e.g., 'vosk', 'whisper')."""
        pass


# ---- Model caching (class-level) -------------------------------------------
_vosk_models_by_path: Dict[str, object] = {}
_whisper_models_by_path: Dict[str, object] = {}


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


# ---- Vosk Transcriber ------------------------------------------------------
class VoskTranscriber(AudioTranscriber):
    """Vosk-based local speech-to-text transcriber."""
    
    def __init__(self, model_hint: str = "auto"):
        """Initialize Vosk transcriber with a model hint.
        
        Args:
            model_hint: Model selection hint ("auto", "small", "large").
        """
        self.model_hint = model_hint
        self.model = load_vosk_model(model_hint)
        if self.model is None:
            raise STTError(
                "Vosk model not available. Set VOSK_MODEL_PATH env var or place a model at one of the known locations."
            )
    
    def transcribe(self, wav_bytes: bytes) -> str:
        """Transcribe a mono 16 kHz 16-bit PCM WAV byte stream using Vosk.

        Accepts any WAV; best results with mono 16kHz 16-bit PCM. Non-optimal
        encodings are tolerated but may impact accuracy.
        """
        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            # We'll accept non-mono/non-16bit too, but warn in logs if needed.
            sample_rate = wf.getframerate()
            rec = vosk.KaldiRecognizer(self.model, sample_rate)
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
    
    def get_backend_name(self) -> str:
        return "vosk"


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


# ---- Faster-Whisper (Whisper) backend -------------------------------------
def _whisper_device_and_compute_type() -> Dict[str, str]:
    """Determine device (cuda/cpu) and a reasonable compute_type.

    - Prefer CUDA if available; use float16 for best speed/accuracy tradeoff.
    - Fall back to CPU with int8 for speed on CPUs without AVX512.
    """
    try:
        if getattr(ctranslate2, "get_cuda_device_count", None):
            if ctranslate2.get_cuda_device_count() > 0:
                return {"device": "cuda", "compute_type": "float16"}
    except Exception:
        pass
    # CPU fallback
    return {"device": "cpu", "compute_type": "int8"}


def find_whisper_model_path(requested: Optional[str] = None) -> Optional[Path]:
    """Locate a Faster-Whisper model directory from local assets.

    Supports 'small' and 'medium' English models already checked in under
    assets/speech_to_text/.
    """
    requested = (requested or "small").lower()
    # Known local paths
    small_candidates = [
        Path("assets/speech_to_text/models--guillaumekln--faster-whisper-small.en/snapshots/4e49ce629e3fa4c3da596c602b212cb026910443"),
    ]
    medium_candidates = [
        Path("assets/speech_to_text/models--guillaumekln--faster-whisper-medium.en/snapshots/83a3b718775154682e5f775bc5d5fc961d2350ce"),
    ]

    candidates: List[Path]
    if requested in ("medium", "md"):
        candidates = medium_candidates + small_candidates
    else:
        candidates = small_candidates + medium_candidates

    for c in candidates:
        if c.exists():
            return c
    return None


def load_whisper_model(requested: Optional[str] = None, device: Optional[str] = None, compute_type: Optional[str] = None):
    """Load and cache a Faster-Whisper model. Returns the model or raises STTError.
    
    Args:
        requested: Model size hint ("small" or "medium").
        device: Device to use ("cuda" or "cpu"). If None, auto-detected.
        compute_type: Compute type ("float16" or "int8"). If None, auto-selected.
    
    Returns:
        Loaded WhisperModel instance.
        
    Raises:
        STTError: If model path not found or initialization fails.
    """
    model_path = find_whisper_model_path(requested)
    if not model_path:
        raise STTError(
            "Whisper model files not found. Ensure small/medium models exist under assets/speech_to_text/."
        )

    # Determine device and compute type if not provided
    if device is None or compute_type is None:
        opts = _whisper_device_and_compute_type()
        if device is None:
            device = opts["device"]
        if compute_type is None:
            compute_type = opts["compute_type"]

    # Cache key includes device and compute_type to support different configurations
    key = f"{model_path.resolve()}:{device}:{compute_type}"
    if key in _whisper_models_by_path:
        return _whisper_models_by_path[key]

    print(f"Loading Faster-Whisper model from: {model_path} ({device}, {compute_type})")
    
    try:
        model = WhisperModel(
            str(model_path),
            device=device,
            compute_type=compute_type,
        )
        print("Whisper model loaded successfully.")
    except Exception as e:
        raise STTError(
            f"Failed to initialize Whisper model at '{model_path}': {e}"
        ) from e
    _whisper_models_by_path[key] = model
    return model


# ---- Whisper Transcriber ---------------------------------------------------
class WhisperTranscriber(AudioTranscriber):
    """Faster-Whisper speech-to-text transcriber (CUDA-accelerated if available)."""
    
    def __init__(self, model_size: str = "small", device: str = "auto", compute_type: str = "auto"):
        """Initialize Whisper transcriber.
        
        Args:
            model_size: Model size to use ("small" or "medium").
            device: Device to use ("auto", "cuda", or "cpu"). Auto selects CUDA if available.
            compute_type: Compute type ("auto", "float16", "int8"). Auto selects based on device.
        """
        self.model_size = model_size
        
        # Determine device and compute type
        if device == "auto" or compute_type == "auto":
            opts = _whisper_device_and_compute_type()
            if device == "auto":
                device = opts["device"]
            if compute_type == "auto":
                compute_type = opts["compute_type"]
        
        self.device = device
        self.compute_type = compute_type
        # Pass device and compute_type to load_whisper_model
        self.model = load_whisper_model(model_size, device=device, compute_type=compute_type)
    
    def transcribe(self, wav_bytes: bytes) -> str:
        """Transcribe WAV bytes using Faster-Whisper.
        
        Args:
            wav_bytes: WAV file content as bytes.
            
        Returns:
            Transcribed text.
            
        Raises:
            STTError: If transcription fails.
        """
        # Write bytes to a temporary WAV file for robust decoding
        # Use delete=False to avoid Windows permission issues, then manually delete
        tmp_file = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp.write(wav_bytes)
                tmp.flush()
                tmp_file = tmp.name
            
            # Now transcribe the closed file
            try:
                segments, info = self.model.transcribe(
                    tmp_file,
                    beam_size=1,
                    vad_filter=True,
                    temperature=0.0,
                )
            except Exception as e:
                raise STTError(f"Whisper transcription failed: {e}") from e
            
            # Concatenate segments into a single string
            texts: List[str] = []
            for seg in segments:
                try:
                    texts.append(seg.text)
                except Exception:
                    # Segment objects are simple; be defensive anyway
                    pass
            return " ".join(t.strip() for t in texts if t.strip())
        finally:
            # Clean up the temporary file
            if tmp_file and os.path.exists(tmp_file):
                try:
                    os.unlink(tmp_file)
                except Exception:
                    pass  # Ignore cleanup errors
    
    def get_backend_name(self) -> str:
        return "whisper"


def transcribe_wav_bytes_whisper(wav_bytes: bytes, model: Optional[str] = "small") -> str:
    """Transcribe WAV bytes using Faster-Whisper. Writes to a temp .wav file.

    Args:
        wav_bytes: WAV file content as bytes.
        model: 'small' or 'medium' (defaults to 'small').
    """
    model_obj = load_whisper_model(model)

    # Write bytes to a temporary WAV file for robust decoding
    # Use delete=False to avoid Windows permission issues, then manually delete
    tmp_file = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(wav_bytes)
            tmp.flush()
            tmp_file = tmp.name
        
        # Now transcribe the closed file
        try:
            segments, info = model_obj.transcribe(
                tmp_file,
                beam_size=1,
                vad_filter=True,
                temperature=0.0,
            )
        except Exception as e:
            raise STTError(f"Whisper transcription failed: {e}") from e
        
        # Concatenate segments into a single string
        texts: List[str] = []
        for seg in segments:
            try:
                texts.append(seg.text)
            except Exception:
                # Segment objects are simple; be defensive anyway
                pass
        return " ".join(t.strip() for t in texts if t.strip())
    finally:
        # Clean up the temporary file
        if tmp_file and os.path.exists(tmp_file):
            try:
                os.unlink(tmp_file)
            except Exception:
                pass  # Ignore cleanup errors


# ---- Factory and convenience functions -------------------------------------
# Cache transcriber instances for reuse
_transcriber_cache: Dict[str, AudioTranscriber] = {}


def create_transcriber(backend: str = "vosk", model: Optional[str] = "auto") -> AudioTranscriber:
    """Factory function to create AudioTranscriber instances.
    
    Args:
        backend: Backend to use ("vosk" or "whisper").
        model: Model hint for the backend.
        
    Returns:
        AudioTranscriber instance.
        
    Raises:
        STTError: If backend is not supported or model is unavailable.
    """
    backend = (backend or "vosk").lower()
    cache_key = f"{backend}:{model}"
    
    # Return cached instance if available
    if cache_key in _transcriber_cache:
        return _transcriber_cache[cache_key]
    
    # Create new instance
    transcriber: AudioTranscriber
    if backend == "vosk":
        transcriber = VoskTranscriber(model_hint=model or "auto")
    elif backend == "whisper":
        # Map generic 'auto' to small for speed by default
        hint = (model or "small").lower()
        if hint in ("auto", "default"):
            hint = "small"
        transcriber = WhisperTranscriber(model_size=hint)
    else:
        raise STTError(f"Unsupported STT backend: {backend}")
    
    # Cache and return
    _transcriber_cache[cache_key] = transcriber
    return transcriber


def transcribe_wav_bytes(
    wav_bytes: bytes, *, backend: str = "vosk", model: Optional[str] = "auto"
) -> str:
    """Transcribe WAV bytes using the specified backend (default: Vosk).

    Args:
        wav_bytes: WAV file content as bytes.
        backend: "vosk" for local model; "whisper" for Faster-Whisper.
        model: Backend-specific model hint (e.g., "auto", "small", "large").

    Returns:
        Transcribed text.
    """
    transcriber = create_transcriber(backend=backend, model=model)
    return transcriber.transcribe(wav_bytes)
