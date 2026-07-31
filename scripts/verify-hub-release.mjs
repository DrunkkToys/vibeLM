#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function fail(message) {
  console.error(`LM Studio Hub publish blocked: ${message}`);
  process.exit(1);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

let version;
try {
  version = JSON.parse(readFileSync("package.json", "utf8")).version;
} catch {
  fail("package.json with a valid version is required.");
}

if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail("package.json must contain a valid SemVer version.");
}

const tag = `v${version}`;
let head;
let taggedCommit;
try {
  head = git(["rev-parse", "HEAD"]);
  taggedCommit = git(["rev-list", "-n", "1", tag]);
} catch {
  fail(`required release tag ${tag} does not exist.`);
}

if (taggedCommit !== head) fail(`required release tag ${tag} must point at the current commit.`);

try {
  if (git(["status", "--porcelain"])) fail("working tree is not clean.");
} catch {
  fail("this command must run inside a git repository.");
}

console.log(`Release gate passed: ${tag} points at ${head.slice(0, 12)}.`);
