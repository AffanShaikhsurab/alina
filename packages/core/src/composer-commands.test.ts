import { describe, expect, it } from "vitest";

import {
  CHAT_COMMANDS,
  filterChatCommands,
  filterModelChoices,
  findChatCommand,
  parseSlashDraft,
  slashSubmitIntent,
} from "./composer-commands.js";

describe("parseSlashDraft", () => {
  it("splits the command word from its arguments", () => {
    expect(parseSlashDraft("/")).toEqual({ name: "", args: null });
    expect(parseSlashDraft("/mo")).toEqual({ name: "mo", args: null });
    expect(parseSlashDraft("/model ")).toEqual({ name: "model", args: "" });
    expect(parseSlashDraft("/model kimi k2")).toEqual({ name: "model", args: "kimi k2" });
  });

  it("is not a command when the slash is not a leading word", () => {
    expect(parseSlashDraft("hi /model")).toBeNull();
    expect(parseSlashDraft("/usr/bin is missing")).toBeNull();
    expect(parseSlashDraft(" /model")).toBeNull();
  });
});

describe("filterChatCommands", () => {
  it("lists every command for a bare slash, in order", () => {
    expect(filterChatCommands("")).toEqual(CHAT_COMMANDS.map((command) => command.id));
  });

  it("filters by name prefix or shown label", () => {
    expect(filterChatCommands("mo")).toEqual(["model"]);
    expect(filterChatCommands("co")).toEqual(["compact", "context"]);
    expect(filterChatCommands("MODEL")).toEqual(["model"]);
    expect(filterChatCommands("zz")).toEqual([]);
    expect(filterChatCommands("mod", (id) => (id === "context" ? "Kontext Modus" : id))).toEqual([
      "model",
      "context",
    ]);
  });

  it("finds a command by exact name", () => {
    expect(findChatCommand("Model")).toBe("model");
    expect(findChatCommand("mod")).toBeNull();
  });
});

describe("filterModelChoices", () => {
  const choices = [
    { key: "", label: "Space default (GPT-5)" },
    { key: "openrouter:moonshotai/kimi-k2.5", label: "Kimi K2.5" },
    { key: "anthropic:claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  ];

  it("keeps every choice for an empty query", () => {
    expect(filterModelChoices(choices, "  ")).toEqual(choices);
  });

  it("matches every typed word against the label or key", () => {
    expect(filterModelChoices(choices, "kimi").map((choice) => choice.label)).toEqual([
      "Kimi K2.5",
    ]);
    expect(filterModelChoices(choices, "claude 4.5").map((choice) => choice.label)).toEqual([
      "Claude Sonnet 4.5",
    ]);
    expect(filterModelChoices(choices, "moonshot").map((choice) => choice.label)).toEqual([
      "Kimi K2.5",
    ]);
    expect(filterModelChoices(choices, "kimi claude")).toEqual([]);
  });
});

describe("slashSubmitIntent", () => {
  it("never sends a bare slash or an unknown command", () => {
    expect(slashSubmitIntent("/")).toEqual({ kind: "hold" });
    expect(slashSubmitIntent("  /  ")).toEqual({ kind: "hold" });
    expect(slashSubmitIntent("/shrug")).toEqual({ kind: "hold" });
    expect(slashSubmitIntent("/mo")).toEqual({ kind: "hold" });
  });

  it("runs known commands instead of sending them", () => {
    expect(slashSubmitIntent("/model")).toEqual({ kind: "run", command: "model", args: "" });
    expect(slashSubmitIntent("/Model kimi ")).toEqual({
      kind: "run",
      command: "model",
      args: "kimi",
    });
    expect(slashSubmitIntent("/compact")).toEqual({ kind: "run", command: "compact", args: "" });
    expect(slashSubmitIntent("/context")).toEqual({ kind: "run", command: "context", args: "" });
  });

  it("sends ordinary text, including a slash mid-sentence or a path", () => {
    expect(slashSubmitIntent("hello")).toEqual({ kind: "send" });
    expect(slashSubmitIntent("use a / here")).toEqual({ kind: "send" });
    expect(slashSubmitIntent("/usr/bin is missing")).toEqual({ kind: "send" });
    expect(slashSubmitIntent("/ and then")).toEqual({ kind: "send" });
  });

  it("sends a typed skill name, which the agent reads as the skill", () => {
    expect(slashSubmitIntent("/writing", ["Writing"])).toEqual({ kind: "send" });
    expect(slashSubmitIntent("/Daily standup check blockers", ["Daily standup"])).toEqual({
      kind: "send",
    });
    expect(slashSubmitIntent("/Daily", ["Daily standup"])).toEqual({ kind: "hold" });
  });

  it("sends an unrecognised word while the skill catalog is unknown, but still holds the rest", () => {
    expect(slashSubmitIntent("/my-skill do it", null)).toEqual({ kind: "send" });
    expect(slashSubmitIntent("/", null)).toEqual({ kind: "hold" });
    expect(slashSubmitIntent("/compact", null)).toEqual({
      kind: "run",
      command: "compact",
      args: "",
    });
  });
});
