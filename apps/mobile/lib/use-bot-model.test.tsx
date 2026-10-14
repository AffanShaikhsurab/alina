// @vitest-environment jsdom

import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileBot } from "./api";
import { useBotModel } from "./use-bot-model";

type Deferred = { resolve: (value?: unknown) => void; reject: (error: Error) => void };

const api = vi.hoisted(() => ({
  calls: [] as { path: string; body?: unknown }[],
  /** Pending `bots/update` requests, in the order they reached the server. */
  updates: [] as Deferred[],
  bot: { id: "bot-1", modelProvider: null, modelId: null, thinkingLevel: null } as unknown,
}));

vi.mock("./api", () => ({
  rpc: (path: string, body?: unknown) => {
    api.calls.push({ path, body });
    if (path === "bots/get") return Promise.resolve(api.bot);
    if (path === "me") return Promise.resolve({ defaultProvider: null, defaultModel: null });
    if (path === "models/list" || path === "models/credentials") return Promise.resolve([]);
    if (path === "bots/update") {
      return new Promise((resolve, reject) => api.updates.push({ resolve, reject }));
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  },
}));
vi.mock("./i18n", () => {
  const t = (text: string) => text;
  return { t, useI18n: () => ({ t }) };
});
vi.mock("./user-error", () => ({
  errorText: (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback),
}));

type Hook = ReturnType<typeof useBotModel>;
let hook: Hook;
let root: Root;
let container: HTMLDivElement;

function Probe({ loadKey }: { loadKey: number }) {
  hook = useBotModel("bot-1", loadKey);
  return null;
}

async function render(loadKey: number) {
  await act(async () => {
    root.render(createElement(Probe, { loadKey }));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const fetchCount = () => api.calls.filter((call) => call.path === "bots/get").length;
const updateBodies = () =>
  api.calls.filter((call) => call.path === "bots/update").map((call) => call.body);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.calls = [];
  api.updates = [];
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
});

describe("useBotModel", () => {
  it("waits on loadKey 0 and loads again each time the key changes", async () => {
    await render(0);
    expect(fetchCount()).toBe(0);
    expect(hook.loaded).toBe(false);

    await render(1);
    await flush();
    expect(fetchCount()).toBe(1);
    expect(hook.loaded).toBe(true);

    await render(2);
    await flush();
    expect(fetchCount()).toBe(2);
  });

  it("sends saves one at a time in pick order and flags only the newest as latest", async () => {
    await render(1);
    await flush();

    let first: Promise<unknown> = Promise.resolve();
    let second: Promise<unknown> = Promise.resolve();
    await act(async () => {
      first = hook.save({
        botId: "bot-1",
        modelProvider: "a",
        modelId: "one",
        thinkingLevel: null,
      });
      second = hook.save({
        botId: "bot-1",
        modelProvider: "b",
        modelId: "two",
        thinkingLevel: null,
      });
      await Promise.resolve();
    });
    // The second pick waits until the first one has landed.
    expect(api.updates).toHaveLength(1);

    await act(async () => {
      api.updates[0]?.resolve();
      await first;
      await Promise.resolve();
    });
    expect(api.updates).toHaveLength(2);
    await act(async () => {
      api.updates[1]?.resolve();
      await second;
    });

    await expect(first).resolves.toEqual({ ok: true, latest: false });
    await expect(second).resolves.toEqual({ ok: true, latest: true });
    expect(updateBodies()).toEqual([
      { botId: "bot-1", modelProvider: "a", modelId: "one", thinkingLevel: null },
      { botId: "bot-1", modelProvider: "b", modelId: "two", thinkingLevel: null },
    ]);
    expect((hook.bot as MobileBot & { modelId: string }).modelId).toBe("two");
  });

  it("rolls a failed save back to what the server last accepted", async () => {
    await render(1);
    await flush();

    let saved: Promise<unknown> = Promise.resolve();
    await act(async () => {
      saved = hook.save({
        botId: "bot-1",
        modelProvider: "a",
        modelId: "one",
        thinkingLevel: null,
      });
      await Promise.resolve();
    });
    // The pick shows straight away, before the server answers.
    expect((hook.bot as MobileBot & { modelId: string | null }).modelId).toBe("one");

    await act(async () => {
      api.updates[0]?.reject(new Error("Model not available"));
      await saved;
    });

    await expect(saved).resolves.toEqual({
      ok: false,
      latest: true,
      error: "Model not available",
    });
    expect((hook.bot as MobileBot & { modelId: string | null }).modelId).toBeNull();
  });
});
