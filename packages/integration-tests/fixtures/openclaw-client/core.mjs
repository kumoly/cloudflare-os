import { lstatSync, openSync, closeSync, readFileSync, fstatSync, writeFileSync, renameSync, unlinkSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { newWebSocketRpcSession } from 'capnweb';
import { argon2id } from 'hash-wasm';

const own = (object, key) => Object.hasOwn(object, key);
const badNames = new Set(['constructor', 'prototype', '__proto__', 'then', 'map', 'dup']);
const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export class ToolError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new ToolError(code); };
const dispose = object => { try { object?.[Symbol.dispose]?.(); } catch {} };

export function readProtected(path) {
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700 || parent.uid !== process.getuid()) fail('CREDENTIAL_STORE_INVALID');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || (file.mode & 0o777) !== 0o600 || file.uid !== process.getuid() || file.size > 65536) fail('CREDENTIAL_STORE_INVALID');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

function writeSession(path, token) {
  // Validate the existing destination before replacing it; do not create new stores implicitly.
  readProtected(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ token })}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch {} }
}

export function boundedJson(value, maxBytes = 65536) {
  const seen = new Set();
  function walk(item, depth) {
    if (depth > 20) fail('INVALID_RESULT');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item)) fail('INVALID_RESULT');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) fail('INVALID_RESULT');
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (badNames.has(key)) fail('INVALID_RESULT');
      walk(child, depth + 1);
    }
    seen.delete(item);
  }
  walk(value, 0);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > maxBytes) fail('RESULT_TOO_LARGE');
  return JSON.parse(text);
}

