// Audio capture and simple WAV encoding for server-side STT.

export class LocalRecorder {
  constructor() {
    this.audioStream = null;
    this.audioContext = null;
    this.audioSource = null;
    this.processor = null;
    this.audioData = [];
    this.inputSampleRate = 48000;
  }

  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone not available in this browser.');
    }
    this.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    this.inputSampleRate = this.audioContext.sampleRate;
    this.audioSource = this.audioContext.createMediaStreamSource(this.audioStream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.audioData = [];

    this.processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      this.audioData.push(new Float32Array(input));
    };
    this.audioSource.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  async stopAndGetWavBlob(targetSampleRate = 16000) {
    try {
      if (this.processor) this.processor.disconnect();
      if (this.audioSource) this.audioSource.disconnect();
      if (this.audioStream) this.audioStream.getTracks().forEach(t => t.stop());
      if (this.audioContext) await this.audioContext.close();
    } catch {}

    const merged = mergeFloat32(this.audioData);
    const ds = downsampleBuffer(merged, this.inputSampleRate, targetSampleRate);
    return encodeWAV(ds, targetSampleRate);
  }
}

function mergeFloat32(chunks) {
  let length = 0;
  for (const c of chunks) length += c.length;
  const result = new Float32Array(length);
  let offset = 0;
  for (const c of chunks) { result.set(c, offset); offset += c.length; }
  return result;
}

function downsampleBuffer(buffer, inRate, outRate) {
  if (outRate === inRate) return buffer;
  const ratio = inRate / outRate;
  const newLen = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio;
    const idx0 = Math.floor(idx);
    const idx1 = Math.min(idx0 + 1, buffer.length - 1);
    const frac = idx - idx0;
    result[i] = buffer[idx0] * (1 - frac) + buffer[idx1] * frac;
  }
  return result;
}

function encodeWAV(samples, sampleRate) {
  // 16-bit PCM WAV
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (v, o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  const floatTo16 = (out, offset, input) => {
    for (let i = 0; i < input.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, input[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
  };

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  floatTo16(view, 44, samples);

  return new Blob([view], { type: 'audio/wav' });
}

// Convert spoken text into likely move strings to try (coordinates or SAN)
export function normalizeSpeechToCandidates(text) {
  if (!text) return [];
  let s = text.toLowerCase().trim();
  s = s.replace(/[^a-z0-9\s-]/g, ' ');
  s = s.replace(/\s+/g, ' ');

  const numMap = {
    'one': '1', 'won': '1',
    'two': '2', 'to': '2', 'too': '2',
    'three': '3',
    'four': '4', 'for': '4',
    'five': '5',
    'six': '6',
    'seven': '7',
    'eight': '8', 'ate': '8'
  };
  s = s.split(' ').map(w => numMap[w] || w).join(' ');

  // Special-case: STT often hears 'h4' as 'eight four', '8 4', '84', or '8-4'.
  // We preserve original text but also create variants mapping leading 8 -> 'h' when followed by a rank.
  const numericH4Variants = new Set();
  const addHVariants = (src) => {
    if (!src) return;
    let v1 = src.replace(/\b8\s*-?\s*([1-8])\b/g, 'h$1');
    let v2 = v1.replace(/\b8([1-8])\b/g, 'h$1');
    if (v1 !== src) numericH4Variants.add(v1);
    if (v2 !== src) numericH4Variants.add(v2);
  };
  addHVariants(s);

  s = s.replace(/castle\s+king\s*side|king\s*side\s*castle|short\s*castle|o\s*-\s*o/g, 'O-O');
  s = s.replace(/castle\s+queen\s*side|queen\s*side\s*castle|long\s*castle|o\s*-\s*o\s*-\s*o/g, 'O-O-O');

  s = s.replace(/knight/g, 'N')
       .replace(/bishop/g, 'B')
       .replace(/rook/g, 'R')
       .replace(/queen/g, 'Q')
       .replace(/king/g, 'K');

  s = s.replace(/takes|x|by/g, 'x');
  s = s.replace(/equals\s*queen|promote\s*to\s*queen|=\s*q/g, '=Q');
  s = s.replace(/equals\s*rook|promote\s*to\s*rook|=\s*r/g, '=R');
  s = s.replace(/equals\s*bishop|promote\s*to\s*bishop|=\s*b/g, '=B');
  s = s.replace(/equals\s*knight|promote\s*to\s*knight|=\s*n/g, '=N');

  const candidates = new Set();
  candidates.add(s.replace(/\s+/g, ''));
  candidates.add(s.replace(/\b([nbrqk])\s*([a-h])\s*([1-8])\b/gi, '$1$2$3').replace(/\s+/g, ''));
  candidates.add(s.replace(/\s+/g, ''));

  // Add h-file variants candidates too
  for (const v of numericH4Variants) {
    candidates.add(v.replace(/\s+/g, ''));
    candidates.add(v.replace(/\b([nbrqk])\s*([a-h])\s*([1-8])\b/gi, '$1$2$3').replace(/\s+/g, ''));
  }

  const sq = Array.from(s.matchAll(/([a-h])\s*([1-8])/g)).map(m => m[1] + m[2]);
  if (sq.length >= 2) {
    candidates.add((sq[0] + sq[1]).toLowerCase());
  }

  const promoMap = { 'queen': 'q', 'rook': 'r', 'bishop': 'b', 'knight': 'n', 'q': 'q', 'r': 'r', 'b': 'b', 'n': 'n' };
  const promoMatch = s.match(/([a-h])\s*7\b.*?([a-h])\s*8\b.*?(queen|rook|bishop|knight|q|r|b|n)/);
  if (promoMatch) {
    const from = promoMatch[1] + '7';
    const to = promoMatch[2] + '8';
    const pr = promoMap[promoMatch[3]] || '';
    candidates.add((from + to + pr).toLowerCase());
  }

  if (s.includes('O-O-O')) candidates.add('O-O-O');
  if (s.includes('O-O')) candidates.add('O-O');

  return Array.from(candidates).filter(Boolean);
}
