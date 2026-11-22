import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../src/gateway/index.ts";
import { configFromEnv } from "../src/runtime/config.ts";
import { startHost } from "../src/runtime/index.ts";
import { listConversations, sendMessage } from "../src/store/conversations.ts";
import { getCurrentFileSource } from "../src/store/files.ts";
import { resolveDeviceToken } from "../src/store/identity.ts";
import { messages } from "../src/store/schema/conversations.ts";
import { files } from "../src/store/schema/files.ts";
import { issueTestDevice } from "./identity-fixture.ts";

const sha256 = (bytes: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM+8AAAAASUVORK5CYII=", "base64");
const uploads = "/v2/files/uploads";
const filePath = (id: string) => `/v2/files/${id}`;
const uploadPath = (id: string) => `${uploads}/${id}`;

interface Upload {
  id: string;
  offset: number;
  file_id: string | null;
}

interface FileResult {
  file: { id: string; rev: number; available: boolean; sha256: string };
}

async function fixture(env: Record<string, string | undefined> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "cattt-files-"));
  const start = async () => {
    const gateway = new Gateway({ lanPort: 0, tls: { ips: () => [], hostname: "test" } });
    const config = configFromEnv({ ...env, CATTT_DATA_DIR: directory, CATTT_PORT: "0", CATTT_PEER_HTTPS_PORT: "0" });
    return { gateway, host: await startHost(config, [gateway]) };
  };
  let { gateway, host } = await start();
  const a = issueTestDevice(host, "甲");
  const b = issueTestDevice(host, "乙");
  const actor = resolveDeviceToken(host.store.db, host.clock, a.token)!;
  const [group, direct] = listConversations(host.store.db, actor);
  const ca = readFileSync(join(directory, "tls/ca.crt"), "utf8");
  const request = (path: string, { token = a.token, ...init }: RequestInit & { token?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    }
    return fetch(`https://127.0.0.1:${gateway.lanPort}${path}`, { ...init, headers, tls: { ca }, proxy: false });
  };
  const manifest = (data: string | Uint8Array, overrides: Record<string, unknown> = {}) => ({
    client_upload_id: crypto.randomUUID(), conversation_id: group!.id,
    sha256: sha256(data), byte_size: typeof data === "string" ? Buffer.byteLength(data) : data.length,
    file_name: "团子.txt", media_type: "text/plain", ...overrides,
  });
  const begin = (body: ReturnType<typeof manifest>, token?: string) => request(uploads, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), token,
  });
  const append = (id: string, offset: number, body: BodyInit) => request(uploadPath(id), {
    method: "PATCH", headers: { "upload-offset": String(offset), "content-type": "application/octet-stream" }, body,
  });
  const finish = (id: string) => request(uploadPath(id) + "/complete", { method: "POST" });
  const upload = async (data: string | Uint8Array<ArrayBuffer>, overrides: Record<string, unknown> = {}) => {
    const intent = await begin(manifest(data, overrides));
    expect(intent.status).toBe(201);
    const { id } = await intent.json() as Upload;
    expect((await append(id, 0, data)).status).toBe(200);
    const completed = await finish(id);
    expect(completed.status).toBe(201);
    return (await completed.json() as FileResult).file;
  };
  return {
    directory, get host() { return host; }, a, b, actor, group: group!, direct: direct!,
    request, manifest, begin, append, finish, upload,
    restart: async () => { await host.stop(); ({ gateway, host } = await start()); },
    stop: async () => { await host.stop(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("LAN HTTPS 上传可跨重启续传，并安全处理偏移冲突、回执丢失和哈希不符", async () => {
  const f = await fixture();
  try {
    const manifest = f.manifest("abcdef");
    expect((await f.begin(manifest, "")).status).toBe(401);
    const created = await f.begin(manifest);
    expect(created.status).toBe(201);
    const { id } = await created.json() as Upload;
    const replay = await f.begin(manifest);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id, offset: 0, file_id: null });
    expect((await f.begin({ ...manifest, byte_size: 7 })).status).toBe(409);
    expect((await f.request(uploadPath(id), { token: f.b.token })).status).toBe(404);
    expect((await f.append(id, 0, "abc")).status).toBe(200);
    await f.restart();
    expect(await (await f.begin(manifest)).json()).toMatchObject({ id, offset: 3, file_id: null });
    const stale = await f.append(id, 0, "abc");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "offset_mismatch", offset: 3 } });
    expect((await f.finish(id)).status).toBe(409);
    const list = `/v2/files?conversation_id=${f.group.id}`;
    expect(await (await f.request(list)).json()).toMatchObject({ files: [] });
    expect((await f.append(id, 3, "defg")).status).toBe(413);
    expect((await f.append(id, 3, "xyz")).status).toBe(200);
    const mismatched = await f.finish(id);
    expect(mismatched.status).toBe(422);
    expect(await mismatched.json()).toMatchObject({ error: { code: "checksum_mismatch", offset: 0 } });
    expect(await (await f.request(list)).json()).toMatchObject({ files: [] });
    expect((await f.append(id, 0, "abcdef")).status).toBe(200);
    const completed = await f.finish(id);
    expect(completed.status).toBe(201);
    const { file } = await completed.json() as FileResult;
    expect(file).toMatchObject({ sha256: sha256("abcdef"), available: true, rev: 1 });
    expect((await f.finish(id)).status).toBe(200);
    expect(await (await f.begin(manifest)).json()).toMatchObject({ id, offset: 6, file_id: file.id });
    expect(await (await f.request(list)).json()).toMatchObject({ files: [{ id: file.id }] });
  } finally {
    await f.stop();
  }
});

