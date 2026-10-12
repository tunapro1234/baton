// The on-device speech model. The browser worker and npm run eval:stt both read it, so the eval
// measures the model the page runs. Whisper's encoder loses accuracy when quantized; the decoder
// barely does. First load downloads about 136 MB from the Hugging Face hub; the browser caches it.
export const STT_MODEL = 'onnx-community/whisper-base.en';
export const STT_DTYPE = { encoder_model: 'fp32', decoder_model_merged: 'q8' } as const;
export const STT_RATE = 16000;
