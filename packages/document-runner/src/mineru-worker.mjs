import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/** Controlled parser failures never include document content, native diagnostics or host paths. */
export class MineruError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const FAILURE_CODES = new Set(["PARSER_UNAVAILABLE", "PARSER_FAILED", "PARSER_LIMIT", "OUTPUT_LIMIT"]);
const SCRIPT = fileURLToPath(new URL("./mineru_worker.py", import.meta.url));

/** One long-lived Basic parser. Requests are serialized and cancellation kills its process group. */
export class MineruWorker {
  #python; #config; #child; #boot; #ready = false; #pending; #stopping;
  #tail = Promise.resolve(); #closed = false; #restart; #homePromise;
  #jobsRoot; #workspaceRoot; #maxBytes; #startupMs; #abortStartup = false;
  constructor({ python, config, maxBytes = 8 * 1024 * 1024, startupMs = 120000, jobsRoot = tmpdir(), workspaceRoot = tmpdir() } = {}) {
    this.#python = python;
    this.#config = config;
    this.#maxBytes = maxBytes;
    this.#startupMs = startupMs;
    this.#jobsRoot = resolve(jobsRoot);
    this.#workspaceRoot = resolve(workspaceRoot);
  }
  /** Configuration is an operator capability, never a PDF request parameter. */
  get configured() { return typeof this.#python === "string" && typeof this.#config === "string"; }
  /** True only after exact-version offline model preloading has completed. */
  get ready() { return this.#ready; }
  /** Begin asynchronous model preloading; failures leave the original PDF operations usable. */
  warm() {
    if (this.configured && !this.#closed) void this.#ensure().catch(() => this.#scheduleRestart());
  }
  #scheduleRestart() {
    if (this.#closed || this.#restart) return;
    this.#restart = setTimeout(() => { this.#restart = undefined; this.warm(); }, 2000);
    this.#restart.unref();
  }
  async #ensure() {
    if (this.#closed || !this.configured) throw new MineruError("PARSER_UNAVAILABLE");
    if (this.#stopping) await this.#stopping;
    if (this.#boot) return this.#boot;
    this.#abortStartup = false;
    this.#boot = this.#spawn();
    try { await this.#boot; }
    catch (error) { this.#boot = undefined; throw error; }
  }
  async #spawn() {
    if (!isAbsolute(this.#python) || !isAbsolute(this.#config)) throw new MineruError("PARSER_UNAVAILABLE");
    let config;
    try { config = await lstat(this.#config); } catch { throw new MineruError("PARSER_UNAVAILABLE"); }
    if (!config.isFile() || config.isSymbolicLink() || config.nlink !== 1 || config.size > 65536 ||
        (config.mode & 0o777) !== 0o600 || (process.getuid && config.uid !== process.getuid())) {
      throw new MineruError("PARSER_UNAVAILABLE");
    }
    if (this.#closed || this.#abortStartup) throw new MineruError("PARSER_UNAVAILABLE");
    this.#homePromise ??= mkdtemp(join(this.#workspaceRoot, "cfos-mineru-"));
    const workspace = await this.#homePromise;
    if (this.#closed || this.#abortStartup) throw new MineruError("PARSER_UNAVAILABLE");
    const runtime = dirname(this.#config);
    const child = spawn(this.#python, ["-u", "-B", SCRIPT, "--jobs-root", this.#jobsRoot], {
      cwd: workspace, detached: process.platform !== "win32", shell: false,
      // No shell/credential inheritance. No provider or model-hub authentication is available.
      env: {
        PATH: `${dirname(this.#python)}:/opt/homebrew/bin:/usr/bin:/bin`,
        HOME: join(runtime, "home"), TMPDIR: workspace, LANG: "en_US.UTF-8",
        MINERU_CONFIG: this.#config, MINERU_HOME: join(workspace, "mineru-home"),
        MINERU_MODEL_SOURCE: "local", MINERU_MODEL_SMALL_BACKEND: "torch",
        HF_HOME: join(workspace, "huggingface"), TORCH_HOME: join(workspace, "torch"),
        MODELSCOPE_CACHE: join(workspace, "modelscope"), XDG_CACHE_HOME: join(workspace, "cache"),
        HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1",
        HF_HUB_DISABLE_XET: "1", DO_NOT_TRACK: "1", TOKENIZERS_PARALLELISM: "false",
        OMP_NUM_THREADS: "8", MKL_NUM_THREADS: "8", OPENBLAS_NUM_THREADS: "8",
        VECLIB_MAXIMUM_THREADS: "8", NUMEXPR_NUM_THREADS: "8", MINERU_CPU_NUM_THREADS: "8",
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.#child = child;
    let resolveBoot, rejectBoot;
    const boot = new Promise((res, rej) => { resolveBoot = res; rejectBoot = rej; });
    const timer = setTimeout(() => { void this.#terminate("PARSER_UNAVAILABLE"); }, this.#startupMs);
    let buffer = "";
    let closed;
    const closePromise = new Promise(resolveClose => { closed = resolveClose; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16384) { void this.#terminate("PARSER_FAILED"); return; }
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { void this.#terminate("PARSER_FAILED"); return; }
        if (!this.#ready && message.type === "ready" && message.version === "4.0.12" && message.tier === "basic") {
          this.#ready = true; clearTimeout(timer); resolveBoot();
        } else if (this.#ready && this.#pending && message.id === this.#pending.id && typeof message.ok === "boolean") {
          const pending = this.#pending; this.#pending = undefined;
          if (message.ok) pending.resolve();
          else pending.reject(new MineruError(FAILURE_CODES.has(message.errorCode) ? message.errorCode : "PARSER_FAILED"));
        } else { void this.#terminate("PARSER_FAILED"); return; }
      }
    });
    child.stdin.on("error", () => { void this.#terminate("PARSER_FAILED"); });
    child.once("error", () => { rejectBoot(new MineruError("PARSER_UNAVAILABLE")); });
    child.once("close", () => {
      // A crashed parent can leave native descendants behind even after its pipes close.
      // The detached group belongs only to this worker generation.
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* The group is already gone. */ }
      }
      clearTimeout(timer);
      this.#ready = false;
      rejectBoot(new MineruError("PARSER_UNAVAILABLE"));
      this.#pending?.reject(new MineruError("PARSER_FAILED")); this.#pending = undefined;
      if (this.#child === child) { this.#child = undefined; this.#boot = undefined; }
      closed();
      this.#scheduleRestart();
    });
    // Termination waits for the process and all inherited pipes to close before directory cleanup.
    child.closePromise = closePromise;
    return boot;
  }
  async #terminate(code) {
    this.#abortStartup = true;
    const child = this.#child;
    if (!child) return;
    if (this.#stopping) return this.#stopping;
    this.#ready = false;
    this.#pending?.reject(new MineruError(code)); this.#pending = undefined;
    this.#stopping = child.closePromise;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch { /* The child may already have exited; close remains authoritative. */ }
    try { await this.#stopping; }
    finally { this.#stopping = undefined; }
  }
  /** Queue a fixed-path job. An aborted waiter never kills another job's parser request. */
  async parse(directory, pages, signal) {
    if (!this.configured || this.#closed) throw new MineruError("PARSER_UNAVAILABLE");
    let started = false;
    const run = this.#tail.then(() => { started = true; return this.#parse(directory, pages, signal); });
    this.#tail = run.catch(() => {});
    // Release the HTTP job promptly even when it was waiting behind another parser request.
    let onAbort;
    const aborted = new Promise((resolveAbort, reject) => {
      onAbort = () => { if (!started) reject(new MineruError("CANCELLED")); };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try { return await Promise.race([run, aborted]); }
    finally { signal.removeEventListener("abort", onAbort); }
  }
  async #parse(directory, pages, signal) {
    if (signal.aborted) throw new MineruError("CANCELLED");
    // These directories are minted by the Node runner, never decoded from document content.
    if (dirname(resolve(directory)) !== this.#jobsRoot || !/^cfos-pdf-[A-Za-z0-9]+$/.test(directory.split(/[\\/]/).at(-1))) {
      throw new MineruError("PARSER_FAILED");
    }
    let ownsWorker = true;
    const onAbort = () => { if (ownsWorker) void this.#terminate("CANCELLED"); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await this.#ensure();
      if (signal.aborted) throw new MineruError("CANCELLED");
      const id = randomUUID();
      const request = { id, directory: resolve(directory), pages, maxBytes: this.#maxBytes };
      await new Promise((resolveRequest, rejectRequest) => {
        this.#pending = { id, resolve: resolveRequest, reject: rejectRequest };
        this.#child.stdin.write(JSON.stringify(request) + "\n");
      });
      if (signal.aborted) throw new MineruError("CANCELLED");
      const output = join(directory, "result.json");
      const info = await lstat(output);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new MineruError("PARSER_FAILED");
      if (info.size > this.#maxBytes) throw new MineruError("OUTPUT_LIMIT");
      const result = JSON.parse(await readFile(output, "utf8"));
      if (!Array.isArray(result.pages) || result.pages.length !== pages.length ||
          result.pages.some((page, index) => page.page !== pages[index]) ||
          result.parser?.name !== "mineru" || result.parser?.version !== "4.0.12" || result.parser?.tier !== "basic") {
        throw new MineruError("PARSER_FAILED");
      }
      return result;
    } catch (error) {
      if (!(error instanceof MineruError)) { await this.#terminate("PARSER_FAILED"); throw new MineruError("PARSER_FAILED"); }
      throw error;
    } finally {
      ownsWorker = false;
      signal.removeEventListener("abort", onAbort);
      // Never remove a job's files while native code from that request may still be using them.
      if (this.#stopping) await this.#stopping;
    }
  }
  /** Kill native children, wait for exit, and erase the worker's private scratch directory. */
  async close() {
    this.#closed = true;
    clearTimeout(this.#restart);
    await this.#terminate("PARSER_UNAVAILABLE");
    await this.#tail;
    if (this.#homePromise) {
      try { await rm(await this.#homePromise, { recursive: true, force: true }); } catch { /* No document bytes are retained here. */ }
    }
  }
}
