// Checks the Google Drive client and sync steps (src/browser/drive.ts) against an in-memory fake of the
// Drive REST API v3 behind a mocked fetch: queries, multipart uploads, retries, error mapping, folders,
// per-experiment backups with conflict detection, idempotent phone captures and the inbox.
//   node --experimental-strip-types --no-warnings scripts/test-drive.mts
import assert from "node:assert/strict";
process.env.TZ = "UTC"; // file names use the local time
import {
  DriveClient, DriveError, ensureFolders, listBackups, listInbox, markProcessed, quote, saveExperiment, saveFullBackup,
  uploadCapture, type CaptureUpload, type DriveFile,
} from "../src/browser/drive.ts";

// ------------------------------------------------------------------ fake Drive
interface FakeFile extends DriveFile { content: string; trashed: boolean }

class FakeDrive {
  files = new Map<string, FakeFile>();
  requests: { method: string; url: string }[] = [];
  /** Responses to return before handling normally (status, body), consumed in order. */
  failures: { status: number; body?: unknown; network?: boolean }[] = [];
  seq = 0;
  token = "tok";

  add(f: Partial<FakeFile> & { name: string }): FakeFile {
    const file: FakeFile = { id: `f${++this.seq}`, mimeType: "application/json", parents: [], appProperties: {}, content: "",
      trashed: false, version: "1", createdTime: new Date(Date.UTC(2026, 0, 1, 0, 0, this.seq)).toISOString(), ...f } as FakeFile;
    file.modifiedTime = file.createdTime;
    this.files.set(file.id, file);
    return file;
  }

  matches(f: FakeFile, q: string): boolean {
    const unq = (s: string) => s.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    const lit = "('(?:[^'\\\\]|\\\\.)*')";
    for (const m of q.matchAll(new RegExp(`name = ${lit}`, "g"))) if (f.name !== unq(m[1])) return false;
    for (const m of q.matchAll(new RegExp(`mimeType = ${lit}`, "g"))) if (f.mimeType !== unq(m[1])) return false;
    for (const m of q.matchAll(new RegExp(`${lit} in parents`, "g"))) if (!f.parents!.includes(unq(m[1]))) return false;
    for (const m of q.matchAll(new RegExp(`appProperties has \\{ key=${lit} and value=${lit} \\}`, "g"))) {
      if (f.appProperties?.[unq(m[1])] !== unq(m[2])) return false;
    }
    if (/trashed = false/.test(q) && f.trashed) return false;
    return true;
  }

