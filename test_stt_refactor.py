"""
Quick test script to verify the refactored STT implementation.

This script tests:
1. Factory function for creating transcribers
2. Instance caching
3. Both Vosk and Whisper backends (if available)
4. Direct class instantiation
"""

from stt import (
    AudioTranscriber,
    VoskTranscriber, 
    WhisperTranscriber,
    create_transcriber,
    transcribe_wav_bytes,
    STTError
)

def test_factory_and_caching():
    """Test factory function and instance caching."""
    print("\n=== Test 1: Factory and Caching ===")
    
    # Create first instance
    transcriber1 = create_transcriber(backend="vosk", model="auto")
    print(f"✓ Created transcriber: {transcriber1.get_backend_name()}")
    
    # Create second instance with same params - should be cached
    transcriber2 = create_transcriber(backend="vosk", model="auto")
    print(f"✓ Retrieved transcriber: {transcriber2.get_backend_name()}")
    print(f"✓ Same instance (cached)? {transcriber1 is transcriber2}")
    
    # Create instance with different params
    try:
        transcriber3 = create_transcriber(backend="whisper", model="small")
        print(f"✓ Created Whisper transcriber: {transcriber3.get_backend_name()}")
        print(f"✓ Different instance? {transcriber1 is not transcriber3}")
    except STTError as e:
        print(f"⚠ Whisper not available: {e}")


def test_direct_instantiation():
    """Test direct class instantiation."""
    print("\n=== Test 2: Direct Class Instantiation ===")
    
    try:
        vosk = VoskTranscriber(model_hint="auto")
        print(f"✓ VoskTranscriber created: {vosk.get_backend_name()}")
    except STTError as e:
        print(f"✗ VoskTranscriber failed: {e}")
    
    try:
        whisper = WhisperTranscriber(model_size="small", device="auto")
        print(f"✓ WhisperTranscriber created: {whisper.get_backend_name()}")
    except STTError as e:
        print(f"⚠ WhisperTranscriber not available: {e}")


def test_interface_compliance():
    """Test that transcribers implement the AudioTranscriber interface."""
    print("\n=== Test 3: Interface Compliance ===")
    
    try:
        transcriber = create_transcriber(backend="vosk", model="auto")
        
        # Check methods exist
        assert hasattr(transcriber, 'transcribe'), "Missing transcribe method"
        assert hasattr(transcriber, 'get_backend_name'), "Missing get_backend_name method"
        
        # Check inheritance
        assert isinstance(transcriber, AudioTranscriber), "Not an AudioTranscriber instance"
        
        print("✓ VoskTranscriber implements AudioTranscriber interface")
    except Exception as e:
        print(f"✗ Interface test failed: {e}")


def test_convenience_function():
    """Test the convenience wrapper function."""
    print("\n=== Test 4: Convenience Function ===")
    
    # The transcribe_wav_bytes function should still work for backward compatibility
    try:
        # We can't actually transcribe without audio data, but we can verify it exists
        import inspect
        sig = inspect.signature(transcribe_wav_bytes)
        print(f"✓ transcribe_wav_bytes exists with params: {list(sig.parameters.keys())}")
        
        # Verify it accepts the expected parameters
        assert 'wav_bytes' in sig.parameters
        assert 'backend' in sig.parameters
        assert 'model' in sig.parameters
        print("✓ Function has correct signature")
    except Exception as e:
        print(f"✗ Convenience function test failed: {e}")


def test_error_handling():
    """Test error handling for unsupported backends."""
    print("\n=== Test 5: Error Handling ===")
    
    try:
        transcriber = create_transcriber(backend="nonexistent", model="test")
        print("✗ Should have raised STTError for invalid backend")
    except STTError as e:
        print(f"✓ Correctly raised STTError: {e}")
    except Exception as e:
        print(f"✗ Unexpected error: {e}")


def main():
    """Run all tests."""
    print("=" * 60)
    print("STT Refactoring Test Suite")
    print("=" * 60)
    
    test_factory_and_caching()
    test_direct_instantiation()
    test_interface_compliance()
    test_convenience_function()
    test_error_handling()
    
    print("\n" + "=" * 60)
    print("Test suite complete!")
    print("=" * 60)


if __name__ == "__main__":
    main()