export class GadgetClient {
  constructor(config, { connect = newWebSocketRpcSession, readState = readProtected, contractRoot = resolve(import.meta.dirname, 'contracts') } = {}) {
    this.config = config;
    this.connect = connect;
    this.readState = readState;
    this.active = new Map();
    this.busy = new Set();
    this.ajv = new Ajv({ strict: true, allErrors: false, ownProperties: true });
    this.contracts = new Map();
    for (const [alias, gadget] of Object.entries(config.gadgets ?? {})) {
      if (!namePattern.test(alias) || !namePattern.test(gadget.contract)) fail('CONFIG_INVALID');
      const contract = JSON.parse(readFileSync(resolve(contractRoot, `${gadget.contract}.json`), 'utf8'));
      if (contract.schemaVersion !== 1 || typeof contract.version !== 'string') fail('CONTRACT_MISMATCH');
      const operations = {};
      for (const [name, operation] of Object.entries(contract.operations ?? {})) {
        if (!namePattern.test(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(operation.method) || badNames.has(operation.method) || operation.method in Object.prototype) fail('CONTRACT_MISMATCH');
        if (!['read', 'write'].includes(operation.effect) || !Array.isArray(operation.argumentOrder) || operation.argumentOrder.some(key => !own(operation.inputSchema.properties ?? {}, key))) fail('CONTRACT_MISMATCH');
        const keys = Object.keys(operation.inputSchema.properties ?? {});
        if (new Set(operation.argumentOrder).size !== keys.length || operation.argumentOrder.length !== keys.length || keys.some(key => !(operation.inputSchema.required ?? []).includes(key))) fail('CONTRACT_MISMATCH');
        if (!Number.isSafeInteger(operation.timeoutMs) || operation.timeoutMs < 1 || operation.timeoutMs > 120000) fail('CONTRACT_MISMATCH');
        if (operation.inputSchema.type !== 'object' || operation.inputSchema.additionalProperties !== false) fail('CONTRACT_MISMATCH');
        if (operation.checkStateFields !== undefined && (!operation.checkStateFields || typeof operation.checkStateFields !== 'object' || Array.isArray(operation.checkStateFields) || Object.entries(operation.checkStateFields).some(([key, value]) => badNames.has(key) || typeof value !== 'string' || badNames.has(value)))) fail('CONTRACT_MISMATCH');
        operations[name] = { ...operation, validateInput: this.ajv.compile(operation.inputSchema), validateOutput: this.ajv.compile(operation.outputSchema) };
      }
      this.contracts.set(alias, { ...contract, operations });
    }
  }

  scope(agentId, instance, alias, operation) {
    if (!agentId || !own(this.config.agents ?? {}, agentId)) fail('FORBIDDEN');
    const policy = this.config.agents[agentId];
    if (!own(this.config.identities ?? {}, policy.identity)) fail('CONFIG_INVALID');
    if (alias !== undefined) {
      if (!own(policy.allow ?? {}, alias) || !own(this.config.gadgets ?? {}, alias)) fail('FORBIDDEN');
      if (this.config.gadgets[alias].instance !== instance) fail('FORBIDDEN');
      if (operation !== undefined && !policy.allow[alias].includes(operation)) fail('FORBIDDEN');
    }
    return policy;
  }

  list(agentId, instance) {
    const policy = this.scope(agentId);
    return Object.keys(policy.allow ?? {}).filter(alias => own(this.config.gadgets, alias) && (!instance || this.config.gadgets[alias].instance === instance)).map(alias => {
      const contract = this.contracts.get(alias);
      return { gadget: alias, instance: this.config.gadgets[alias].instance, description: contract.description, contractVersion: contract.version, operations: policy.allow[alias].filter(op => own(contract.operations, op)) };
    });
  }

  describe(agentId, instance, alias) {
    const policy = this.scope(agentId, instance, alias);
    const contract = this.contracts.get(alias);
    return { gadget: alias, contractVersion: contract.version, operations: Object.fromEntries(Object.entries(contract.operations).filter(([name]) => policy.allow[alias].includes(name)).map(([name, op]) => [name, { description: op.description, inputSchema: op.inputSchema, outputSchema: op.outputSchema, effect: op.effect }])) };
  }

  async call(agentId, params, { signal, assertCurrent } = {}) {
    const { instance, gadget: alias, operation, input } = params;
    const policy = this.scope(agentId, instance, alias, operation);
    const contract = this.contracts.get(alias);
    const op = contract.operations[operation];
    if (!op) fail('FORBIDDEN');
    try { boundedJson(input); } catch { fail('INVALID_INPUT'); }
    if (!op.validateInput(input)) fail('INVALID_INPUT');
    const identity = this.config.identities[policy.identity];
    const target = this.config.gadgets[alias];
    const endpoint = this.config.instances?.[instance]?.endpoint;
    if (!endpoint) fail('CONFIG_INVALID');
    const url = new URL(endpoint);
    if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) fail('CONFIG_INVALID');
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/api') fail('CONFIG_INVALID');
    const key = `${instance}/${policy.identity}/${agentId}`;
    if ((this.active.get(key) ?? 0) >= 4) fail('BUSY');
    const lock = `${instance}/${alias}`;
    if (op.effect === 'write' && this.busy.has(lock)) fail('BUSY');
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    if (op.effect === 'write') this.busy.add(lock);
    let dispatched = false;
    const refs = [];
    let timer;
    let abort;
    let ended = false;
    const close = () => { ended = true; refs.splice(0).reverse().forEach(dispose); };
    const retain = ref => { if (ended) { dispose(ref); fail('CANCELLED'); } refs.push(ref); return ref; };
    const interrupted = new Promise((_, reject) => {
      timer = setTimeout(() => { close(); reject(new ToolError(dispatched && op.effect === 'write' ? 'OUTCOME_UNKNOWN' : 'TIMEOUT')); }, op.timeoutMs ?? 15000);
      abort = () => { close(); reject(new ToolError(dispatched && op.effect === 'write' ? 'OUTCOME_UNKNOWN' : 'CANCELLED')); };
      signal?.addEventListener('abort', abort, { once: true });
    });
    const requestId = randomUUID();
    const started = Date.now();
    try {
      if (signal?.aborted) fail('CANCELLED');
      const work = async () => {
        const rpc = retain(this.connect(endpoint));
        let session = this.readState(identity.sessionFile);
        if (typeof session?.token !== 'string') fail('AUTH_REQUIRED');
        let auth;
        try { auth = retain(await rpc.authenticate(session.token)); }
        catch (error) {
          if (error?.code !== 'INVALID_SESSION_TOKEN' || !identity.credentialsFile) throw error;
          const credentials = this.readState(identity.credentialsFile);
          if (credentials.username !== identity.expectedUsername || typeof credentials.password !== 'string') fail('AUTH_REQUIRED');
          const prefix = new Uint8Array([0xd9,0x4e,0x54,0x1d,0x29,0xc1,0x03,0x74,0x73,0x7e,0xb3,0xe3,0x34,0x6d,0x8f,0x21]);
          const salt = new Uint8Array([...prefix, ...new TextEncoder().encode(credentials.username)]);
          const hash = await argon2id({ password: credentials.password, salt, parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32, outputType: 'binary' });
          if (ended) fail('CANCELLED');
          const token = await rpc.login(credentials.username, hash);
          if (!token) fail('AUTH_REQUIRED');
          auth = retain(await rpc.authenticate(token));
          if ((await auth.whoami()).id !== identity.expectedUsername) fail('IDENTITY_MISMATCH');
          if (ended) fail('CANCELLED');
          writeSession(identity.sessionFile, token);
        }
        if ((await auth.whoami()).id !== identity.expectedUsername) fail('IDENTITY_MISMATCH');
        if (identity.requireNonAdmin && await auth.amIAdmin()) fail('IDENTITY_MISMATCH');
        const state = this.readState(target.stateFile);
        if (typeof state.workspaceId !== 'string' || !Number.isSafeInteger(state.gadgetId)) fail('CONFIG_INVALID');
        const workspace = retain(await auth.openWorkspace(state.workspaceId));
        const metadata = await workspace.getMetadata();
        if (metadata.id !== state.workspaceId || (target.requireOwner && (metadata.owner !== undefined || metadata.role !== 'build'))) fail('FORBIDDEN');
        const gadget = retain(await workspace.getGadget(state.gadgetId));
        const server = retain(await gadget.connectToGadget());
        this.scope(agentId, instance, alias, operation);
        if (ended || signal?.aborted) fail('CANCELLED');
        assertCurrent?.();
        dispatched = true;
        const args = op.argumentOrder.map(key => input[key]);
        let data = await server[op.method](...args);
        if (data === undefined && op.outputSchema.type === 'null') data = null;
        data = boundedJson(data);
        if (!op.validateOutput(data)) fail('INVALID_RESULT');
        const stateChecks = op.checkStateFields ?? target.checkStateFields;
        if (stateChecks && data !== null) {
          for (const [outputKey, stateKey] of Object.entries(stateChecks)) if (data[outputKey] !== state[stateKey]) fail('INVALID_RESULT');
        }
        return { ok: true, gadget: alias, operation, contractVersion: contract.version, data, meta: { requestId, durationMs: Date.now() - started } };
      };
      return await Promise.race([work(), interrupted]);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if (error?.code === 'INVALID_SESSION_TOKEN') fail('AUTH_REQUIRED');
      if (error?.code === 'WORKSPACE_ACCESS_DENIED' || error?.code === 'SHARE_LINKS_DISABLED') fail('FORBIDDEN');
      fail(dispatched && op.effect === 'write' ? 'OUTCOME_UNKNOWN' : 'UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      close();
      this.active.set(key, Math.max(0, (this.active.get(key) ?? 1) - 1));
      if (op.effect === 'write') this.busy.delete(lock);
    }
  }
}
