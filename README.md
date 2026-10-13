# TypeScript language server playground

Run `npm install`, then `npm run demo`. The Node-only client starts the local
TypeScript language server over stdio, opens the two JavaScript files, and
prints the JSON-RPC traffic. It asks for hover and definition at the `greet`
call and waits for TypeScript's intentional `number`-is-not-`string` diagnostic
before shutting the server down.

`tsconfig.json` enables JavaScript checking (`allowJs` and `checkJs`) without
emitting output. The framing code in `client.js` uses byte-counted
`Content-Length` headers, so it can handle partial and coalesced process output.

## What happens during the run

The client launches `typescript-language-server --stdio`. Each arrow in the
console is one JSON-RPC message: `→` goes to the server; `←` comes back. On the
wire, each JSON body is preceded by a header such as
`Content-Length: 82\r\n\r\n` (the number is the body's **byte** length).
The examples below omit most parameters and response fields; the server may
also send informational notifications such as `window/logMessage`.

1. **Handshake.** The client sends an `initialize` **request** with workspace
   information and its capabilities. The server replies with the same `id` and
   its capabilities (including hover and definition support). The client then
   sends an `initialized` **notification**:

   ```text
   → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"rootUri":"file:///.../lsp-playground/","capabilities":{}}}
   ← {"jsonrpc":"2.0","id":1,"result":{"capabilities":{"hoverProvider":true,"definitionProvider":true}}}
   → {"jsonrpc":"2.0","method":"initialized","params":{}}
   ```

2. **Share file contents.** The client sends `textDocument/didOpen` for
   `greeter.js` and `main.js`, then a full-content `textDocument/didChange` for
   `main.js` at version 2 (a redundant full-content update to illustrate
   changes). These are notifications: they have no `id` and receive no direct
   response. The server analyzes the text the client sent.

   ```text
   → {"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///.../main.js","version":1,"text":"..."}}}
   → {"jsonrpc":"2.0","method":"textDocument/didChange","params":{"textDocument":{"uri":"file:///.../main.js","version":2},"contentChanges":[{"text":"..."}]}}
   ```

3. **Ask about `greet`.** The client sends `textDocument/hover` and then
   `textDocument/definition` for line 3, character 0 of `main.js` (LSP
   positions start at zero). Each request has an `id`; the matching response
   contains hover text or a source location. Here definition points to the
   imported `greet` binding in `main.js`.

   ```text
   → {"jsonrpc":"2.0","id":2,"method":"textDocument/hover","params":{"textDocument":{"uri":"file:///.../main.js"},"position":{"line":3,"character":0}}}
   ← {"jsonrpc":"2.0","id":2,"result":{"contents":{"kind":"markdown","value":"..."}}}
   → {"jsonrpc":"2.0","id":3,"method":"textDocument/definition","params":{"textDocument":{"uri":"file:///.../main.js"},"position":{"line":3,"character":0}}}
   ← {"jsonrpc":"2.0","id":3,"result":[{"uri":"file:///.../main.js","range":{"start":{"line":0,"character":8},"end":{"line":0,"character":13}}}]}
   ```

4. **Receive diagnostics.** The server sends
   `textDocument/publishDiagnostics` without being asked directly. One
   diagnostic reports that `greet(42)` passes a number where a string is
   expected (code 2345). Server notifications can arrive *between* request
   responses; their exact timing is not guaranteed.

   ```text
   ← {"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{"uri":"file:///.../main.js","diagnostics":[{"code":2345,"message":"Argument of type 'number' is not assignable to parameter of type 'string'."}]}}
   ```

5. **Close cleanly.** The client sends a `shutdown` request, waits for its
   response, then sends an `exit` notification. Requests have an `id` and
   expect a response; notifications have no `id` and do not.

   ```text
   → {"jsonrpc":"2.0","id":4,"method":"shutdown","params":null}
   ← {"jsonrpc":"2.0","id":4,"result":null}
   → {"jsonrpc":"2.0","method":"exit","params":null}
   ```
