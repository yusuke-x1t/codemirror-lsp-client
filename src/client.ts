import type * as lsp from "vscode-languageserver-protocol"
import {showDialog} from "@codemirror/view"
import {ChangeSet, ChangeDesc, MapMode, Text, Extension} from "@codemirror/state"
import {Language} from "@codemirror/language"
import {LSPPlugin, LSPPluginOptions, lspPluginBinding} from "./plugin"
import {toPosition, fromPosition} from "./pos"
import {Workspace, WorkspaceFile, DefaultWorkspace} from "./workspace"
import {lspTheme} from "./theme"

class Request<Result> {
  declare resolve: (result: Result) => void
  declare reject: (error: any) => void
  promise: Promise<Result>

  constructor(
    readonly id: number,
    readonly params: any,
    readonly timeout: ReturnType<typeof setTimeout>
  ) {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

const clientCapabilities: lsp.ClientCapabilities = {
  general: {
    markdown: {
      parser: "marked",
    },
  },
  workspace: {
    configuration: true,
  },
  textDocument: {
    completion: {
      completionItem: {
        snippetSupport: true,
        documentationFormat: ["markdown", "plaintext"],
        insertReplaceSupport: false,
      },
      completionList: {
        itemDefaults: ["commitCharacters", "editRange", "insertTextFormat"]
      },
      completionItemKind: {valueSet: []},
      contextSupport: true,
    },
    hover: {
      contentFormat: ["markdown", "plaintext"]
    },
    formatting: {},
    rename: {},
    signatureHelp: {
      contextSupport: true,
      signatureInformation: {
        documentationFormat: ["markdown", "plaintext"],
        parameterInformation: {labelOffsetSupport: true},
        activeParameterSupport: true,
      },
    },
    definition: {},
    declaration: {},
    implementation: {},
    typeDefinition: {},
    references: {},
    diagnostic: {},
  },
  window: {
    showMessage: {}
  }
}

/// A workspace mapping is used to track changes made to open
/// documents, so that positions returned by a request can be
/// interpreted in terms of the current, potentially changed document.
export class WorkspaceMapping {
  /// @internal
  mappings: Map<string, ChangeDesc> = new Map
  private startDocs: Map<string, Text> = new Map

  /// @internal
  constructor(private client: LSPClient) {
    for (let file of client.workspace.files) {
      this.mappings.set(file.uri, ChangeSet.empty(file.doc.length))
      this.startDocs.set(file.uri, file.doc)
    }
  }

  /// @internal
  addChanges(uri: string, changes: ChangeDesc) {
    let known = this.mappings.get(uri)
    if (known) this.mappings.set(uri, known.composeDesc(changes))
  }

  /// Get the changes made to the document with the given URI since
  /// the mapping was created. Returns null for documents that aren't
  /// open.
  getMapping(uri: string) {
    let known = this.mappings.get(uri)
    if (!known) return null
    let file = this.client.workspace.getFile(uri), view = file?.getView(), plugin = view && LSPPlugin.get(view, this.client)
    return plugin ? known.composeDesc(plugin.unsyncedChanges) : known
  }

  /// Map a position in the given file forward to the current document state.
  mapPos(uri: string, pos: number, assoc?: number): number
  mapPos(uri: string, pos: number, assoc: number, mode: MapMode): number | null
  mapPos(uri: string, pos: number, assoc = -1, mode: MapMode = MapMode.Simple): number | null {
    let changes = this.getMapping(uri)
    return changes ? changes.mapPos(pos, assoc, mode) : pos
  }

  /// Convert an LSP-style position referring to a document at the
  /// time the mapping was created to an offset in the current document.
  mapPosition(uri: string, pos: lsp.Position, assoc?: number): number
  mapPosition(uri: string, pos: lsp.Position, assoc: number, mode: MapMode): number | null
  mapPosition(uri: string, pos: lsp.Position, assoc = -1, mode: MapMode = MapMode.Simple): number | null {
    let start = this.startDocs.get(uri)
    if (!start) throw new Error("Cannot map from a file that's not in the workspace")
    let off = fromPosition(start, pos)
    let changes = this.getMapping(uri)
    return changes ? changes.mapPos(off, assoc, mode) : off
  }

  /// Disconnect this mapping from the client so it will no longer be notified of new changes.
  destroy() {
    this.client.activeMappings = this.client.activeMappings.filter(m => m != this)
  }
}

/// An object of this type should be used to wrap whatever transport
/// layer you use to talk to your language server. Messages should
/// contain only the JSON messages, no LSP headers.
export type Transport = {
  /// Send a message to the server. Should throw if the connection is broken.
  send(message: string): void
  /// Register a handler for messages coming from the server.
  subscribe(handler: (value: string) => void): void
  /// Unregister a handler registered with `subscribe`.
  unsubscribe(handler: (value: string) => void): void
}

const defaultNotificationHandlers: {[method: string]: (client: LSPClient, params: any) => void} = {
  "window/logMessage": (client, params: lsp.LogMessageParams) => {
    if (params.type == 1) console.error("[lsp] " + params.message)
    else if (params.type == 2) console.warn("[lsp] " + params.message)
  },
  "window/showMessage": (client, params: lsp.ShowMessageParams) => {
    if (params.type > 3 /* Info */) return
    let view
    for (let f of client.workspace.files) if (view = f.getView()) break
    if (view) showDialog(view, {
      label: params.message,
      class: "cm-lsp-message cm-lsp-message-" + (params.type == 1 ? "error" : params.type == 2 ? "warning" : "info"),
      top: true
    })
  }
}

/// Configuration options that can be passed to the LSP client.
export type LSPClientConfig = {
  /// The project root URI passed to the server, when necessary.
  rootUri?: string
  /// The language server settings returned for workspace/configuration requests.
  workspaceConfiguration?: Record<string, unknown>
  /// An optional function to create a workspace object for the client to use.
  workspace?: (client: LSPClient) => Workspace
  /// The amount of milliseconds after which requests are automatically timed out. Defaults to 3000.
  timeout?: number
  /// HTML sanitizer for Markdown generated by a language server.
  sanitizeHTML?: (html: string) => string
  /// Return a language object for syntax highlighting code in Markdown.
  highlightLanguage?: (name: string) => Language | null
  /// Additional notification handlers. Return true when a notification was handled.
  notificationHandlers?: {[method: string]: (client: LSPClient, params: any) => boolean}
  /// Called when no notification handler is found.
  unhandledNotification?: (client: LSPClient, method: string, params: any) => void
  /// Additional CodeMirror extensions or LSP client extensions.
  extensions?: readonly (Extension | LSPClientExtension)[]
}

/// Objects of this type can be included in the extensions option to LSPClient.
export type LSPClientExtension = {
  /// Extra client capabilities to send to the server when initializing.
  clientCapabilities?: Record<string, any>,
  /// Additional notification handlers.
  notificationHandlers?: {[method: string]: (client: LSPClient, params: any) => boolean},
  /// An optional CodeMirror extension to include.
  editorExtension?: Extension
}

/// An LSP client manages a connection to a language server.
export class LSPClient {
  /// @internal
  transport: Transport | null = null
  /// The client's workspace.
  workspace: Workspace
  private nextReqID = 0
  private requests: Request<any>[] = []
  /// @internal
  activeMappings: WorkspaceMapping[] = []
  /// The capabilities advertised by the server.
  serverCapabilities: lsp.ServerCapabilities | null = null
  private supportSync = -1
  /// Resolves once the client connection has been initialized.
  initializing: Promise<null>
  declare private init: {resolve: (value: null) => void, reject: (err: any) => void}
  private timeout: number
  /// @internal
  extensions: Extension[] = []

  constructor(readonly config: LSPClientConfig = {}) {
    this.receiveMessage = this.receiveMessage.bind(this)
    this.initializing = new Promise((resolve, reject) => this.init = {resolve, reject})
    this.timeout = config.timeout ?? 3000
    this.workspace = config.workspace ? config.workspace(this) : new DefaultWorkspace(this)

    if (config.extensions) for (let ext of config.extensions) {
      if (Array.isArray(ext) || (ext as any).extension) this.extensions.push(ext as Extension)
      else if ((ext as LSPClientExtension).editorExtension) this.extensions.push((ext as LSPClientExtension).editorExtension!)
    }
  }

  get connected() { return !!this.transport }

  connect(transport: Transport) {
    if (this.transport) this.transport.unsubscribe(this.receiveMessage)
    this.transport = transport
    transport.subscribe(this.receiveMessage)
    let capabilities = clientCapabilities
    if (this.config.extensions) for (let ext of this.config.extensions) {
      let {clientCapabilities} = ext as LSPClientExtension
      if (clientCapabilities) capabilities = mergeCapabilities(capabilities, clientCapabilities)
    }
    this.requestInner<lsp.InitializeParams, lsp.InitializeResult>("initialize", {
      processId: null,
      clientInfo: {name: "@codemirror/lsp-client"},
      rootUri: this.config.rootUri || null,
      capabilities
    }).promise.then(resp => {
      this.serverCapabilities = resp.capabilities
      let sync = resp.capabilities.textDocumentSync
      this.supportSync = sync == null ? 0 : typeof sync == "number" ? sync : sync.change ?? 0
      transport.send(JSON.stringify({jsonrpc: "2.0", method: "initialized", params: {}}))
      if (this.config.workspaceConfiguration) {
        transport.send(JSON.stringify({
          jsonrpc: "2.0",
          method: "workspace/didChangeConfiguration",
          params: {settings: this.config.workspaceConfiguration}
        }))
      }
      this.init.resolve(null)
    }, this.init.reject)
    this.workspace.connected()
    return this
  }

  disconnect() {
    if (this.transport) this.transport.unsubscribe(this.receiveMessage)
    this.serverCapabilities = null
    this.initializing = new Promise((resolve, reject) => this.init = {resolve, reject})
    this.workspace.disconnected()
  }

  plugin(fileURI: string, languageID?: string, options?: LSPPluginOptions): Extension {
    return [
      lspPluginBinding({client: this, uri: fileURI, languageID, options}),
      lspTheme,
      this.extensions
    ]
  }

  didOpen(file: WorkspaceFile) {
    this.notification<lsp.DidOpenTextDocumentParams>("textDocument/didOpen", {
      textDocument: {
        uri: file.uri,
        languageId: file.languageId,
        text: file.doc.toString(),
        version: file.version
      }
    })
  }

  didClose(uri: string) {
    this.notification<lsp.DidCloseTextDocumentParams>("textDocument/didClose", {textDocument: {uri}})
  }

  private receiveMessage(msg: string) {
    const value = JSON.parse(msg) as lsp.ResponseMessage | lsp.NotificationMessage | lsp.RequestMessage
    if ("id" in value && !("method" in value)) {
      let index = this.requests.findIndex(r => r.id == value.id)
      if (index < 0) {
        console.warn(`[lsp] Received a response for non-existent request ${value.id}`)
      } else {
        let req = this.requests[index]
        clearTimeout(req.timeout)
        this.requests.splice(index, 1)
        if (value.error) req.reject(value.error)
        else req.resolve(value.result)
      }
    } else if (!("id" in value)) {
      let handler = this.config.notificationHandlers?.[value.method]
      if (handler && handler(this, value.params)) return
      if (this.config.extensions) for (let ext of this.config.extensions) {
        let {notificationHandlers} = ext as LSPClientExtension
        let handler = notificationHandlers?.[value.method]
        if (handler && handler(this, value.params)) return
      }
      let deflt = defaultNotificationHandlers[value.method]
      if (deflt) deflt(this, value.params)
      else if (this.config.unhandledNotification) this.config.unhandledNotification(this, value.method, value.params)
    } else {
      if (value.method === "workspace/configuration") {
        const params = value.params as {items?: Array<{section?: string}>}
        const configuration = this.config.workspaceConfiguration ?? {}
        const result = (params.items ?? []).map(item => {
          if (!item.section) return configuration
          let selected: unknown = configuration
          for (const key of item.section.split(".")) {
            if (selected == null || typeof selected !== "object") return null
            selected = (selected as Record<string, unknown>)[key]
          }
          return selected ?? null
        })
        const response: lsp.ResponseMessage = {
          jsonrpc: "2.0",
          id: value.id,
          result
        }
        this.transport!.send(JSON.stringify(response))
        return
      }
      let resp: lsp.ResponseMessage = {
        jsonrpc: "2.0",
        id: value.id,
        error: {code: -32601 /* MethodNotFound */, message: "Method not implemented"}
      }
      this.transport!.send(JSON.stringify(resp))
    }
  }

  request<Params, Result>(method: string, params: Params): Promise<Result> {
    if (!this.transport) return Promise.reject(new Error("Client not connected"))
    return this.initializing.then(() => this.requestInner<Params, Result>(method, params).promise)
  }

  private requestInner<Params, Result>(
    method: string,
    params: Params,
    mapped = false
  ): Request<Result> {
    let id = ++this.nextReqID, data: lsp.RequestMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params: params as any
    }
    let req = new Request<Result>(id, params, setTimeout(() => this.timeoutRequest(req), this.timeout))
    this.requests.push(req)
    try { this.transport!.send(JSON.stringify(data)) }
    catch(e) { req.reject(e) }
    return req
  }

  notification<Params>(method: string, params: Params) {
    if (!this.transport) return
    this.initializing.then(() => {
      let data: lsp.NotificationMessage = {
        jsonrpc: "2.0",
        method,
        params: params as any
      }
      this.transport!.send(JSON.stringify(data))
    })
  }

  cancelRequest(params: any) {
    let found = this.requests.find(r => r.params === params)
    if (found) this.notification("$/cancelRequest", {id: found.id})
  }

  /// @internal
  hasCapability(name: keyof lsp.ServerCapabilities) {
    return this.serverCapabilities ? !!this.serverCapabilities[name] : null
  }

  workspaceMapping() {
    let mapping = new WorkspaceMapping(this)
    this.activeMappings.push(mapping)
    return mapping
  }

  withMapping<T>(f: (mapping: WorkspaceMapping) => Promise<T>): Promise<T> {
    let mapping = this.workspaceMapping()
    return f(mapping).finally(() => mapping.destroy())
  }

  sync() {
    for (let {file, changes, prevDoc} of this.workspace.syncFiles()) {
      for (let mapping of this.activeMappings)
        mapping.addChanges(file.uri, changes)
      if (this.supportSync) this.notification<lsp.DidChangeTextDocumentParams>("textDocument/didChange", {
        textDocument: {uri: file.uri, version: file.version},
        contentChanges: contentChangesFor(file, prevDoc, changes, this.supportSync == 2 /* Incremental */)
      })
    }
  }

  private timeoutRequest(req: Request<any>) {
    let index = this.requests.indexOf(req)
    if (index > -1) {
      req.reject(new Error("Request timed out"))
      this.requests.splice(index, 1)
    }
  }
}

const enum Sync { AlwaysIfSmaller = 1024 }

function contentChangesFor(
  file: WorkspaceFile,
  startDoc: Text,
  changes: ChangeSet,
  supportInc: boolean
): lsp.TextDocumentContentChangeEvent[] {
  if (!supportInc || file.doc.length < Sync.AlwaysIfSmaller)
    return [{text: file.doc.toString()}]
  let events: lsp.TextDocumentContentChangeEvent[] = []
  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    events.push({
      range: {start: toPosition(startDoc, fromA), end: toPosition(startDoc, toA)},
      text: inserted.toString()
    })
  })
  return events.reverse()
}

function mergeCapabilities(base: any, add?: any) {
  if (add == null) return base
  if (typeof base != "object" || typeof add != "object") return add
  let result: Record<string, any> = {}
  let baseProps = Object.keys(base), addProps = Object.keys(add)
  for (let prop of baseProps)
    result[prop] = addProps.indexOf(prop) > -1 ? mergeCapabilities(base[prop], add[prop]) : base[prop]
  for (let prop of addProps)
    if (baseProps.indexOf(prop) < 0) result[prop] = add[prop]
  return result
}
