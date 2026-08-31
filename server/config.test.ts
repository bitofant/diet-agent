import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLocalEndpoint, loadConfig, withDefaults } from "./config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "diet-config-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeConfig(contents: unknown): string {
  const path = join(dir, "config.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

describe("withDefaults", () => {
  it("fills every key from an empty object", () => {
    expect(withDefaults({})).toEqual({
      llm: { provider: "vLLM", baseUrl: "http://localhost:8000/v1", model: "default" },
      server: { port: 4100 },
      defaults: { targetKcal: 2000, energyUnit: "kcal", measurementSystem: "metric" },
    });
  });

  it("defaults the endpoint to a local one — food logs are health data", () => {
    expect(isLocalEndpoint(withDefaults({}).llm.baseUrl)).toBe(true);
  });

  it("keeps what is given and fills only the gaps", () => {
    const config = withDefaults({ llm: { model: "qwen3" }, defaults: { targetKcal: 1800 } });
    expect(config.llm).toEqual({ provider: "vLLM", baseUrl: "http://localhost:8000/v1", model: "qwen3" });
    expect(config.defaults).toEqual({ targetKcal: 1800, energyUnit: "kcal", measurementSystem: "metric" });
    expect(config.server.port).toBe(4100);
  });

  it("carries an api key through only when there is one", () => {
    expect(withDefaults({ llm: { apiKey: "sk-test" } }).llm.apiKey).toBe("sk-test");
    expect(withDefaults({}).llm).not.toHaveProperty("apiKey");
    expect(withDefaults({ llm: { apiKey: "" } }).llm).not.toHaveProperty("apiKey");
  });

  it("falls back rather than trusting a nonsense value", () => {
    expect(withDefaults({ server: { port: "4100" } as never }).server.port).toBe(4100);
    expect(withDefaults({ server: { port: 0 } }).server.port).toBe(4100);
    expect(withDefaults({ server: { port: 70_000 } }).server.port).toBe(4100);
    expect(withDefaults({ defaults: { targetKcal: -5 } as never }).defaults.targetKcal).toBe(2000);
    expect(withDefaults({ defaults: { energyUnit: "calories" } as never }).defaults.energyUnit).toBe("kcal");
    expect(withDefaults({ defaults: { measurementSystem: "furlongs" } as never }).defaults.measurementSystem).toBe("metric");
    expect(withDefaults({ llm: { baseUrl: 42 } as never }).llm.baseUrl).toBe("http://localhost:8000/v1");
    expect(withDefaults(null as never)).toEqual(withDefaults({}));
  });

  it("accepts the shipped example config unchanged", () => {
    // The example is the documented shape; drift here means config-gen.sh lies.
    const example = JSON.parse(readFileSync("config.example.json", "utf8"));
    expect(withDefaults(example)).toEqual(example);
  });
});

describe("loadConfig", () => {
  it("reads a config file through withDefaults", () => {
    const path = writeConfig({ server: { port: 5000 } });
    expect(loadConfig(path)).toEqual(withDefaults({ server: { port: 5000 } }));
  });

  it("points at config-gen.sh when the file is missing", () => {
    expect(() => loadConfig(join(dir, "nope.json"))).toThrow(/config-gen\.sh/);
  });

  it("names the file when it cannot be parsed", () => {
    const path = writeConfig("{ not json");
    expect(() => loadConfig(path)).toThrow(/config\.json/);
  });
});

describe("isLocalEndpoint", () => {
  it("recognises the loopback endpoints the default deployment uses", () => {
    for (const url of ["http://localhost:8000/v1", "http://127.0.0.1:8080/v1", "http://[::1]:8000/v1"]) {
      expect(isLocalEndpoint(url)).toBe(true);
    }
  });

  it("treats anything else as third-party disclosure", () => {
    for (const url of ["https://api.openai.com/v1", "http://gpu.example.com:8000/v1", "not a url", ""]) {
      expect(isLocalEndpoint(url)).toBe(false);
    }
  });
});