test("群聊与单聊授权、Range、撤回和本机原件缺失分别处理", async () => {
  const f = await fixture();
  try {
    const privateFile = await f.upload("abcdef", { conversation_id: f.direct.id });
    const sharedFile = await f.upload("abcdef");
    const body = "/content";
    expect((await f.request(filePath(privateFile.id) + body, { token: f.b.token })).status).toBe(404);
    expect((await f.request(filePath(privateFile.id), { token: f.b.token })).status).toBe(404);
    expect((await f.request(`/v2/files?conversation_id=${f.direct.id}`, { token: f.b.token })).status).toBe(404);
    expect((await f.begin(f.manifest("x", { conversation_id: f.direct.id }), f.b.token)).status).toBe(404);
    expect((await f.request(filePath(sharedFile.id) + body, { token: "" })).status).toBe(401);
    expect((await f.request(filePath(sharedFile.id), { token: f.b.token, method: "DELETE" })).status).toBe(404);
    const get = (range?: string, ifRange?: string) => f.request(filePath(sharedFile.id) + body, {
      token: f.b.token, headers: { ...(range ? { range } : {}), ...(ifRange ? { "if-range": ifRange } : {}) },
    });
    const full = await get();
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-type")).toBe("application/octet-stream");
    expect(await full.text()).toBe("abcdef");
    for (const [range, content, served] of [
      ["bytes=1-3", "bcd", "1-3"], ["bytes=2-", "cdef", "2-5"],
      ["bytes=-2", "ef", "4-5"], ["bytes=4-80", "ef", "4-5"],
    ] as const) {
      const response = await get(range, full.headers.get("etag")!);
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(`bytes ${served}/6`);
      expect(await response.text()).toBe(content);
    }
    for (const range of ["bytes=6-", "bytes=-0", "bytes=4-3", "bytes=0-1,4-5"]) {
      const response = await get(range);
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */6");
    }
    const changed = await get("bytes=2-", '"other"');
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe("abcdef");
    expect((await f.request(filePath(sharedFile.id) + "/thumbnail")).status).toBe(415);
    expect((await f.request(filePath(privateFile.id), { method: "DELETE" })).status).toBe(204);
    expect((await f.request(filePath(privateFile.id), { method: "DELETE" })).status).toBe(204);
    expect((await f.request(filePath(privateFile.id) + body)).status).toBe(404);
    expect(getCurrentFileSource(f.host.store.db, { fileId: privateFile.id, fileRev: privateFile.rev })).toBeUndefined();
    expect(await (await get()).text()).toBe("abcdef");
    rmSync(join(f.directory, "blobs", "content", sharedFile.sha256));
    expect(await (await f.request(filePath(sharedFile.id), { token: f.b.token })).json()).toMatchObject({ file: { available: false } });
    const offline = await get("bytes=1-3");
    expect(offline.status).toBe(404);
    expect(await offline.json()).toEqual({ error: { code: "blob_unavailable" } });
  } finally {
    await f.stop();
  }
});