  public(f: FakeFile): DriveFile {
    const { content: _c, trashed: _t, ...rest } = f;
    return { ...rest, size: String(f.content.length) };
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    this.requests.push({ method, url: url.toString() });
    const failure = this.failures.shift();
    if (failure?.network) throw new TypeError("Failed to fetch");
    if (failure) return Response.json(failure.body ?? {}, { status: failure.status });
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${this.token}`);
    const json = (b: unknown, status = 200) => Response.json(b, { status });
    const path = url.pathname;

    if (path === "/drive/v3/about") return json({ user: { emailAddress: "lab@example.org", displayName: "Lab" } });
    if (path === "/drive/v3/files" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      let found = [...this.files.values()].filter((f) => this.matches(f, q));
      const order = url.searchParams.get("orderBy") ?? "";
      found.sort((a, b) => a.createdTime!.localeCompare(b.createdTime!));
      if (/desc/.test(order)) found.reverse();
      // Pages of 2 to exercise nextPageToken.
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const page = found.slice(start, start + 2);
      found = page;
      return json({ files: page.map((f) => this.public(f)), nextPageToken: start + 2 < [...this.files.values()].filter((f) => this.matches(f, q)).length ? String(start + 2) : undefined });
    }
    if (path === "/drive/v3/files" && method === "POST") {
      const meta = JSON.parse(String(init.body));
      return json(this.public(this.add({ ...meta })));
    }
    const upload = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(path);
    if (upload) {
      assert.equal(url.searchParams.get("uploadType"), "multipart");
      const ct = (init.headers as Record<string, string>)["Content-Type"];
      const boundary = /boundary=(.+)$/.exec(ct)![1];
      const text = await (init.body as Blob).text();
      const parts = text.split(`--${boundary}`).slice(1, -1).map((p) => p.replace(/^\r\n/, "").replace(/\r\n$/, ""));
      assert.equal(parts.length, 2, "multipart has metadata and media");
      const [metaPart, mediaPart] = parts.map((p) => p.slice(p.indexOf("\r\n\r\n") + 4));
      const meta = JSON.parse(metaPart);
      const mediaType = /Content-Type: ([^\r\n]+)/.exec(parts[1])![1];
      if (upload[1]) {
        const f = this.files.get(upload[1]);
        if (!f) return json({ error: { code: 404, message: "File not found" } }, 404);
        Object.assign(f, { content: mediaPart, version: String(Number(f.version) + 1), name: meta.name ?? f.name,
          appProperties: { ...f.appProperties, ...meta.appProperties }, mimeType: mediaType });
        return json(this.public(f));
      }
      return json(this.public(this.add({ ...meta, mimeType: mediaType, content: mediaPart })));
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (one) {
      const f = this.files.get(decodeURIComponent(one[1]));
      if (!f || f.trashed) return json({ error: { code: 404, message: "File not found", errors: [{ reason: "notFound" }] } }, 404);
      if (method === "GET") return url.searchParams.get("alt") === "media" ? new Response(f.content) : json(this.public(f));
      if (method === "PATCH") {
        const add = url.searchParams.get("addParents"), remove = url.searchParams.get("removeParents");
        if (remove && !f.parents!.includes(remove)) return json({ error: { code: 400, message: "not in parent" } }, 400);
        f.parents = [...f.parents!.filter((p) => p !== remove), ...(add ? [add] : [])];
        f.version = String(Number(f.version) + 1);
        return json(this.public(f));
      }
    }
    return json({ error: { code: 400, message: `unexpected ${method} ${path}` } }, 400);
  };
}

function setup(attempts = 3) {
  const drive = new FakeDrive();
  let authErrors = 0;
  const sleeps: number[] = [];
  const client = new DriveClient({
    getToken: async () => drive.token, fetch: drive.fetch as typeof fetch, onAuthError: () => { authErrors++; },
    sleep: async (ms) => { sleeps.push(ms); }, attempts, isOnline: () => true,
  });
  return { drive, client, authErrors: () => authErrors, sleeps };
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

const blob = (s: string, type = "application/json") => new Blob([s], { type });

// ------------------------------------------------------------------ tests
await test("quote escapes quotes and backslashes", async () => {
  assert.equal(quote("O'Brien\\x"), "'O\\'Brien\\\\x'");
});

await test("about and paginated list", async () => {
  const { drive, client } = setup();
  assert.deepEqual(await client.about(), { email: "lab@example.org", name: "Lab" });
  for (let i = 0; i < 5; i++) drive.add({ name: `n${i}`, parents: ["P"] });
  drive.add({ name: "other", parents: ["Q"] });
  const files = await client.list(`${quote("P")} in parents and trashed = false`);
  assert.equal(files.length, 5);
  assert.equal(drive.requests.filter((r) => r.url.includes("/files?")).length, 3, "three pages of two");
});

await test("folders are found or created once, with names that need quoting", async () => {
  const { drive, client } = setup();
  const f = await ensureFolders(client);
  assert.equal(drive.files.size, 4);
  assert.deepEqual(drive.files.get(f.processed)!.parents, [f.inbox]);
  assert.deepEqual(drive.files.get(f.inbox)!.parents, [f.root]);
  const again = await ensureFolders(client);
  assert.deepEqual(again, f);
  assert.equal(drive.files.size, 4, "no duplicates");
  const odd = await client.folder("Lab's 'plates'", f.root);
  assert.equal(await client.folder("Lab's 'plates'", f.root), odd);
});

await test("multipart upload and update keep metadata and content", async () => {
  const { drive, client } = setup();
  const f = await client.upload({ name: "a.json", parents: ["P"], mimeType: "application/json", appProperties: { k: "v" } }, blob('{"x":1}'));
  assert.equal(drive.files.get(f.id)!.content, '{"x":1}');
  assert.deepEqual(f.appProperties, { k: "v" });
  const u = await client.update(f.id, blob('{"x":2}'), "application/json");
  assert.equal(await (await client.download(f.id)).text(), '{"x":2}');
  assert.equal(u.version, "2");
});

await test("rate limits and server errors are retried with backoff", async () => {
  const { drive, client, sleeps } = setup(4);
  drive.failures.push({ status: 429 }, { status: 503 }, { status: 403, body: { error: { code: 403, message: "x", errors: [{ reason: "userRateLimitExceeded" }] } } });
  assert.equal((await client.about()).email, "lab@example.org");
  assert.equal(sleeps.length, 3);
  assert.ok(sleeps[1] > sleeps[0] && sleeps[2] > sleeps[1], "exponential backoff");
});

await test("errors are mapped to clear kinds", async () => {
  const cases: [number, unknown, string][] = [
    [401, { error: { code: 401, message: "Invalid Credentials" } }, "auth"],
    [403, { error: { code: 403, message: "full", errors: [{ reason: "storageQuotaExceeded" }] } }, "quota"],
    [404, { error: { code: 404, message: "nope" } }, "notFound"],
    [403, { error: { code: 403, message: "no", errors: [{ reason: "insufficientFilePermissions" }] } }, "permission"],
    [400, { error: { code: 400, message: "bad" } }, "other"],
  ];
  for (const [status, body, kind] of cases) {
    const { drive, client, authErrors } = setup(1);
    drive.failures.push({ status, body });
    await assert.rejects(client.about(), (e: unknown) => e instanceof DriveError && e.kind === kind && e.message.length > 10);
    assert.equal(authErrors(), kind === "auth" ? 1 : 0);
  }
  const { drive, client } = setup(2);
  drive.failures.push({ status: 0, network: true }, { status: 0, network: true });
  await assert.rejects(client.about(), (e: unknown) => e instanceof DriveError && e.kind === "offline");
  const offline = new DriveClient({ getToken: async () => "t", fetch: drive.fetch as typeof fetch, isOnline: () => false });
  await assert.rejects(offline.about(), (e: unknown) => e instanceof DriveError && e.kind === "offline");
  const expired = new DriveClient({ getToken: async () => { throw new DriveError("auth", "expired"); }, fetch: drive.fetch as typeof fetch, isOnline: () => true });
  await assert.rejects(expired.about(), (e: unknown) => e instanceof DriveError && e.kind === "auth");
});

await test("experiment backups update in place and never overwrite edits made elsewhere", async () => {
  const { drive, client } = setup();
  const f = await ensureFolders(client);
  const exp = { uid: "u-1", name: "Hospital A / 2026" };
  // First save creates the file.
  const r1 = await saveExperiment(client, f.backups, exp, blob('{"v":1}'), undefined, "Linux computer");
  assert.equal(r1.conflict, false);
  assert.equal(r1.file.name, "Hospital A 2026.antibiogramj.json");
  let known = { fileId: r1.file.id, version: r1.file.version! };
  // Second save from the same device updates it.
  const r2 = await saveExperiment(client, f.backups, exp, blob('{"v":2}'), known, "Linux computer");
  assert.equal(r2.file.id, r1.file.id);
  assert.equal(r2.conflict, false);
  known = { fileId: r2.file.id, version: r2.file.version! };
  // Another device saves it meanwhile: this device's version is stored as a separate copy.
  drive.files.get(r1.file.id)!.version = String(Number(known.version) + 1);
  const r3 = await saveExperiment(client, f.backups, exp, blob('{"v":3}'), known, "Mac", new Date("2026-11-17T10:30:00Z"));
  assert.equal(r3.conflict, true);
  assert.notEqual(r3.file.id, r1.file.id);
  assert.equal(drive.files.get(r1.file.id)!.content, '{"v":2}', "the other device's version is untouched");
  assert.match(r3.file.name, /conflict, Mac 2026-11-17 10h30/);
  // Later saves update the conflict copy instead of creating more copies.
  const r4 = await saveExperiment(client, f.backups, exp, blob('{"v":4}'), { fileId: r3.file.id, version: r3.file.version! }, "Mac");
  assert.equal(r4.file.id, r3.file.id);
  assert.equal(r4.conflict, false);
  assert.equal(r4.file.appProperties!.conflict, "1");
  // A device that never synced this experiment does not overwrite the existing file either.
  const r5 = await saveExperiment(client, f.backups, exp, blob('{"v":5}'), undefined, "iPad");
  assert.equal(r5.conflict, true);
  // If the file was deleted in Drive, a new one is created.
  for (const file of drive.files.values()) if (file.appProperties?.uid === "u-1") file.trashed = true;
  const r6 = await saveExperiment(client, f.backups, exp, blob('{"v":6}'), known, "Linux computer");
  assert.equal(r6.conflict, false);
  assert.ok(!drive.files.get(r6.file.id)!.trashed);
  // Full backups are new files; both kinds are listed.
  await saveFullBackup(client, f.backups, blob("{}"), 3, new Date("2026-11-17T08:00:00Z"));
  const listed = await listBackups(client, f.backups);
  assert.ok(listed.some((b) => b.appProperties?.aj === "full" && b.appProperties.count === "3" && b.name.startsWith("All experiments 2026-11-17 08h00")));
});

const capture = (id: string, original = false): CaptureUpload => ({
  meta: {
    format: "antibiogramj-capture", version: 1, id, captured_at: "2026-11-17T09:15:30.000Z", device: "Android phone",
    family_id: 3, genus: "Escherichia", species: "coli", strain: "ATCC 25922", sample: "S-12", notes: "QC plate",
    width: 3000, height: 2250, thumbnail: "data:image/jpeg;base64,AAAA",
  },
  image: blob("JPEGDATA", "image/jpeg"),
  original: original ? { blob: blob("RAW", "image/jpeg"), name: "IMG_0001.JPG" } : null,
});

await test("captures upload photo, original and sidecar; retries reuse the parts already sent", async () => {
  const { drive, client } = setup(1);
  const f = await ensureFolders(client);
  // The connection drops after the photo is uploaded.
  const parts = () => [...drive.files.values()].filter((x) => x.appProperties?.capture === "cap-1");
  drive.failures.push(...Array(0));
  const realFetch = drive.fetch;
  let uploads = 0;
  (client as unknown as { opts: { fetch: typeof fetch } }).opts.fetch = (async (u: string, init?: RequestInit) => {
    if (String(u).includes("/upload/") && ++uploads === 2) throw new TypeError("network down");
    return realFetch(u, init);
  }) as typeof fetch;
  await assert.rejects(uploadCapture(client, f.inbox, capture("cap-1", true)), (e: unknown) => e instanceof DriveError && e.kind === "offline");
  assert.equal(parts().length, 1, "only the photo was uploaded");
  const sidecarId = await uploadCapture(client, f.inbox, capture("cap-1", true));
  assert.equal(parts().length, 3, "photo reused, original and sidecar added");
  assert.equal(parts().filter((p) => p.appProperties!.role === "image").length, 1);
  // Uploading again (e.g. the app was closed before recording success) does nothing.
  assert.equal(await uploadCapture(client, f.inbox, capture("cap-1", true)), sidecarId);
  assert.equal(parts().length, 3);
  const meta = JSON.parse(drive.files.get(sidecarId)!.content);
  assert.equal(meta.image, parts().find((p) => p.appProperties!.role === "image")!.id);
  assert.equal(meta.original, parts().find((p) => p.appProperties!.role === "original")!.id);
  assert.equal(meta.strain, "ATCC 25922");
  assert.match(drive.files.get(meta.image)!.name, /^2026-11-17 091530 Escherichia coli ATCC 25922 S-12 cap-1\.jpg$/);
  assert.match(drive.files.get(meta.original)!.name, / original\.jpg$/);
});

await test("the inbox lists complete captures and processed ones move to Processed", async () => {
  const { drive, client } = setup();
  const f = await ensureFolders(client);
  await uploadCapture(client, f.inbox, capture("cap-a"));
  await uploadCapture(client, f.inbox, capture("cap-b", true));
  await uploadCapture(client, f.inbox, capture("cap-c"));
  // An interrupted capture (photo without sidecar) is not listed.
  drive.add({ name: "half.jpg", parents: [f.inbox], mimeType: "image/jpeg", appProperties: { capture: "cap-x", role: "image" } });
  const items = await listInbox(client, f.inbox);
  assert.deepEqual(items.map((i) => i.meta.id).sort(), ["cap-a", "cap-b", "cap-c"]);
  const b = items.find((i) => i.meta.id === "cap-b")!;
  await markProcessed(client, f, { sidecarId: b.sidecar.id, image: b.meta.image, original: b.meta.original });
  for (const id of [b.sidecar.id, b.meta.image, b.meta.original!]) assert.deepEqual(drive.files.get(id)!.parents, [f.processed]);
  // Repeating it (a retry after a partial failure) is harmless.
  await markProcessed(client, f, { sidecarId: b.sidecar.id, image: b.meta.image, original: b.meta.original });
  assert.deepEqual((await listInbox(client, f.inbox)).map((i) => i.meta.id).sort(), ["cap-a", "cap-c"]);
  // A part deleted by the user is ignored.
  const a = items.find((i) => i.meta.id === "cap-a")!;
  drive.files.get(a.meta.image)!.trashed = true;
  await markProcessed(client, f, { sidecarId: a.sidecar.id, image: a.meta.image, original: null });
  assert.deepEqual(drive.files.get(a.sidecar.id)!.parents, [f.processed]);
});

console.log(`\n${passed} tests passed`);
