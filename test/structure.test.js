import assert from "node:assert/strict"
import test from "node:test"
import { ANCHOR_DELIMITER, AnchorStore, fileSkeleton, getFunction } from "../src/index.js"

const content = `import fs from "node:fs"

function alpha() {
  return 1
}

const beta = (value) => {
  return value + 1
}

class Gamma {
  method() {
    return beta(1)
  }
}
`

test("fileSkeleton returns anchored declaration outline", () => {
  const store = new AnchorStore()
  const result = fileSkeleton({ path: "demo.js", content, store, sessionId: "struct" })

  assert.match(result.text, /Skeleton Lines: 4/)
  assert(result.entries.some((entry) => entry.text === "function alpha() {" && entry.kind === "function"))
  assert(result.entries.some((entry) => entry.text === "class Gamma {" && entry.kind === "class"))
  assert.match(result.text, new RegExp(`${result.entries[0].anchor}${ANCHOR_DELIMITER}`))
  assert.equal(result.telemetry.operation, "file_skeleton")
})

test("getFunction returns anchored range for named JavaScript symbol", () => {
  const store = new AnchorStore()
  const result = getFunction({ path: "demo.js", content, store, sessionId: "struct", name: "beta" })

  assert.equal(result.found, true)
  assert.equal(result.symbolStartLine, 7)
  assert.equal(result.symbolEndLine, 9)
  assert.match(result.text, /§const beta = \(value\) => \{/)
  assert.match(result.text, /§  return value \+ 1/)
  assert.equal(result.telemetry.operation, "get_function")
})

test("getFunction returns not found without throwing", () => {
  const store = new AnchorStore()
  const result = getFunction({ path: "demo.js", content, store, sessionId: "struct", name: "missing" })

  assert.equal(result.found, false)
  assert.match(result.text, /symbol not found: missing/)
})

test("fileSkeleton telemetry shows tokens avoided versus full file", () => {
  // Build a large file: many long non-skeleton lines between declarations so
  // the skeleton response is clearly smaller than the full raw content.
  const bigContent = [
    `import fs from "node:fs"`,
    ...Array.from({ length: 30 }, (_, i) => `const _unused${i} = ${i} * 100 + Math.random() + "padding"`),
    `function alpha() {`,
    ...Array.from({ length: 30 }, (_, i) => `  const step${i} = ${i} + 1 // long filler comment padding`),
    `}`,
    ...Array.from({ length: 30 }, (_, i) => `const _pad${i} = "more filler line content for ${i}"`),
    `class Gamma {}`,
  ].join("\n")

  const store = new AnchorStore()
  const result = fileSkeleton({ path: "big.js", content: bigContent, store, sessionId: "telem" })

  assert(result.telemetry.estimatedTokensAvoided > 0, "skeleton should avoid tokens vs full file read")
  assert(result.telemetry.responseBytes < result.telemetry.fullBytes, "skeleton response is smaller than full file")
})

const tsContent = `import { readFile } from "node:fs/promises"

export interface Config {
  port: number
  host: string
}

export type Handler = (req: Request) => Response

export class Server {
  constructor(private config: Config) {}

  start() {
    return this
  }
}

export async function createServer(config: Config): Promise<Server> {
  return new Server(config)
}

export const handleRequest = async (req: Request) => {
  return new Response("ok")
}

export default function defaultExport() {
  return null
}
`

test("fileSkeleton finds TypeScript interface, type alias, class, and functions", () => {
  const store = new AnchorStore()
  const result = fileSkeleton({ path: "server.ts", content: tsContent, store, sessionId: "ts" })

  assert(result.entries.some((e) => e.text.includes("interface Config")), "interface Config")
  assert(result.entries.some((e) => e.text.includes("type Handler")), "type Handler")
  assert(result.entries.some((e) => e.text.includes("class Server")), "class Server")
  assert(result.entries.some((e) => e.text.includes("createServer")), "async function createServer")
  assert(result.entries.some((e) => e.text.includes("handleRequest")), "const handleRequest arrow")
  assert(result.entries.some((e) => e.text.includes("defaultExport")), "export default function")
})

test("getFunction finds TypeScript interface by name", () => {
  const store = new AnchorStore()
  const result = getFunction({ path: "server.ts", content: tsContent, store, sessionId: "ts", name: "Config" })

  assert.equal(result.found, true)
  assert.match(result.text, /interface Config/)
  assert.match(result.text, /port: number/)
})

test("getFunction finds export default function", () => {
  const store = new AnchorStore()
  const result = getFunction({ path: "server.ts", content: tsContent, store, sessionId: "ts", name: "defaultExport" })

  assert.equal(result.found, true)
  assert.match(result.text, /defaultExport/)
})

const pyContent = `import os
from pathlib import Path

class Config:
    def __init__(self, port: int):
        self.port = port

    def validate(self) -> bool:
        return self.port > 0

def create_config(port: int) -> Config:
    return Config(port)

async def fetch_data(url: str) -> dict:
    return {}
`

test("fileSkeleton finds Python class and functions", () => {
  const store = new AnchorStore()
  const result = fileSkeleton({ path: "config.py", content: pyContent, store, sessionId: "py" })

  assert(result.entries.some((e) => e.text.includes("class Config")), "class Config")
  assert(result.entries.some((e) => e.text.includes("def create_config")), "def create_config")
  assert(result.entries.some((e) => e.text.includes("async def fetch_data")), "async def fetch_data")
})

test("getFunction finds Python function with indent-based end detection", () => {
  const store = new AnchorStore()
  const result = getFunction({ path: "config.py", content: pyContent, store, sessionId: "py", name: "create_config" })

  assert.equal(result.found, true)
  assert.match(result.text, /def create_config/)
  assert.match(result.text, /return Config\(port\)/)
})

const rustContent = `use std::fs;

pub struct Config {
    pub port: u16,
}

pub trait Handler {
    fn handle(&self) -> String;
}

impl Config {
    pub fn new(port: u16) -> Self {
        Config { port }
    }
}

pub fn create_config(port: u16) -> Config {
    Config::new(port)
}

pub async fn async_helper() -> String {
    String::new()
}
`

test("fileSkeleton finds Rust struct, trait, impl, and functions", () => {
  const store = new AnchorStore()
  const result = fileSkeleton({ path: "lib.rs", content: rustContent, store, sessionId: "rs" })

  assert(result.entries.some((e) => e.text.includes("struct Config")), "pub struct Config")
  assert(result.entries.some((e) => e.text.includes("trait Handler")), "pub trait Handler")
  assert(result.entries.some((e) => e.text.includes("impl Config")), "impl Config")
  assert(result.entries.some((e) => e.text.includes("fn create_config")), "pub fn create_config")
  assert(result.entries.some((e) => e.text.includes("fn async_helper")), "pub async fn async_helper")
})

test("getFunction finds Rust pub fn by name", () => {
  const store = new AnchorStore()
  const result = getFunction({ path: "lib.rs", content: rustContent, store, sessionId: "rs", name: "create_config" })

  assert.equal(result.found, true)
  assert.match(result.text, /fn create_config/)
  assert.match(result.text, /Config::new\(port\)/)
})

const goContent = `package main

import "fmt"

type Config struct {
    Port int
}

func NewConfig(port int) Config {
    return Config{Port: port}
}

func (c Config) String() string {
    return fmt.Sprintf(":%d", c.Port)
}
`

test("fileSkeleton finds Go struct and functions", () => {
  const store = new AnchorStore()
  const result = fileSkeleton({ path: "main.go", content: goContent, store, sessionId: "go" })

  assert(result.entries.some((e) => e.text.includes("struct")), "type Config struct")
  assert(result.entries.some((e) => e.text.includes("func NewConfig")), "func NewConfig")
  assert(result.entries.some((e) => e.text.includes("func")), "at least one func")
})

test("getFunction finds Go func by name", () => {
  const store = new AnchorStore()
  const result = getFunction({ path: "main.go", content: goContent, store, sessionId: "go", name: "NewConfig" })

  assert.equal(result.found, true)
  assert.match(result.text, /func NewConfig/)
  assert.match(result.text, /Config{Port: port}/)
})
