import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MineruWorker } from "./mineru-worker.mjs";
import { createDocumentRunner } from "./server.mjs";

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

async function workerFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "cfos-mineru-test-"));
  const python = join(root, "fake-python");
  const config = join(root, "config.yaml");
  await writeFile(config, "synthetic configuration", { mode: 0o600 });
  // This deterministic local protocol peer exercises the Node isolation boundary without models.
  await writeFile(python, `#!${process.execPath}
import {createInterface} from 'node:readline';
import {writeFileSync,readFileSync,appendFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
const root=dirname(process.env.MINERU_CONFIG);
if(process.env.DOCUMENT_RUNNER_TOKEN || process.env.GOOGLE_CLIENT_SECRET || process.env.HF_HUB_OFFLINE!=='1' || process.env.OMP_NUM_THREADS!=='8')process.exit(3);
appendFileSync(join(root,'events.jsonl'),JSON.stringify({kind:'spawn',pid:process.pid})+'\\n');
process.stdout.write(JSON.stringify({type:'ready',version:'4.0.12',tier:'basic'})+'\\n');
let busy=false;
createInterface({input:process.stdin}).on('line',async line=>{
 const request=JSON.parse(line);
 if(busy)process.exit(5);busy=true;
 const input=readFileSync(join(request.directory,'input.pdf'),'utf8');
 appendFileSync(join(root,'events.jsonl'),JSON.stringify({kind:'request',pid:process.pid,id:request.id,directory:request.directory})+'\\n');
 if(input.includes('crash'))process.exit(4);
 const delay=input.includes('slow')?250:10;
 await new Promise(resolve=>setTimeout(resolve,delay));
 const result={parser:{name:'mineru',version:'4.0.12',tier:'basic'},pages:request.pages.map(page=>({page,blocks:[{id:'p'+page+'-b0',order:0,type:'text',text:input}],tables:[],warnings:[]}))};
 writeFileSync(join(request.directory,'result.json'),input.includes('huge')?'x'.repeat(request.maxBytes+1):JSON.stringify(result));
 const id=input.includes('wrong-id')?'wrong-request':request.id;
 process.stdout.write(JSON.stringify({id,ok:true})+'\\n');busy=false;
});
`, { mode: 0o700 });
  const settings = { python, config, jobsRoot: root, workspaceRoot: root, ...options };
  const worker = new MineruWorker(settings);
  t.after(async () => { await worker.close(); await rm(root, { recursive: true, force: true }); });
  async function directory(text = "synthetic PDF") {
    const path = await mkdtemp(join(root, "cfos-pdf-"));
    await writeFile(join(path, "input.pdf"), text, { mode: 0o600 });
    t.after(() => rm(path, { recursive: true, force: true }));
    return path;
  }
  async function events() {
    try { return (await readFile(join(root, "events.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
    catch { return []; }
  }
  return { root, worker, settings, directory, events };
}

async function until(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await tick(10); }
  assert.fail("Worker condition did not become true");
}

test("one warm worker serializes independent jobs and preserves selected original page order", async t => {
  const { worker, directory, events } = await workerFixture(t);
  worker.warm();
  await until(() => worker.ready);
  const a = await directory("slow synthetic-A"), b = await directory("synthetic-B");
  const signal = new AbortController().signal;
  const [one, two] = await Promise.all([worker.parse(a, [7, 2], signal), worker.parse(b, [1], signal)]);
  assert.deepEqual(one.pages.map(page => page.page), [7, 2]);
  assert.equal(two.pages[0].blocks[0].text, "synthetic-B");
  const log = await events();
  assert.equal(log.filter(e => e.kind === "spawn").length, 1);
  assert.equal(new Set(log.map(e => e.pid)).size, 1);
  assert.equal(new Set(log.filter(e => e.kind === "request").map(e => e.id)).size, 2);
});

test("cancelling a queued waiter leaves the current parser and result alive", async t => {
  const { worker, directory, events } = await workerFixture(t);
  const first = worker.parse(await directory("slow survivor"), [1], new AbortController().signal);
  await until(async () => (await events()).some(e => e.kind === "request"));
  const control = new AbortController();
  const queued = worker.parse(await directory("cancelled waiter"), [2], control.signal);
  control.abort();
  await assert.rejects(queued, { code: "CANCELLED" });
  assert.equal((await first).pages[0].blocks[0].text, "slow survivor");
  assert.equal((await events()).filter(e => e.kind === "request").length, 1);
  assert.equal((await events()).filter(e => e.kind === "spawn").length, 1);
});

test("active cancellation waits for process exit before caller cleanup and next job restarts", async t => {
  const { worker, directory, events } = await workerFixture(t);
  const control = new AbortController();
  const first = worker.parse(await directory("slow cancelled owner"), [1], control.signal);
  await until(async () => (await events()).some(e => e.kind === "request"));
  const oldPid = (await events()).find(e => e.kind === "request").pid;
  control.abort();
  await assert.rejects(first, error => error.code === "CANCELLED" || error.code === "PARSER_UNAVAILABLE");
  assert.throws(() => process.kill(oldPid, 0), error => error.code === "ESRCH");
  const next = await worker.parse(await directory("fresh request"), [2], new AbortController().signal);
  assert.equal(next.pages[0].blocks[0].text, "fresh request");
  assert.equal((await events()).filter(e => e.kind === "spawn").length, 2);
});

test("crash and mismatched request replies never escape into the next job", async t => {
  const { worker, directory, events } = await workerFixture(t);
  for (const text of ["crash", "wrong-id"]) {
    await assert.rejects(worker.parse(await directory(text), [1], new AbortController().signal), error =>
      ["PARSER_FAILED", "PARSER_UNAVAILABLE"].includes(error.code));
    const next = await worker.parse(await directory("clean response"), [2], new AbortController().signal);
    assert.equal(next.pages[0].page, 2);
    assert.equal(next.pages[0].blocks[0].text, "clean response");
  }
  assert.ok((await events()).filter(e => e.kind === "spawn").length >= 3);
});

test("worker output remains bounded and bootstrap/close cannot leave a late child", async t => {
  const { worker, directory } = await workerFixture(t, { maxBytes: 2048 });
  await assert.rejects(worker.parse(await directory("huge output"), [1], new AbortController().signal), { code: "OUTPUT_LIMIT" });
  const fixtures = [];
  for (let i = 0; i < 12; i++) {
    const fixture = await workerFixture(t); fixtures.push(fixture);
    fixture.worker.warm();
    await fixture.worker.close();
  }
  await tick(50);
  for (const fixture of fixtures) {
    assert.equal(fixture.worker.ready, false);
    for (const event of await fixture.events()) assert.throws(() => process.kill(event.pid, 0));
  }
  for (const fixture of fixtures) {
    const leftovers = (await readdir(fixture.root)).filter(name => /^cfos-mineru-[A-Za-z0-9]{6}$/.test(name));
    assert.deepEqual(leftovers, []);
  }
});

test("HTTP parse is optional, validated, paginated, scoped and retains original metadata", async t => {
  const { settings, root } = await workerFixture(t);
  const pdfinfo = join(root, "pdfinfo");
  await writeFile(pdfinfo, `#!${process.execPath}\nprocess.stdout.write('Pages: 2\\nEncrypted: no\\nPDF version: 1.4\\n');\n`, { mode: 0o700 });
  const token = randomUUID().replaceAll("-", "");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const runner = createDocumentRunner({ token, mineru: settings, tools: { pdfinfo }, tempRoot: root });
  t.after(() => runner.close()); const origin = await runner.listen(0);
  const path = `/v1/scopes/${"a".repeat(64)}/jobs`;
  const request = (url, method = "GET", value) => {
    const init = { method, headers }; if (value) init.body = JSON.stringify(value);
    return fetch(origin + url, init);
  };
  await until(async () => (await (await request("/health")).json()).parseReady);
  const body = { operation: "parse", inputBase64: Buffer.from("%PDF-1.4\nsynthetic").toString("base64"), pages: [2, 1] };
  for (const extra of [{ dpi: 110 }, { language: "eng" }, { pages: Array.from({ length: 21 }, (_, i) => i + 1) }]) {
    assert.equal((await request(path, "POST", { ...body, ...extra })).status, 400);
  }
  const submit = await request(path, "POST", body); assert.equal(submit.status, 202);
  const { id } = await submit.json();
  await until(async () => (await (await request(`${path}/${id}`)).json()).status === "succeeded");
  const result = await (await request(`${path}/${id}/result?offset=0&limit=1`)).json();
  assert.equal(result.pageCount, 2); assert.equal(result.pages[0].page, 2); assert.equal(result.nextOffset, 1);
  assert.equal(result.parser.version, "4.0.12");
  assert.equal((await request(`${path.replace("a".repeat(64), "b".repeat(64))}/${id}/result`)).status, 404);
  const old = createDocumentRunner({ token, tools: { pdfinfo } });
  t.after(() => old.close()); const oldOrigin = await old.listen(0);
  const health = await (await fetch(oldOrigin + "/health", { headers })).json();
  assert.equal(health.parseReady, false); assert.ok(!health.features.includes("parse"));
  const unavailable = await fetch(oldOrigin + path, { method: "POST", headers, body: JSON.stringify(body) });
  const missingId = (await unavailable.json()).id;
  let failed;
  await until(async () => { failed = await (await fetch(oldOrigin + path + "/" + missingId, { headers })).json(); return failed.status === "failed"; });
  assert.equal(failed.errorCode, "PARSER_UNAVAILABLE");
});
