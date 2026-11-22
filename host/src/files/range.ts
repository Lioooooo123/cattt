function parseRange(header: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!match || size === 0) {
    return undefined;
  }
  // Comparing as BigInt permits valid end/suffix values above MAX_SAFE_INTEGER.
  const last = BigInt(size - 1);
  const [, startText, endText] = match;
  if (!startText) {
    if (!endText || BigInt(endText) === 0n) {
      return undefined;
    }
    const suffix = BigInt(endText);
    return { start: suffix > last ? 0 : size - Number(suffix), end: size - 1 };
  }
  const start = BigInt(startText);
  const end = endText ? BigInt(endText) : last;
  return start <= end && start <= last
    ? { start: Number(start), end: Number(end > last ? last : end) }
    : undefined;
}

export function blobResponse(request: Request, blob: Bun.BunFile, identity: { sha256: string; byteSize: number; fileName: string }): Response {
  const { sha256, byteSize, fileName } = identity;
  const etag = `"${sha256}"`;
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName).replace(/[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    "content-type": "application/octet-stream",
    "x-content-type-options": "nosniff",
    etag,
  });
  const range = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  if (range && /^bytes=/i.test(range) && (ifRange === null || ifRange === etag)) {
    const selection = parseRange(range, byteSize);
    if (!selection) {
      headers.set("content-range", `bytes */${byteSize}`);
      return new Response(null, { status: 416, headers });
    }
    const { start, end } = selection;
    headers.set("content-range", `bytes ${start}-${end}/${byteSize}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(blob.slice(start, end + 1), { status: 206, headers });
  }
  headers.set("content-length", String(byteSize));
  return new Response(blob, { headers });
}
