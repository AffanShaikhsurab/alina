import { beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, string>());
const FILE = "doc/rakazo-thread-details.json";

vi.mock("expo-file-system", () => ({
  Paths: { document: "doc" },
  File: class {
    private readonly key: string;
    constructor(dir: string, name: string) {
      this.key = `${dir}/${name}`;
    }
    get exists() {
      return files.has(this.key);
    }
    create() {
      files.set(this.key, "");
    }
    async text() {
      return files.get(this.key) ?? "";
    }
    write(content: string) {
      files.set(this.key, content);
    }
  },
}));

beforeEach(() => {
  files.clear();
  vi.resetModules();
});

describe("thread details preference", () => {
  it("shows subagents and hides tool steps until a chat changes them", async () => {
    const { DEFAULT_THREAD_DETAILS, threadDetailsFor } = await import("./thread-details");
    expect(threadDetailsFor("bot-1")).toEqual({ showSubagents: true, showToolSteps: false });
    expect(threadDetailsFor(undefined)).toBe(DEFAULT_THREAD_DETAILS);
  });

  it("keeps each chat's choice, notifies at once, and saves to the device", async () => {
    const { setThreadDetail, subscribeThreadDetails, threadDetailsFor } = await import(
      "./thread-details"
    );
    const listener = vi.fn();
    subscribeThreadDetails(listener);

    const saved = setThreadDetail("bot-1", { showSubagents: false });
    expect(listener).toHaveBeenCalled();
    expect(threadDetailsFor("bot-1")).toEqual({ showSubagents: false, showToolSteps: false });
    expect(threadDetailsFor("bot-2").showSubagents).toBe(true);
    // Stable between changes so useSyncExternalStore does not loop.
    expect(threadDetailsFor("bot-1")).toBe(threadDetailsFor("bot-1"));
    await saved;
    expect(JSON.parse(files.get(FILE) ?? "{}")).toEqual({ "bot-1": { showSubagents: false } });
  });

  it("loads saved choices and merges a choice made before loading finished", async () => {
    files.set(
      FILE,
      JSON.stringify({
        "bot-1": { showSubagents: false, showToolSteps: "yes" },
        "bot-2": { showToolSteps: true },
      }),
    );
    const { loadThreadDetails, setThreadDetail, threadDetailsFor } = await import(
      "./thread-details"
    );
    await setThreadDetail("bot-1", { showToolSteps: true });
    await loadThreadDetails();

    expect(threadDetailsFor("bot-1")).toEqual({ showSubagents: false, showToolSteps: true });
    expect(threadDetailsFor("bot-2")).toEqual({ showSubagents: true, showToolSteps: true });
    expect(JSON.parse(files.get(FILE) ?? "{}")).toEqual({
      "bot-1": { showSubagents: false, showToolSteps: true },
      "bot-2": { showToolSteps: true },
    });
  });

  it("falls back to defaults when the file is unreadable", async () => {
    files.set(FILE, "not json");
    const { loadThreadDetails, threadDetailsFor } = await import("./thread-details");
    await loadThreadDetails();
    expect(threadDetailsFor("bot-1")).toEqual({ showSubagents: true, showToolSteps: false });
  });
});
