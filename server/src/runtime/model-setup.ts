import { open, readFile } from 'node:fs/promises';

export async function updateModelEnv(path: string, model: string) {
  if (!/^[\w.:/-]+$/.test(model)) throw new Error('模型标签格式不正确');
  let source = '';
  try { source = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const values: Record<string, string> = { MODEL_PROVIDER: 'openai-compatible', OPENAI_COMPAT_MODEL: model };
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const seen = new Set<string>();
  const lines = source.split(/\r?\n/).map(line => {
    const match = line.match(/^(\s*(?:export\s+)?)(MODEL_PROVIDER|OPENAI_COMPAT_MODEL)\s*=.*?((?:\s+#.*)?)$/);
    if (!match) return line;
    seen.add(match[2]!);
    return `${match[1]}${match[2]}=${values[match[2]!]}${match[3]}`;
  });
  for (const [key, value] of Object.entries(values)) if (!seen.has(key)) {
    if (lines.at(-1) === '') lines.pop();
    lines.push(`${key}=${value}`, '');
  }
  const file = await open(path, 'a+', 0o600);
  try {
    await file.chmod(0o600);
    await file.truncate(0);
    await file.writeFile(lines.join(newline));
  } finally { await file.close(); }
}

export async function smokeModel(baseURL: string, model: string, fetcher: typeof fetch = fetch, apiKey?: string) {
  const start = performance.now();
  const latencies: number[] = [];
  const request = async (body: object) => {
    const began = performance.now();
    const response = await fetcher(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, stream: false, temperature: 0, max_tokens: 256, ...body }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error('模型请求失败');
    const result = await response.json() as { choices?: { message?: { content?: string; tool_calls?: { type?: string; function?: { name?: string; arguments?: string } }[] } }[] };
    latencies.push(Math.round(performance.now() - began));
    return result.choices?.[0]?.message;
  };
  try {
    const chat = await request({ messages: [
      { role: 'system', content: '你是团子，一只温柔陪伴主人的猫。用简短中文自然回应，不说教。' },
      { role: 'user', content: '团子，我今天有点累，可以陪我坐一会儿吗？' },
    ] });
    const tool = await request({ messages: [{ role: 'user', content: '请调用 set_companion_light，把 color 设为 warm，brightness 设为 30。不要用文字代替工具。' }],
      tools: [{ type: 'function', function: { name: 'set_companion_light', description: '设置陪伴灯', parameters: {
        type: 'object', properties: { color: { type: 'string', enum: ['warm'] }, brightness: { type: 'integer' } }, required: ['color', 'brightness'], additionalProperties: false,
      } } }], tool_choice: 'required' });
    const calls = tool?.tool_calls ?? [];
    const call = calls[0];
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(call?.function?.arguments ?? '{}'); } catch { /* 参数不合法即失败 */ }
    const chinese = typeof chat?.content === 'string' && /[\u3400-\u9fff]/u.test(chat.content);
    const correctTool = calls.length === 1 && call?.type === 'function' && call.function?.name === 'set_companion_light'
      && args?.color === 'warm' && args?.brightness === 30 && Object.keys(args).length === 2;
    return { passed: !!(chinese && correctTool), chinese, correctTool, latencyMs: Math.round(performance.now() - start), chatLatencyMs: latencies[0], toolLatencyMs: latencies[1] };
  } catch {
    return { passed: false, latencyMs: Math.round(performance.now() - start), error: '模型请求失败或超时，烟测未通过。' };
  }
}

export async function pullModel(nativeBase: string, model: string, progress: (value: unknown) => void, apiKey?: string) {
  const response = await fetch(`${nativeBase}/api/pull`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, stream: true }), signal: AbortSignal.timeout(60 * 60_000),
  });
  if (!response.ok || !response.body) throw new Error('下载失败');
  let buffer = '';
  let success = false;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as { error?: string; status?: string };
    if (event.error) throw new Error('下载失败');
    if (event.status === 'success') success = true;
    progress(event);
  };
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    for (const line of lines) consume(line);
  }
  consume(buffer);
  if (!success) throw new Error('下载未完成');
}