test("缩略图由本机生成并按附件授权，原消息修订或撤回使已缓存缩略图和来源一起失效", async () => {
  const f = await fixture();
  try {
    const { body: { message } } = sendMessage(f.host.store.db, f.host.clock, f.actor, f.group.id, {
      clientMessageId: crypto.randomUUID(), text: "团子的照片",
    });
    const source = { source_message_id: message.id, source_message_rev: 1 };
    expect((await f.begin(f.manifest(png, source), f.b.token)).status).toBe(404);
    const photo = await f.upload(new Uint8Array(png), { ...source, media_type: "image/png", file_name: "团子.png" });
    expect(getCurrentFileSource(f.host.store.db, { fileId: photo.id, fileRev: 1 })).toMatchObject({
      sourceMessageId: message.id, sourceMessageRev: 1, ownerMemberId: f.a.memberId,
    });
    const thumb = await f.request(filePath(photo.id) + "/thumbnail", { token: f.b.token });
    if (process.platform === "darwin") {
      expect(thumb.status).toBe(200);
      expect(thumb.headers.get("content-type")).toBe("image/jpeg");
      const image = new Uint8Array(await thumb.arrayBuffer());
      expect([...image.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      expect([...image.slice(-2)]).toEqual([0xff, 0xd9]);
    } else {
      expect(thumb.status).toBe(415);
    }
    f.host.store.db.update(messages).set({ rev: 2 }).where(eq(messages.id, message.id)).run();
    expect(getCurrentFileSource(f.host.store.db, { fileId: photo.id, fileRev: 1 })).toBeUndefined();
    for (const suffix of ["", "/content", "/thumbnail"]) {
      expect((await f.request(filePath(photo.id) + suffix, { token: f.b.token })).status).toBe(404);
    }
    expect(await (await f.request(`/v2/files?conversation_id=${f.group.id}`)).json()).toMatchObject({ files: [] });
    const latest = await f.upload(new Uint8Array(png), { ...source, source_message_rev: 2, media_type: "image/png" });
    f.host.store.db.update(messages).set({ deletedAt: f.host.clock.wallMs() }).where(eq(messages.id, message.id)).run();
    expect((await f.request(filePath(latest.id) + "/content")).status).toBe(404);
  } finally {
    await f.stop();
  }
});

function mockVision() {
  const calls: { path: string; body: unknown }[] = [];
  let result = () => Response.json({ choices: [{ message: { content: "一张小照片。" }, finish_reason: "stop" }] });
  let wait: Promise<void> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      calls.push({ path: new URL(request.url).pathname, body: await request.json() });
      await wait;
      return result();
    },
  });
  return {
    calls,
    env: { CATTT_VISION_BASE_URL: new URL("/v1", server.url).href, CATTT_VISION_MODEL: "local-vision" },
    hold(gate: Promise<void>) { wait = gate; },
    respond(next: typeof result) { result = next; },
    stop: () => server.stop(true),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const describePath = (id: string) => filePath(id) + "/description";
const generate = (f: Fixture, photo: FileResult["file"], token?: string) => f.request(describePath(photo.id), {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ file_rev: photo.rev }), token,
});
const image = (f: Fixture, source: Record<string, unknown> = {}) =>
  f.upload(new Uint8Array(png), { ...source, media_type: "image/png", file_name: "团子.png" });

async function expectStatus(response: Response, status: string) {
  expect(await response.json()).toMatchObject({ status });
}

async function untilModelCalled(model: ReturnType<typeof mockVision>, count = 1) {
  const timeout = AbortSignal.timeout(2000);
  while (model.calls.length < count && !timeout.aborted) {
    await Bun.sleep(5);
  }
  expect(model.calls).toHaveLength(count);
}

function linkedSource(f: Fixture) {
  const { body: { message } } = sendMessage(f.host.store.db, f.host.clock, f.actor, f.group.id, {
    clientMessageId: crypto.randomUUID(), text: "团子的照片",
  });
  return { source_message_id: message.id, source_message_rev: 1 };
}

