// Kokoro-82M text-to-speech (Apache-2.0) running on-device via kokoro-js. The model
// downloads once from onnx-community/Kokoro-82M-v1.0-ONNX and is cached locally.
import { KokoroTTS } from 'kokoro-js'

const REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX'
let tts: KokoroTTS | null = null
let loading: Promise<KokoroTTS> | null = null

async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  try {
    const gpu = (navigator as any).gpu
    if (gpu && (await gpu.requestAdapter())) return 'webgpu'
  } catch {
    /* fall back */
  }
  return 'wasm'
}

function load(): Promise<KokoroTTS> {
  if (tts) return Promise.resolve(tts)
  if (loading) return loading
  loading = (async () => {
    const device = await pickDevice()
    self.postMessage({ type: 'status', status: 'loading', device })
    const t = await KokoroTTS.from_pretrained(REPO, {
      dtype: device === 'webgpu' ? 'fp32' : 'q8',
      device,
      progress_callback: (p: any) => {
        if (p.status === 'progress' && p.total) self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total })
      }
    })
    tts = t
    self.postMessage({ type: 'status', status: 'ready', device })
    return t
  })()
  loading.catch((err) => {
    loading = null
    self.postMessage({ type: 'status', status: 'error', error: String(err?.message ?? err) })
  })
  return loading
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data
  try {
    if (msg.type === 'load') {
      await load()
      self.postMessage({ type: 'loaded', id: msg.id })
    } else if (msg.type === 'speak') {
      const engine = await load()
      const audio = await engine.generate(msg.text, { voice: msg.voice, speed: msg.speed })
      const samples = audio.audio as Float32Array
      self.postMessage({ type: 'audio', id: msg.id, samples, sampleRate: audio.sampling_rate }, { transfer: [samples.buffer] })
    }
  } catch (err: any) {
    self.postMessage({ type: 'error', id: msg.id, error: String(err?.message ?? err) })
  }
}
