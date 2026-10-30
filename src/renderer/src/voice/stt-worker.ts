// Whisper speech-to-text, running fully on-device via transformers.js (WebGPU when
// available, WASM otherwise). Models download once from the Hugging Face repos
// onnx-community/whisper-{tiny,base,small} and are cached by the browser cache.
import { env, pipeline } from '@huggingface/transformers'

env.allowLocalModels = false

let asr: any = null
let loadedModel: string | null = null
let loading: Promise<void> | null = null

async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  try {
    const gpu = (navigator as any).gpu
    if (gpu && (await gpu.requestAdapter())) return 'webgpu'
  } catch {
    /* fall back */
  }
  return 'wasm'
}

async function load(model: string): Promise<void> {
  if (loadedModel === model && asr) return
  if (loading) await loading
  if (loadedModel === model && asr) return
  loading = (async () => {
    const device = await pickDevice()
    const repo = `onnx-community/whisper-${model}`
    self.postMessage({ type: 'status', status: 'loading', model, device })
    asr?.dispose?.()
    asr = await pipeline('automatic-speech-recognition', repo, {
      device,
      dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
      progress_callback: (p: any) => {
        if (p.status === 'progress' && p.total) self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total })
      }
    } as any)
    loadedModel = model
    self.postMessage({ type: 'status', status: 'ready', model, device })
  })()
  try {
    await loading
  } catch (err: any) {
    self.postMessage({ type: 'status', status: 'error', model, error: String(err?.message ?? err) })
    throw err
  } finally {
    loading = null
  }
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data
  try {
    if (msg.type === 'load') {
      await load(msg.model)
      self.postMessage({ type: 'loaded', id: msg.id })
    } else if (msg.type === 'transcribe') {
      await load(msg.model)
      const out = await asr(msg.audio, {
        language: msg.language && msg.language !== 'auto' ? msg.language : undefined,
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5
      })
      const text = Array.isArray(out) ? out.map((o: any) => o.text).join(' ') : out.text
      self.postMessage({ type: 'result', id: msg.id, text: String(text ?? '').trim() })
    }
  } catch (err: any) {
    self.postMessage({ type: 'error', id: msg.id, error: String(err?.message ?? err) })
  }
}
