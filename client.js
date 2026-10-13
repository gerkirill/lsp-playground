#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const fs = require("node:fs");

const root = __dirname;
const timeoutMs = 10_000;
const serverPath = path.join(root, "node_modules", ".bin", "typescript-language-server");
const child = spawn(serverPath, ["--stdio"], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
let buffer = Buffer.alloc(0);
let expectedBodyLength = null;
let closed = false;
const pending = new Map();
const rootUri = pathToFileURL(root + path.sep).href;

function show(direction, message) {
  console.log(`\n${direction}\n${JSON.stringify(message, null, 2)}`);
}

function send(message) {
  show("→ client", message);
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  child.stdin.write(Buffer.concat([header, body]));
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, method });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function receive(message) {
  show("← server", message);
  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    const operation = pending.get(message.id);
    if (operation) {
      clearTimeout(operation.timer);
      pending.delete(message.id);
      if (message.error) operation.reject(new Error(`${operation.method}: ${message.error.message}`));
      else operation.resolve(message.result);
    }
  }
  if (message.method === "textDocument/publishDiagnostics" && message.params?.uri === mainUri) {
    diagnosticsWaiter?.(message.params.diagnostics);
    diagnosticsWaiter = null;
  }
}

function parseOutput(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    if (expectedBodyLength === null) {
      const separator = buffer.indexOf("\r\n\r\n");
      if (separator === -1) return;
      const headers = buffer.subarray(0, separator).toString("ascii");
      const match = headers.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
      if (!match) throw new Error(`Invalid LSP header: ${headers}`);
      expectedBodyLength = Number(match[1]);
      buffer = buffer.subarray(separator + 4);
    }
    if (buffer.length < expectedBodyLength) return;
    const body = buffer.subarray(0, expectedBodyLength).toString("utf8");
    buffer = buffer.subarray(expectedBodyLength);
    expectedBodyLength = null;
    receive(JSON.parse(body));
  }
}

const mainUri = pathToFileURL(path.join(root, "main.js")).href;
let diagnosticsWaiter;

function waitForMainDiagnostics() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      diagnosticsWaiter = null;
      reject(new Error("Timed out waiting for main.js diagnostics"));
    }, timeoutMs);
    diagnosticsWaiter = (diagnostics) => {
      clearTimeout(timer);
      resolve(diagnostics);
    };
  });
}

async function run() {
  child.stdout.on("data", (chunk) => {
    try {
      parseOutput(chunk);
    } catch (error) {
      fail(error);
    }
  });
  child.stderr.on("data", (chunk) => process.stderr.write(`[server stderr] ${chunk}`));
  child.on("error", fail);
  child.on("exit", (code, signal) => {
    closed = true;
    if (!shuttingDown && !fatalError) fail(new Error(`Language server exited early (${signal || code})`));
  });

  let shuttingDown = false;
  let fatalError = null;
  function fail(error) {
    if (fatalError) return;
    fatalError = error instanceof Error ? error : new Error(String(error));
    console.error(`\nDemo failed: ${fatalError.message}`);
    for (const operation of pending.values()) {
      clearTimeout(operation.timer);
      operation.reject(fatalError);
    }
    pending.clear();
    child.kill();
  }

  try {
    await request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
      capabilities: {
        textDocument: { publishDiagnostics: {} },
      },
    });
    notify("initialized", {});

    const files = ["greeter.js", "main.js"].map((name) => {
      const filePath = path.join(root, name);
      return { uri: pathToFileURL(filePath).href, text: fs.readFileSync(filePath, "utf8") };
    });
    const diagnosticsPromise = waitForMainDiagnostics();
    for (const file of files) {
      notify("textDocument/didOpen", {
        textDocument: { uri: file.uri, languageId: "javascript", version: 1, text: file.text },
      });
    }
    // A full-content change ensures the server has analyzed the opened project.
    const mainFile = files.find((file) => file.uri === mainUri);
    notify("textDocument/didChange", {
      textDocument: { uri: mainUri, version: 2 },
      contentChanges: [{ text: mainFile.text }],
    });

    const callPosition = { line: 3, character: 0 };
    const textDocument = { uri: mainUri };
    await request("textDocument/hover", { textDocument, position: callPosition });
    await request("textDocument/definition", { textDocument, position: callPosition });

    const diagnostics = await diagnosticsPromise;
    if (!diagnostics.some((diagnostic) => diagnostic.code === 2345)) {
      throw new Error("main.js did not report the expected TS2345 argument type error");
    }
    console.log(`\nReceived ${diagnostics.length} diagnostic(s) for main.js.`);

    shuttingDown = true;
    await request("shutdown", null);
    notify("exit", null);
    child.stdin.end();
    await new Promise((resolve, reject) => {
      if (closed) return resolve();
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Timed out waiting for language server to exit"));
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch (error) {
    fail(error);
    if (!closed) await new Promise((resolve) => child.once("exit", resolve));
    process.exitCode = 1;
  }
}

run();
