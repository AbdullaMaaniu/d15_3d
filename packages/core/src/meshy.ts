/**
 * Minimal Meshy.ai API client (https://docs.meshy.ai): list your generations and
 * download their GLB models. Works in browsers and Node 18+ (global fetch).
 */

export type MeshyKind = 'text-to-3d' | 'image-to-3d' | 'multi-image-to-3d';

export interface MeshyTask {
  id: string;
  kind: MeshyKind;
  status: string;
  prompt?: string;
  thumbnailUrl?: string;
  createdAt?: number;
  modelUrls: Partial<Record<'glb' | 'fbx' | 'obj' | 'usdz', string>>;
}

const PATHS: Record<MeshyKind, string> = {
  'text-to-3d': '/openapi/v2/text-to-3d',
  'image-to-3d': '/openapi/v1/image-to-3d',
  'multi-image-to-3d': '/openapi/v1/multi-image-to-3d',
};

export class MeshyError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'network' | 'http' | 'format',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MeshyError';
  }
}

export interface MeshyClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class MeshyClient {
  private base: string;
  private f: typeof fetch;

  constructor(
    private apiKey: string,
    options: MeshyClientOptions = {},
  ) {
    if (!apiKey?.trim()) throw new MeshyError('A Meshy API key is required (find it under API settings on meshy.ai).', 'auth');
    this.base = (options.baseUrl ?? 'https://api.meshy.ai').replace(/\/$/, '');
    this.f = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.f(url, { ...init, headers: { Authorization: `Bearer ${this.apiKey.trim()}`, ...(init.headers ?? {}) } });
    } catch (e) {
      throw new MeshyError(
        `Could not reach Meshy (${(e as Error).message}). If this is a browser, it may be blocking cross-origin requests; the RigForge CLI can import instead: rigforge meshy list`,
        'network',
      );
    }
    if (res.status === 401 || res.status === 403) throw new MeshyError('Meshy rejected the API key.', 'auth', res.status);
    if (!res.ok) throw new MeshyError(`Meshy returned ${res.status} ${res.statusText}`.trim(), 'http', res.status);
    return res;
  }

  /** Lists your tasks of one kind, newest first. */
  async listTasks(kind: MeshyKind = 'text-to-3d', options: { page?: number; pageSize?: number } = {}): Promise<MeshyTask[]> {
    const q = new URLSearchParams({ page_num: String(options.page ?? 1), page_size: String(Math.min(100, options.pageSize ?? 24)), sort_by: '-created_at' });
    const res = await this.request(`${this.base}${PATHS[kind]}?${q}`);
    const body = await res.json();
    const list = Array.isArray(body) ? body : Array.isArray(body?.result) ? body.result : Array.isArray(body?.data) ? body.data : null;
    if (!list) throw new MeshyError('Unexpected response from Meshy (no task list).', 'format');
    return list.map((t: unknown) => normalizeTask(t, kind));
  }

  /** All kinds merged, newest first, finished tasks with a GLB only. */
  async listModels(options: { pageSize?: number } = {}): Promise<MeshyTask[]> {
    const kinds: MeshyKind[] = ['text-to-3d', 'image-to-3d', 'multi-image-to-3d'];
    const results = await Promise.allSettled(kinds.map((k) => this.listTasks(k, options)));
    const auth = results.find((r) => r.status === 'rejected' && (r.reason as MeshyError).kind !== 'http');
    if (auth && auth.status === 'rejected') throw auth.reason;
    return results
      .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
      .filter((t) => t.status === 'SUCCEEDED' && t.modelUrls.glb)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  async getTask(id: string, kind: MeshyKind = 'text-to-3d'): Promise<MeshyTask> {
    const res = await this.request(`${this.base}${PATHS[kind]}/${encodeURIComponent(id)}`);
    return normalizeTask(await res.json(), kind);
  }

  /** Finds a task by id across all kinds. */
  async findTask(id: string): Promise<MeshyTask> {
    for (const kind of Object.keys(PATHS) as MeshyKind[]) {
      try {
        return await this.getTask(id, kind);
      } catch (e) {
        if ((e as MeshyError).status === 404 || (e as MeshyError).status === 400) continue;
        throw e;
      }
    }
    throw new MeshyError(`No Meshy task with id ${id}.`, 'http', 404);
  }

  /** Downloads a task's GLB. Model URLs are pre-signed, so no auth header is sent. */
  async downloadGlb(task: MeshyTask): Promise<ArrayBuffer> {
    const url = task.modelUrls.glb;
    if (!url) throw new MeshyError('This task has no GLB model (is it finished?).', 'format');
    let res: Response;
    try {
      res = await this.f(url);
    } catch (e) {
      throw new MeshyError(`Could not download the model (${(e as Error).message}).`, 'network');
    }
    if (!res.ok) throw new MeshyError(`Model download failed: ${res.status}. Meshy links expire; list the task again for a fresh one.`, 'http', res.status);
    return res.arrayBuffer();
  }
}

export function normalizeTask(raw: unknown, kind: MeshyKind): MeshyTask {
  const t = (raw ?? {}) as Record<string, any>;
  if (typeof t.id !== 'string') throw new MeshyError('Unexpected task format from Meshy.', 'format');
  const urls = (t.model_urls ?? {}) as Record<string, string>;
  const created = typeof t.created_at === 'number' ? t.created_at : Date.parse(t.created_at ?? '') || undefined;
  return {
    id: t.id,
    kind,
    status: String(t.status ?? 'UNKNOWN'),
    prompt: t.prompt ?? t.texture_prompt ?? undefined,
    thumbnailUrl: t.thumbnail_url ?? undefined,
    createdAt: created,
    modelUrls: { glb: urls.glb || undefined, fbx: urls.fbx || undefined, obj: urls.obj || undefined, usdz: urls.usdz || undefined },
  };
}