test("仅显式请求才调用本机视觉；同版并发与重启重试使用同一持久描述", async () => {
  const model = mockVision();
  const f = await fixture(model.env);
  const gate = Promise.withResolvers<void>();
  try {
    const source = linkedSource(f);
    const photo = await image(f, source);
    await expectStatus(await f.request(describePath(photo.id), { token: f.b.token }), "not_generated");
    expect((await generate(f, photo, f.b.token)).status).toBe(404);
    expect((await generate(f, { ...photo, rev: 2 })).status).toBe(409);
    expect(model.calls).toHaveLength(0);

    model.hold(gate.promise);
    const first = generate(f, photo);
    await untilModelCalled(model);
    const second = generate(f, photo);
    await expectStatus(await f.request(describePath(photo.id)), "not_generated");
    expect(model.calls).toHaveLength(1);
    gate.resolve();

    const result = await (await first).json();
    expect(result).toMatchObject({
      status: "ready", description: {
        file_id: photo.id, file_rev: 1, ...source, sha256: photo.sha256, text: "一张小照片。", model_id: "local-vision",
      },
    });
    expect(await (await second).json()).toEqual(result);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]).toEqual({
      path: "/v1/chat/completions",
      body: expect.objectContaining({
        model: "local-vision", stream: false,
        messages: [{ role: "user", content: [
          { type: "text", text: expect.any(String) },
          { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
        ] }],
      }),
    });

    rmSync(join(f.directory, "blobs", "content", photo.sha256));
    await f.restart();
    expect(await (await f.request(describePath(photo.id), { token: f.b.token })).json()).toEqual(result);
    expect(await (await generate(f, photo)).json()).toEqual(result);
    expect(model.calls).toHaveLength(1);
    const { readVerifiedFileDescription } = await import("../src/store/file-descriptions.ts");
    expect(readVerifiedFileDescription(f.host.store.db, { fileId: photo.id, fileRev: 1 })?.text).toBe("一张小照片。");
  } finally {
    gate.resolve();
    await f.stop();
    await model.stop();
  }
});

test("本机原件缺失、同长度哈希损坏及伪造图片类型均不会触发模型", async () => {
  const model = mockVision();
  const f = await fixture(model.env);
  try {
    const photo = await image(f);
    const path = join(f.directory, "blobs", "content", photo.sha256);
    rmSync(path);
    await expectStatus(await f.request(describePath(photo.id)), "blob_unavailable");
    await expectStatus(await generate(f, photo), "blob_unavailable");

    const corrupt = Buffer.from(png);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    writeFileSync(path, corrupt);
    await expectStatus(await generate(f, photo), "blob_unavailable");

    const disguised = await f.upload("这是文本", { media_type: "image/png" });
    expect((await generate(f, disguised)).status).toBe(415);
    expect(model.calls).toHaveLength(0);

    writeFileSync(path, png);
    await expectStatus(await generate(f, photo), "ready");
    expect(model.calls).toHaveLength(1);
  } finally {
    await f.stop();
    await model.stop();
  }
});

test("视觉配置缺失或指向非回环时拒绝；聊天模型配置不触发视觉", async () => {
  const model = mockVision();
  try {
    for (const env of [
      { MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_BASE_URL: model.env.CATTT_VISION_BASE_URL, OPENAI_COMPAT_MODEL: "chat" },
      { ...model.env, CATTT_VISION_BASE_URL: model.env.CATTT_VISION_BASE_URL.replace("127.0.0.1", "0.0.0.0") },
      { ...model.env, CATTT_VISION_BASE_URL: model.env.CATTT_VISION_BASE_URL.replace("127.0.0.1", "example.invalid") },
    ]) {
      const f = await fixture(env);
      try {
        const photo = await image(f);
        await expectStatus(await generate(f, photo), "model_unavailable");
      } finally {
        await f.stop();
      }
    }
    expect(model.calls).toHaveLength(0);
  } finally {
    await model.stop();
  }
});

