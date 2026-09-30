import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { APP_NAME, APP_VERSION } from "../src/config.js";
import { USER_AGENT } from "../src/utils/doc-fetcher.js";

const readJson = (file: string) =>
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const server = readJson("server.json");

describe("version metadata", () => {
  it("APP_VERSION comes from package.json", () => {
    expect(APP_VERSION).toBe(pkg.version);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("User-Agent carries the full package version", () => {
    expect(USER_AGENT).toBe(`${APP_NAME}/${pkg.version}`);
  });

  it("package-lock.json matches package.json", () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
  });

  it("server.json matches package.json", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    const npmPkg = server.packages.find(
      (p: { registryType: string }) => p.registryType === "npm",
    );
    expect(npmPkg.identifier).toBe(pkg.name);
    expect(npmPkg.version).toBe(pkg.version);
  });
});
