export type ImageProviderErrorCode =
  | 'IMAGE_PROVIDER_NOT_CONFIGURED'
  | 'IMAGE_PROVIDER_UNAVAILABLE'
  | 'IMAGE_MODEL_NOT_SUPPORTED'
  | 'IMAGE_GENERATION_FAILED'
  | 'IMAGE_EDIT_NOT_SUPPORTED'
  | 'INVALID_REFERENCE_IMAGE'
  | 'RATE_LIMITED'
  | 'AUTH_FAILED'
  | 'API_IMPLEMENTATION_PENDING';

export class ImageProviderError extends Error {
  constructor(
    public readonly code: ImageProviderErrorCode,
    message: string,
    public readonly provider?: string,
  ) {
    super(message);
    this.name = 'ImageProviderError';
  }
}

/** Safe for client responses: never forward upstream headers, raw response, or stack. */
export function imageProviderUserMessage(error: unknown): string {
  if (error instanceof ImageProviderError) return error.message;
  return '图片生成失败，请稍后重试。';
}
