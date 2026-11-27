export const UPSCALE_MODEL = 'seedvr2_ema_3b_fp8_e4m3fn.safetensors';
export const UPSCALE_VAE = 'ema_vae_fp16.safetensors';
export const UPSCALE_ENGINE = 'seedvr2-2.5.1';
export const UPSCALE_SEED = 42;
export const BACKGROUND_NODE = 'easy imageRemBg';
export const BACKGROUND_MODEL = 'RMBG-1.4';

export class UpscaleError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function validateOptions(input) {
  if (input?.mode === 'remove-background' && input.scale === 1) {
    return { mode: 'remove-background', scale: 1 };
  }
  if (!input || input.mode !== 'faithful' || ![2, 4].includes(input.scale)) {
    throw new UpscaleError('高清放大请选择 2× 或 4× 倍率。');
  }
  return { mode: input.mode, scale: input.scale };
}

export function validateDimensions(width, height, scale, mode = 'faithful') {
  validateOptions({ mode, scale });
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new UpscaleError('图片尺寸无效。');
  }
  const outputWidth = width * scale;
  const outputHeight = height * scale;
  if (![outputWidth, outputHeight, outputWidth * outputHeight].every(Number.isSafeInteger)) {
    throw new UpscaleError('图片尺寸无效。');
  }
  return { width, height, outputWidth, outputHeight };
}

export function buildWorkflow(options, image, dimensions, jobId) {
  validateOptions(options);
  if (options.mode === 'remove-background') {
    return {
      '1': { class_type: 'LoadImage', inputs: { image } },
      '2': { class_type: BACKGROUND_NODE, inputs: {
        images: ['1', 0], rem_mode: BACKGROUND_MODEL, image_output: 'Hide',
        save_prefix: 'canvas-background/' + jobId, torchscript_jit: false,
        add_background: 'none', refine_foreground: false,
      } },
      '9': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'canvas-background/' + jobId } },
    };
  }
  const graph = {
    '1': { class_type: 'LoadImage', inputs: { image } },
    '2': { class_type: 'SeedVR2LoadDiTModel', inputs: {
      model: UPSCALE_MODEL, device: 'cuda:0', blocks_to_swap: 32, swap_io_components: true,
      offload_device: 'cpu', cache_model: false, attention_mode: 'sdpa',
    } },
    '3': { class_type: 'SeedVR2LoadVAEModel', inputs: {
      model: UPSCALE_VAE, device: 'cuda:0', encode_tiled: true, encode_tile_size: 512,
      encode_tile_overlap: 64, decode_tiled: true, decode_tile_size: 512, decode_tile_overlap: 64,
      tile_debug: 'false', offload_device: 'cpu', cache_model: false,
    } },
    '4': { class_type: 'GetImageSize', inputs: { image: ['1', 0] } },
    '5': { class_type: 'PrimitiveBoolean', inputs: { value: options.scale === 4 } },
    '6': { class_type: 'ComfyMathExpression', inputs: {
      expression: 'min(a, b) * (4 if c else 2)',
      'values.a': ['4', 0], 'values.b': ['4', 1], 'values.c': ['5', 0],
    } },
    '7': { class_type: 'SeedVR2VideoUpscaler', inputs: {
      image: ['1', 0], dit: ['2', 0], vae: ['3', 0], seed: UPSCALE_SEED,
      resolution: ['6', 1], max_resolution: 0, batch_size: 1, uniform_batch_size: false,
      color_correction: 'lab', temporal_overlap: 0, prepend_frames: 0,
      input_noise_scale: 0, latent_noise_scale: 0, offload_device: 'cpu', enable_debug: false,
    } },
    '9': { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'canvas-upscale/' + jobId } },
  };
  return graph;
}

export function modelChoices(node, field) {
  const definition = node?.input?.required?.[field];
  return Array.isArray(definition?.[0]) ? definition[0] : definition?.[1]?.options || [];
}

export function describeFailure(error) {
  const message = String(error?.message || error || '未知错误');
  if (/out of memory|allocation on device|cuda.*memory/i.test(message)) {
    return { code: 'out_of_memory', message: '显存不足，请关闭其他 GPU 任务或改用较小图片／2× 后重试。' };
  }
  return { code: error?.code || 'execution_failed', message: message.slice(0, 2000) };
}