test("视觉 HTTP 禁止跟随重定向或使用环境代理，故障后可重试", async () => {
  const target = mockVision();
  const model = mockVision();
  const f = await fixture(model.env);
  const proxy = process.env.http_proxy;
  const noProxy = process.env.no_proxy;
  try {
    const photo = await image(f);
    process.env.http_proxy = target.env.CATTT_VISION_BASE_URL;
    process.env.no_proxy = "example.invalid";
    model.respond(() => Response.redirect(target.env.CATTT_VISION_BASE_URL, 307));
    await expectStatus(await generate(f, photo), "model_unavailable");
    expect(model.calls).toHaveLength(1);
    expect(target.calls).toHaveLength(0);
    model.respond(() => new Response(null, { status: 503 }));
    await expectStatus(await generate(f, photo), "model_unavailable");
    model.respond(() => Response.json({ choices: [{ message: { content: "一张照片。" }, finish_reason: "stop" }] }));
    await expectStatus(await generate(f, photo), "ready");
    expect(model.calls).toHaveLength(3);
    expect(target.calls).toHaveLength(0);
  } finally {
    if (proxy === undefined) delete process.env.http_proxy;
    else process.env.http_proxy = proxy;
    if (noProxy === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = noProxy;
    await f.stop();
    await model.stop();
    await target.stop();
  }
});

test("附件在推理途中撤回时丢弃结果且不持久化", async () => {
  const model = mockVision();
  const f = await fixture(model.env);
  const gate = Promise.withResolvers<void>();
  try {
    const photo = await image(f);
    model.hold(gate.promise);
    const request = generate(f, photo);
    await untilModelCalled(model);
    expect((await f.request(filePath(photo.id), { method: "DELETE" })).status).toBe(204);
    gate.resolve();
    expect((await request).status).toBe(404);
    expect((await f.request(describePath(photo.id))).status).toBe(404);
    expect(f.host.store.raw.query("SELECT COUNT(*) AS count FROM file_descriptions").get()).toEqual({ count: 0 });
  } finally {
    gate.resolve();
    await f.stop();
    await model.stop();
  }
});

test("R4 来源撤回在推理提交、读取与再次生成时生效，消息原话仍可展示", async () => {
  const model = mockVision();
  const f = await fixture(model.env);
  const gate = Promise.withResolvers<void>();
  try {
    const source = linkedSource(f);
    const ready = await image(f, source);
    await expectStatus(await generate(f, ready), "ready");
    const pending = await image(f, source);
    model.hold(gate.promise);
    const request = generate(f, pending);
    await untilModelCalled(model, 2);
    const withdrawal = await f.request(`/v2/conversations/${f.group.id}/messages/${source.source_message_id}/withdraw`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: crypto.randomUUID(), expected_revision: source.source_message_rev }),
    });
    expect(withdrawal.status).toBe(200);
    expect(await withdrawal.json()).toMatchObject({ source: { allowed: false } });
    gate.resolve();
    expect((await request).status).toBe(404);
    expect((await f.request(describePath(ready.id))).status).toBe(404);
    expect((await generate(f, ready)).status).toBe(404);
    expect((await f.request(filePath(ready.id))).status).toBe(200);
    const { readVerifiedFileDescription } = await import("../src/store/file-descriptions.ts");
    expect(readVerifiedFileDescription(f.host.store.db, { fileId: ready.id, fileRev: 1 })).toBeUndefined();
    expect(f.host.store.raw.query("SELECT COUNT(*) AS count FROM file_descriptions").get()).toEqual({ count: 1 });
  } finally {
    gate.resolve();
    await f.stop();
    await model.stop();
  }
});

test("已存描述在附件或来源消息修订过期时立即失效", async () => {
  const model = mockVision();
  const f = await fixture(model.env);
  try {
    const source = linkedSource(f);
    const photo = await image(f, source);
    const standalone = await image(f);
    await expectStatus(await generate(f, photo), "ready");
    await expectStatus(await generate(f, standalone), "ready");
    f.host.store.db.update(messages).set({ rev: 2 }).where(eq(messages.id, source.source_message_id)).run();
    f.host.store.db.update(files).set({ rev: 2 }).where(eq(files.id, standalone.id)).run();
    expect((await f.request(describePath(photo.id))).status).toBe(404);
    expect((await generate(f, photo)).status).toBe(404);
    await expectStatus(await f.request(describePath(standalone.id)), "not_generated");
    expect((await generate(f, standalone)).status).toBe(409);
    const { readVerifiedFileDescription } = await import("../src/store/file-descriptions.ts");
    expect(readVerifiedFileDescription(f.host.store.db, { fileId: photo.id, fileRev: 1 })).toBeUndefined();
    expect(readVerifiedFileDescription(f.host.store.db, { fileId: standalone.id, fileRev: 1 })).toBeUndefined();
    expect(model.calls).toHaveLength(2);
  } finally {
    await f.stop();
    await model.stop();
  }
});
