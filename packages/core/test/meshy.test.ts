import { describe, expect, it, vi } from 'vitest';
import { MeshyClient, MeshyError } from '../src/meshy';

const task = (id: string, created: number, status = 'SUCCEEDED', glb = `https://assets.meshy.ai/${id}.glb?sig=x`) => ({
  id, status, prompt: `model ${id}`, created_at: created, thumbnail_url: `https://assets.meshy.ai/${id}.png`, model_urls: { glb, fbx: '', obj: '' },
});

function mockFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    for (const [prefix, fn] of Object.entries(routes)) if (u.startsWith(prefix)) return fn(init);
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('MeshyClient', () => {
  it('lists finished models across task kinds, newest first', async () => {
    const f = mockFetch({
      'https://api.meshy.ai/openapi/v2/text-to-3d?': () => Response.json([task('t1', 100), task('t2', 300, 'IN_PROGRESS', '')]),
      'https://api.meshy.ai/openapi/v1/image-to-3d?': () => Response.json({ result: [task('i1', 200)] }),
      'https://api.meshy.ai/openapi/v1/multi-image-to-3d?': () => new Response('nope', { status: 404 }),
    });
    const client = new MeshyClient('msy_test', { fetch: f });
    const models = await client.listModels();
    expect(models.map((m) => m.id)).toEqual(['i1', 't1']);
    expect(models[0].kind).toBe('image-to-3d');
    const [url, init] = (f as any).mock.calls[0];
    expect(String(url)).toContain('page_size=24');
    expect(String(url)).toContain('sort_by=-created_at');
    expect(init.headers.Authorization).toBe('Bearer msy_test');
  });

  it('explains auth and network failures', async () => {
    const bad = new MeshyClient('wrong', { fetch: mockFetch({ 'https://api.meshy.ai': () => new Response('', { status: 401 }) }) });
    await expect(bad.listModels()).rejects.toMatchObject({ kind: 'auth' });
    const offline = new MeshyClient('k', { fetch: (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch });
    const err = (await offline.listTasks().then(() => null, (e) => e)) as MeshyError;
    expect(err.kind).toBe('network');
    expect(err.message).toContain('rigforge meshy');
    expect(() => new MeshyClient('  ')).toThrow(/API key/);
  });

  it('finds a task by id and downloads its GLB without sending the key', async () => {
    const f = mockFetch({
      'https://api.meshy.ai/openapi/v2/text-to-3d/abc': () => new Response('', { status: 404 }),
      'https://api.meshy.ai/openapi/v1/image-to-3d/abc': () => Response.json(task('abc', 5)),
      'https://assets.meshy.ai/abc.glb': () => new Response(new Uint8Array([103, 108, 84, 70])),
    });
    const client = new MeshyClient('k', { fetch: f });
    const t = await client.findTask('abc');
    expect(t.kind).toBe('image-to-3d');
    const bytes = new Uint8Array(await client.downloadGlb(t));
    expect(Array.from(bytes)).toEqual([103, 108, 84, 70]);
    const dl = (f as any).mock.calls.find((c: any[]) => String(c[0]).includes('assets.meshy.ai'));
    expect(dl[1]?.headers?.Authorization).toBeUndefined();
  });
});
