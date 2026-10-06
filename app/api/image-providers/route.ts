import { NextResponse } from 'next/server';
import '@/lib/image-providers/unified-builtins';
import { imageProviderRegistry } from '@/lib/image-providers/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 对前端仅提供安全的状态与能力信息，绝不返回密钥或服务地址。 */
export async function GET() {
  const providers = imageProviderRegistry.list().map((provider) => ({
    id: provider.id,
    name: provider.name,
    configured: provider.isConfigured(),
    status: imageProviderRegistry.status(provider.id),
    models: provider.models(),
    capabilities: provider.getCapabilities(),
  }));
  return NextResponse.json({ providers });
}
