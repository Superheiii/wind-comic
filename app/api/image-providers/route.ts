import { NextRequest, NextResponse } from 'next/server';
import '@/lib/image-providers/unified-builtins';
import { imageProviderRegistry } from '@/lib/image-providers/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 对前端仅提供安全的状态与能力信息，绝不返回密钥或服务地址。 */
export async function GET(request: NextRequest) {
  const checkProviderId = request.nextUrl.searchParams.get('check');
  if (checkProviderId) {
    const provider = imageProviderRegistry.get(checkProviderId);
    if (!provider) {
      return NextResponse.json({ error: '未找到指定的图片 Provider。' }, { status: 404 });
    }
    if (!provider.healthCheck) {
      return NextResponse.json({ error: `${provider.name} 暂不支持连接检测。` }, { status: 400 });
    }

    // 健康检测仅返回脱敏后的状态与中文说明，不透传服务端响应或请求头。
    const health = await provider.healthCheck();
    return NextResponse.json({
      provider: {
        id: provider.id,
        configured: provider.isConfigured(),
        status: health.status,
        message: health.message,
        // 仅透传安全诊断字段，绝不返回 API Key、Authorization 或上游完整响应。
        model: health.model,
        httpStatus: health.httpStatus,
        requestId: health.requestId,
      },
    });
  }

  const providers = imageProviderRegistry.list().map((provider) => ({
    id: provider.id,
    name: provider.name,
    configured: provider.isConfigured(),
    status: imageProviderRegistry.status(provider.id),
    models: provider.models(),
    capabilities: provider.getCapabilities(),
    healthCheck: Boolean(provider.healthCheck),
  }));
  return NextResponse.json({ providers });
}
