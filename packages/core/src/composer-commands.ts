/** Chat commands typed after "/" at the start of the composer. They act; they are never sent. */
export const CHAT_COMMANDS = [
  { id: "model" as const, label: "Model" },
  { id: "compact" as const, label: "Compact" },
  { id: "context" as const, label: "Context" },
] as const;

export type ChatCommandId = (typeof CHAT_COMMANDS)[number]["id"];

/** The command word right after the leading "/", and what follows its first space. */
export type SlashDraft = { name: string; args: string | null };

/**
 * "/mo" is `{ name: "mo", args: null }`, "/model kimi" is `{ name: "model", args: "kimi" }`.
 * Anything that is not a leading slash word (a path like "/usr/bin", text before the slash) is
 * `null`, so it reads as an ordinary message.
 */
export function parseSlashDraft(draft: string): SlashDraft | null {
  const match = /^\/([^\s/]*)(?:\s+([\s\S]*))?$/.exec(draft);
  if (!match) return null;
  return { name: match[1] ?? "", args: match[2] ?? null };
}

export function findChatCommand(name: string): ChatCommandId | null {
  const wanted = name.toLowerCase();
  return CHAT_COMMANDS.find((command) => command.id === wanted)?.id ?? null;
}

/** Commands whose name or shown label matches what was typed after the slash, in list order. */
export function filterChatCommands(
  query: string,
  labelOf: (id: ChatCommandId) => string = (id) =>
    CHAT_COMMANDS.find((command) => command.id === id)?.label ?? id,
): ChatCommandId[] {
  const wanted = query.trim().toLowerCase();
  return CHAT_COMMANDS.filter(
    (command) =>
      !wanted ||
      command.id.startsWith(wanted) ||
      labelOf(command.id).toLowerCase().includes(wanted),
  ).map((command) => command.id);
}

/** Choices where every typed word appears in the label or the key ("kimi k2" finds "Kimi K2.5"). */
export function filterModelChoices<T extends { key: string; label: string }>(
  choices: readonly T[],
  query: string,
): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...choices];
  return choices.filter((choice) => {
    const haystack = `${choice.label} ${choice.key}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export type SlashSubmitIntent =
  | { kind: "send" }
  /** A bare "/" or an unknown command: it stays in the composer. */
  | { kind: "hold" }
  | { kind: "run"; command: ChatCommandId; args: string };

/**
 * What Send does with a draft. Commands run instead of being sent, a bare or unknown slash
 * command stays put, and everything else (a typed skill name, a slash mid-sentence, a path)
 * is an ordinary message.
 */
export function slashSubmitIntent(
  draft: string,
  /** `null` while the skill catalog is unknown: an unrecognised "/word" may be a skill, so it sends. */
  skillNames: readonly string[] | null = [],
): SlashSubmitIntent {
  const text = draft.trim();
  const parsed = parseSlashDraft(text);
  if (!parsed) return { kind: "send" };
  if (!parsed.name) return parsed.args?.trim() ? { kind: "send" } : { kind: "hold" };
  const command = findChatCommand(parsed.name);
  if (command) return { kind: "run", command, args: parsed.args?.trim() ?? "" };
  if (skillNames === null) return { kind: "send" };
  // Skill names may hold spaces ("/Daily standup notes"), so match the start of the text.
  const rest = text.slice(1).toLowerCase();
  const typedSkill = skillNames.some((skill) => {
    const name = skill.toLowerCase();
    return rest === name || rest.startsWith(`${name} `) || rest.startsWith(`${name}\n`);
  });
  return typedSkill ? { kind: "send" } : { kind: "hold" };
}
