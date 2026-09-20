// Native fault fixtures bypass the product launcher. Supply only the real
// launcher prerequisites before importing the actual production supervisor.
// The surrounding test Job owns all resources, including intentionally unknown
// workload records; it is not evidence that the product itself proved release.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [root, supervisor, encoded] = process.argv.slice(2);
const config = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
const inside = relative(resolve(root), resolve(config.directory));
if (!inside || inside.startsWith("..") || isAbsolute(inside) || lstatSync(root).isSymbolicLink() || lstatSync(config.directory).isSymbolicLink())
  throw new Error("Fixture supervisor authority is outside its exact new root.");
if (typeof config.nonce !== "string" || config.nonce.length === 0) throw new Error("Fixture supervisor nonce is missing.");
const powershell = join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const birth = execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
  `$ErrorActionPreference='Stop';(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToString('o')`,
], { encoding: "utf8", windowsHide: true, timeout: 2_000 }).trim().replace(/(\.\d{6})\d+(Z)$/, "$1$2");
if (!birth || !Number.isFinite(Date.parse(birth))) throw new Error("Fixture supervisor birth is unavailable.");
const holder = join(config.directory, "lock-holder.json");
if (existsSync(holder)) throw new Error("Fixture supervisor lock holder already exists.");
writeFileSync(holder, JSON.stringify({ nonce: config.nonce, holderPid: process.pid, holderBirth: birth }), { flag: "wx" });
const fence = join(config.directory, "fence.json");
if (!existsSync(fence)) writeFileSync(fence, JSON.stringify({ nonce: config.nonce, ownerId: "fixture-bootstrap", fencingToken: 1 }), { flag: "wx" });
process.argv = [process.execPath, supervisor, encoded];
await import(pathToFileURL(supervisor).href);
