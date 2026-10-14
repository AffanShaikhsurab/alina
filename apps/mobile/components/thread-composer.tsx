import type { MenuAction } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import type {
  buildComposerMentionOptions,
  ChatCommandId,
  ComposerMention,
  SlashActionId,
} from "@rakazo/core";
import {
  filterChatCommands,
  filterModelChoices,
  mentionChipKey,
  parseSlashDraft,
  SLASH_ACTIONS,
  serializeComposerPrompt,
  slashSubmitIntent,
  truncateSlashDescription,
} from "@rakazo/core";
import type { ComponentProps, ReactNode, Ref } from "react";
import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ViewStyle } from "react-native";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { rpc } from "../lib/api";
import { compactThread, modelSwitchInput } from "../lib/bot-model";
import { errorHaptic, selectionHaptic, successHaptic, tapHaptic } from "../lib/haptics";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import type { ComposerSnapshot } from "../lib/thread-feedback";
import { useBotModel } from "../lib/use-bot-model";
import { errorText } from "../lib/user-error";
import { BotAvatar } from "./bot-avatar";
import { GlassSurface } from "./glass-surface";
import {
  LayoutAnimationConfig,
  MotionView,
  PressScale,
  popoverEntering,
  popoverExiting,
  popoverLayout,
  quietEntering,
  quietExiting,
} from "./motion";
import { NativeSymbol } from "./native-symbol";

export type ThreadComposerHandle = {
  snapshot: () => ComposerSnapshot;
  reset: () => void;
};

type ThreadComposerProps = {
  ref: Ref<ThreadComposerHandle>;
  agentSkills: AgentSkillCatalogEntry[];
  /** False until the skill catalog has loaded; an unknown "/word" may be a skill until then. */
  agentSkillsLoaded?: boolean;
  composerMentionTargets: ReturnType<typeof buildComposerMentionOptions>;
  composerPrompt: string;
  replyTargetId?: string;
  replyQuote: string | null;
  attachmentIds: string[];
  botId?: string;
  onCall: boolean;
  working: boolean;
  sending: boolean;
  styles: { circleButton: ViewStyle; composerFill: ViewStyle };
  attachActions: MenuAction[];
  attachFrom: (source: string) => void;
  send: () => Promise<void>;
  stop: () => Promise<void>;
  startVoiceCall: () => Promise<void>;
  onSlashAction: (action: SlashActionId) => void;
  /** Opens the Model and context sheet for this chat's bot. */
  openModelSheet: () => void;
};

type SymbolName = { ios: string; android: ComponentProps<typeof NativeSymbol>["android"] };

const COMMAND_SYMBOLS: Record<ChatCommandId, SymbolName> = {
  model: { ios: "cpu", android: "hardware-chip-outline" },
  compact: { ios: "arrow.down.right.and.arrow.up.left", android: "contract-outline" },
  context: { ios: "chart.pie", android: "pie-chart-outline" },
};

const NOTICE_MS = 4_000;

type ComposerNotice = { text: string; error?: boolean; busy?: boolean };

export function ThreadComposer({
  ref,
  agentSkills,
  agentSkillsLoaded = true,
  composerMentionTargets,
  composerPrompt,
  replyTargetId,
  replyQuote,
  attachmentIds,
  botId,
  onCall,
  working,
  sending,
  styles,
  attachActions,
  attachFrom,
  send,
  stop,
  startVoiceCall,
  onSlashAction,
  openModelSheet,
}: ThreadComposerProps) {
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [selectedMentions, setSelectedMentions] = useState<ComposerMention[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<AgentSkillCatalogEntry | null>(null);
  const [notice, setNotice] = useState<ComposerNotice | null>(null);
  /** Bumped each time the model list opens, so it always shows the bot's current model. */
  const [modelLoad, setModelLoad] = useState(0);
  const botModel = useBotModel(botId, modelLoad);
  const alive = useRef(true);
  const compacting = useRef(false);
  /** A "/model <query>" sent before the model list loaded; it is picked once the list lands. */
  const pendingModelQuery = useRef<string | null>(null);
  useImperativeHandle(ref, () => ({
    snapshot: () => ({
      promptText: serializeComposerPrompt(draft, selectedSkill, selectedMentions),
      mentions: selectedMentions,
      skill: selectedSkill,
      replyTargetId,
      replyQuote,
      attachmentIds,
    }),
    reset: () => {
      setDraft("");
      setMentionQuery(null);
      setSlashQuery(null);
      setSelectedSkill(null);
      setSelectedMentions([]);
    },
  }));

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!notice || notice.busy) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || composerMentionTargets.length === 0) return [];
    const query = mentionQuery.trim().toLowerCase();
    return composerMentionTargets
      .filter((target) => !query || target.name.toLowerCase().startsWith(query))
      .slice(0, 10);
  }, [composerMentionTargets, mentionQuery]);
  const slashOpen = slashQuery !== null && mentionQuery === null;
  // Commands act on one bot's own chat; a group thread has no single model or context.
  const slash = slashOpen && botId ? parseSlashDraft(draft) : null;
  const modelMode = slash !== null && slash.name.toLowerCase() === "model" && slash.args !== null;

  useEffect(() => {
    if (modelMode) setModelLoad((count) => count + 1);
  }, [modelMode]);

  const slashQueryNormalized = slashQuery?.trim().toLowerCase() ?? null;
  const commandOptions =
    slash && slash.args === null ? filterChatCommands(slash.name, (id) => commandLabel(id, t)) : [];
  const modelOptions =
    modelMode && botModel.loaded
      ? filterModelChoices(botModel.modelChoices, slash?.args ?? "")
      : [];
  const slashSkillOptions =
    slashOpen && !modelMode
      ? agentSkills
          .filter((skill) => {
            if (!slashQueryNormalized) return true;
            return (
              skill.name.toLowerCase().includes(slashQueryNormalized) ||
              skill.description.toLowerCase().includes(slashQueryNormalized)
            );
          })
          .slice(0, 8)
      : [];
  const slashActionOptions =
    slashOpen && !modelMode
      ? SLASH_ACTIONS.filter((action) => {
          if (!slashQueryNormalized) return true;
          const label = t(action.label);
          return (
            action.label.toLowerCase().includes(slashQueryNormalized) ||
            label.toLowerCase().includes(slashQueryNormalized)
          );
        })
      : [];
  const modelListPending = modelMode && !botModel.loaded;
  const modelNoMatch = modelMode && botModel.loaded && modelOptions.length === 0;
  const slashRows =
    Number(modelNoMatch) +
    commandOptions.length +
    modelOptions.length +
    slashSkillOptions.length +
    slashActionOptions.length;

  function updateDraft(value: string) {
    // Editing the draft cancels a /model pick that was waiting for the list to load.
    pendingModelQuery.current = null;
    setDraft(value);
    const match = /(?:^|\s)@([\w-]*)$/.exec(value);
    setMentionQuery(match ? (match[1] ?? "") : null);
    const slashMatch = selectedSkill === null ? /^\/([^\n]*)$/.exec(value) : null;
    setSlashQuery(slashMatch ? (slashMatch[1] ?? "") : null);
  }

  function clearDraft() {
    pendingModelQuery.current = null;
    setDraft("");
    setSlashQuery(null);
  }

  function insertMention(mention: ComposerMention) {
    setDraft((current) => current.replace(/@([\w-]*)$/, ""));
    setMentionQuery(null);
    setSelectedMentions((current) =>
      current.some((selected) => mentionChipKey(selected) === mentionChipKey(mention))
        ? current
        : [...current, mention],
    );
  }

  function insertSkill(skill: AgentSkillCatalogEntry) {
    setSelectedSkill(skill);
    setDraft("");
    setSlashQuery(null);
  }

  function removeLastChip() {
    if (selectedMentions.length > 0) {
      setSelectedMentions((current) => current.slice(0, -1));
      return;
    }
    if (selectedSkill) setSelectedSkill(null);
  }

  function runSlashAction(action: SlashActionId) {
    clearDraft();
    onSlashAction(action);
  }

  function runCommand(command: ChatCommandId, args = "") {
    selectionHaptic();
    if (command === "model") {
      const matches = botModel.loaded ? filterModelChoices(botModel.modelChoices, args) : [];
      const only = matches.length === 1 ? matches[0] : undefined;
      if (args && only) {
        void pickModel(only.key, only.label);
        return;
      }
      updateDraft(`/model ${args}`);
      if (args && !botModel.loaded) pendingModelQuery.current = args;
      return;
    }
    clearDraft();
    if (command === "context") openModelSheet();
    else void compact();
  }

  async function pickModel(key: string, label: string) {
    if (!botId) return;
    clearDraft();
    const confirm = () => setNotice({ text: t("Now using {model}", { model: label }) });
    if (key === botModel.selectedKey) {
      confirm();
      return;
    }
    const result = await botModel.save(
      modelSwitchInput(botId, key, botModel.bot?.thinkingLevel ?? null, botModel.levelsFor(key)),
    );
    if (!alive.current || !result.latest) return;
    if (result.ok) {
      successHaptic();
      confirm();
    } else {
      errorHaptic();
      setNotice({ text: result.error, error: true });
    }
  }

  async function compact() {
    if (!botId || compacting.current) return;
    compacting.current = true;
    setNotice({ text: t("Compacting…"), busy: true });
    try {
      const result = await compactThread(rpc, botId, { alive: () => alive.current });
      if (!alive.current || result === "abandoned") return;
      if (result === "nothing") setNotice({ text: t("Nothing new to compact") });
      else if (result === "done") {
        successHaptic();
        setNotice({ text: t("Context compacted") });
      } else {
        errorHaptic();
        setNotice({ text: t("Could not compact. Try again."), error: true });
      }
    } catch (err) {
      if (!alive.current) return;
      errorHaptic();
      setNotice({ text: errorText(err, t("Could not compact. Try again.")), error: true });
    } finally {
      compacting.current = false;
    }
  }

  // Send a "/model <query>" that arrived before the list loaded once it lands, if one model fits.
  useEffect(() => {
    const query = pendingModelQuery.current;
    if (query === null || !botModel.loaded) return;
    pendingModelQuery.current = null;
    const matches = filterModelChoices(botModel.modelChoices, query);
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only) void pickModel(only.key, only.label);
  }, [botModel.loaded, botModel.modelChoices]);

  // A slash command acts or waits in the composer; it is never sent to the bot as text. A skill
  // chip makes the draft that skill's argument, so it is the only case that skips the check.
  const intent =
    selectedSkill === null
      ? slashSubmitIntent(draft, agentSkillsLoaded ? agentSkills.map((skill) => skill.name) : null)
      : ({ kind: "send" } as const);
  // A typed "/model <query>" only picks when exactly one model fits; otherwise tap a row.
  const modelQueryUnresolved =
    intent.kind === "run" &&
    intent.command === "model" &&
    intent.args !== "" &&
    botModel.loaded &&
    filterModelChoices(botModel.modelChoices, intent.args).length !== 1;
  const held = intent.kind === "hold" || (intent.kind === "run" && !botId) || modelQueryUnresolved;

  function submit() {
    if (held) return;
    if (intent.kind === "run") {
      runCommand(intent.command, intent.args);
      return;
    }
    tapHaptic();
    void send();
  }

  const composerPillStyle = {
    width: 36,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  } as const;

  const canSend =
    Boolean(draft.trim()) ||
    selectedSkill !== null ||
    selectedMentions.length > 0 ||
    attachmentIds.length > 0;

  const popoverStyle = {
    flexShrink: 1,
    marginTop: 12,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.popover,
    overflow: "hidden",
  } as const;

  let rowIndex = 0;
  const nextRowIsFirst = () => rowIndex++ === 0;

  return (
    <LayoutAnimationConfig skipEntering>
      {mentionOptions.length ? (
        <MotionView
          key="mentions"
          entering={popoverEntering}
          exiting={popoverExiting}
          layout={popoverLayout}
          style={popoverStyle}
        >
          <ScrollView
            testID="mention-picker"
            keyboardShouldPersistTaps="handled"
            style={{ flexGrow: 0 }}
          >
            {mentionOptions.map((mention, index) => (
              <PopoverRow
                key={mentionChipKey(mention)}
                first={index === 0}
                label={t("@{name}", { name: mention.name })}
                onPress={() => {
                  selectionHaptic();
                  insertMention(mention);
                }}
              >
                <MentionOptionIcon mention={mention} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: tokens.foreground, fontSize: 15 }}>{mention.name}</Text>
                  {mention.subtitle ? (
                    <Text
                      numberOfLines={1}
                      style={{ color: tokens.mutedForeground, fontSize: 12.5, marginTop: 2 }}
                    >
                      {mention.subtitle}
                    </Text>
                  ) : null}
                </View>
              </PopoverRow>
            ))}
          </ScrollView>
        </MotionView>
      ) : null}
      {slashRows || modelListPending ? (
        <MotionView
          key="slash"
          entering={popoverEntering}
          exiting={popoverExiting}
          layout={popoverLayout}
          style={popoverStyle}
        >
          <ScrollView
            testID="slash-picker"
            keyboardShouldPersistTaps="handled"
            style={{ flexGrow: 0 }}
          >
            {modelListPending ? (
              <View style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
                {botModel.loadError ? (
                  <Text style={{ color: tokens.destructive, fontSize: 14 }}>
                    {botModel.loadError}
                  </Text>
                ) : (
                  <ActivityIndicator color={tokens.mutedForeground} />
                )}
              </View>
            ) : null}
            {modelNoMatch ? (
              <View style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
                <Text style={{ color: tokens.mutedForeground, fontSize: 15 }}>
                  {t("No matching models")}
                </Text>
              </View>
            ) : null}
            {modelOptions.map((choice) => {
              const current = choice.key === botModel.selectedKey;
              return (
                <PopoverRow
                  key={`model:${choice.key}`}
                  first={nextRowIsFirst()}
                  label={choice.label}
                  selected={current}
                  onPress={() => void pickModel(choice.key, choice.label)}
                >
                  <Text
                    numberOfLines={1}
                    style={{ flex: 1, color: tokens.foreground, fontSize: 15 }}
                  >
                    {choice.label}
                  </Text>
                  {current ? (
                    <NativeSymbol
                      ios="checkmark"
                      android="checkmark"
                      size={15}
                      color={tokens.foreground}
                    />
                  ) : null}
                </PopoverRow>
              );
            })}
            {commandOptions.map((command) => (
              <PopoverRow
                key={`command:${command}`}
                first={nextRowIsFirst()}
                label={commandLabel(command, t)}
                onPress={() => runCommand(command)}
              >
                <NativeSymbol
                  ios={COMMAND_SYMBOLS[command].ios}
                  android={COMMAND_SYMBOLS[command].android}
                  size={16}
                  color={tokens.mutedForeground}
                />
                <Text style={{ color: tokens.foreground, fontSize: 15 }}>
                  {commandLabel(command, t)}
                </Text>
              </PopoverRow>
            ))}
            {slashSkillOptions.map((skill) => (
              <PopoverRow
                key={skill.id}
                first={nextRowIsFirst()}
                label={t("Skill {name}", { name: skill.name })}
                onPress={() => {
                  selectionHaptic();
                  insertSkill(skill);
                }}
              >
                <NativeSymbol
                  ios="cube"
                  android="cube-outline"
                  size={16}
                  color={tokens.mutedForeground}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: tokens.foreground, fontSize: 15 }}>{skill.name}</Text>
                  <Text
                    numberOfLines={1}
                    style={{ color: tokens.mutedForeground, fontSize: 12.5, marginTop: 2 }}
                  >
                    {truncateSlashDescription(skill.description)}
                  </Text>
                </View>
              </PopoverRow>
            ))}
            {slashActionOptions.map((action) => (
              <PopoverRow
                key={action.id}
                first={nextRowIsFirst()}
                label={t(action.label)}
                onPress={() => runSlashAction(action.id)}
              >
                <NativeSymbol
                  ios="gearshape"
                  android="settings-outline"
                  size={16}
                  color={tokens.mutedForeground}
                />
                <Text style={{ color: tokens.foreground, fontSize: 15 }}>{t(action.label)}</Text>
              </PopoverRow>
            ))}
          </ScrollView>
        </MotionView>
      ) : null}
      {notice ? (
        <MotionView
          key="notice"
          entering={quietEntering}
          exiting={quietExiting}
          style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 }}
        >
          {notice.busy ? <ActivityIndicator size="small" color={tokens.mutedForeground} /> : null}
          <Text
            accessibilityLiveRegion="polite"
            style={{
              flexShrink: 1,
              color: notice.error ? tokens.destructive : tokens.mutedForeground,
              fontSize: 13,
            }}
          >
            {notice.text}
          </Text>
        </MotionView>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 10, marginTop: 8 }}>
        <MenuView
          actions={attachActions}
          colorScheme={colorScheme}
          onPressAction={(event) => attachFrom(event.nativeEvent.event)}
        >
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel={t("Attach file")}
            style={{ width: 44, height: 44 }}
          >
            <GlassSurface
              shape="circle"
              style={styles.circleButton}
              fallbackStyle={styles.composerFill}
            >
              <NativeSymbol ios="plus" android="add" size={18} color={tokens.mutedForeground} />
            </GlassSurface>
          </View>
        </MenuView>
        <GlassSurface
          shape="roundedRectangle"
          style={{
            flex: 1,
            minHeight: 44,
            borderRadius: 22,
            flexDirection: "row",
            alignItems: "flex-end",
            paddingStart: 16,
            paddingEnd: 4,
          }}
          fallbackStyle={styles.composerFill}
        >
          <View
            style={{
              flex: 1,
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 6,
            }}
          >
            {selectedSkill ? (
              <View
                testID="skill-chip"
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  backgroundColor: tokens.muted,
                  borderRadius: 999,
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                  maxWidth: "100%",
                }}
              >
                <NativeSymbol
                  ios="cube"
                  android="cube-outline"
                  size={13}
                  color={tokens.mutedForeground}
                />
                <Text
                  numberOfLines={1}
                  style={{ color: tokens.foreground, fontSize: 13, flexShrink: 1 }}
                >
                  {selectedSkill.name}
                </Text>
                <Pressable
                  accessibilityLabel={t("Remove skill {name}", { name: selectedSkill.name })}
                  hitSlop={8}
                  onPress={() => setSelectedSkill(null)}
                >
                  <NativeSymbol
                    ios="xmark"
                    android="close"
                    size={12}
                    color={tokens.mutedForeground}
                  />
                </Pressable>
              </View>
            ) : null}
            {selectedMentions.map((mention) => (
              <View
                key={mentionChipKey(mention)}
                testID="mention-chip"
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  backgroundColor: tokens.muted,
                  borderRadius: 999,
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                  maxWidth: "100%",
                }}
              >
                <MentionChipIcon mention={mention} />
                <Text
                  numberOfLines={1}
                  style={{ color: tokens.foreground, fontSize: 13, flexShrink: 1 }}
                >
                  {mention.name}
                </Text>
                <Pressable
                  accessibilityLabel={t("Remove mention {name}", { name: mention.name })}
                  hitSlop={8}
                  onPress={() =>
                    setSelectedMentions((current) =>
                      current.filter(
                        (selected) => mentionChipKey(selected) !== mentionChipKey(mention),
                      ),
                    )
                  }
                >
                  <NativeSymbol
                    ios="xmark"
                    android="close"
                    size={12}
                    color={tokens.mutedForeground}
                  />
                </Pressable>
              </View>
            ))}
            <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 96 }}>
              {!draft && !selectedSkill && !selectedMentions.length ? (
                <Text
                  numberOfLines={1}
                  importantForAccessibility="no"
                  accessibilityElementsHidden
                  accessible={false}
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    top: 11,
                    start: 0,
                    end: 0,
                    fontSize: 17,
                    lineHeight: 22,
                    color: tokens.mutedForeground,
                  }}
                >
                  {composerPrompt}
                </Text>
              ) : null}
              <TextInput
                value={draft}
                onChangeText={updateDraft}
                accessibilityLabel={composerPrompt}
                onKeyPress={(event) => {
                  if (
                    event.nativeEvent.key === "Backspace" &&
                    draft.length === 0 &&
                    (selectedSkill !== null || selectedMentions.length > 0)
                  ) {
                    removeLastChip();
                  }
                }}
                keyboardAppearance={colorScheme}
                multiline
                textAlignVertical="top"
                blurOnSubmit={false}
                style={{
                  color: tokens.foreground,
                  fontSize: 17,
                  lineHeight: 22,
                  paddingTop: 11,
                  paddingBottom: 11,
                  maxHeight: 132,
                  writingDirection: "auto",
                }}
              />
            </View>
          </View>
          {!canSend && botId && !onCall ? (
            <MotionView key="call" entering={quietEntering} style={{ marginBottom: 8 }}>
              <PressScale
                accessibilityLabel={t("Call")}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                haptic={tapHaptic}
                onPress={() => void startVoiceCall()}
              >
                <GlassSurface
                  tint={tokens.primary}
                  style={composerPillStyle}
                  fallbackStyle={{ backgroundColor: tokens.primary }}
                >
                  <NativeSymbol
                    ios="waveform"
                    android="pulse-outline"
                    size={15}
                    color={tokens.primaryForeground}
                  />
                </GlassSurface>
              </PressScale>
            </MotionView>
          ) : (
            <MotionView
              key="send"
              entering={quietEntering}
              style={{ marginBottom: 8, opacity: sending || !canSend || held ? 0.5 : 1 }}
            >
              <PressScale
                accessibilityLabel={t("Send")}
                disabled={sending || !canSend || held}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                onPress={submit}
              >
                <GlassSurface
                  tint={tokens.primary}
                  style={composerPillStyle}
                  fallbackStyle={{ backgroundColor: tokens.primary }}
                >
                  <NativeSymbol
                    ios="arrow.up"
                    android="arrow-up"
                    size={15}
                    color={tokens.primaryForeground}
                  />
                </GlassSurface>
              </PressScale>
            </MotionView>
          )}
        </GlassSurface>
        {working ? (
          <MotionView key="stop" entering={quietEntering} exiting={quietExiting}>
            <PressScale
              accessibilityLabel={t("Stop")}
              disabled={sending}
              haptic={tapHaptic}
              onPress={() => void stop()}
              containerStyle={{ width: 44, height: 44, opacity: sending ? 0.5 : 1 }}
            >
              <GlassSurface
                shape="circle"
                style={styles.circleButton}
                fallbackStyle={{ borderColor: tokens.border, borderWidth: 1 }}
              >
                <NativeSymbol ios="stop.fill" android="stop" size={15} color={tokens.foreground} />
              </GlassSurface>
            </PressScale>
          </MotionView>
        ) : null}
      </View>
    </LayoutAnimationConfig>
  );
}

function commandLabel(id: ChatCommandId, t: (message: string) => string): string {
  if (id === "model") return t("Model");
  if (id === "compact") return t("Compact");
  return t("Context");
}

/** One row of a composer popover: hairline above all but the first, a fill while pressed. */
function PopoverRow({
  label,
  first,
  selected,
  onPress,
  children,
}: {
  label: string;
  first: boolean;
  selected?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  const tokens = useMobileTokens();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: 48,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: tokens.border,
        backgroundColor: pressed ? tokens.muted : undefined,
      })}
    >
      {children}
    </Pressable>
  );
}

function MentionOptionIcon({ mention }: { mention: ComposerMention }) {
  const tokens = useMobileTokens();
  if (mention.kind === "routine") {
    return (
      <NativeSymbol ios="clock" android="time-outline" size={18} color={tokens.mutedForeground} />
    );
  }
  if (mention.kind === "connector") {
    return (
      <NativeSymbol
        ios="puzzlepiece.extension"
        android="extension-puzzle-outline"
        size={18}
        color={tokens.mutedForeground}
      />
    );
  }
  if (mention.kind === "group" || mention.kind === "everyone") {
    return (
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 14,
          backgroundColor: tokens.muted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 12 }}>
          {mention.kind === "group" ? "G" : "@"}
        </Text>
      </View>
    );
  }
  return (
    <BotAvatar color={mention.color ?? tokens.mutedForeground} identity={mention.id} size={28} />
  );
}

function MentionChipIcon({ mention }: { mention: ComposerMention }) {
  const tokens = useMobileTokens();
  if (mention.kind === "routine") {
    return (
      <NativeSymbol ios="clock" android="time-outline" size={13} color={tokens.mutedForeground} />
    );
  }
  if (mention.kind === "connector") {
    return (
      <NativeSymbol
        ios="puzzlepiece.extension"
        android="extension-puzzle-outline"
        size={13}
        color={tokens.mutedForeground}
      />
    );
  }
  if (mention.kind === "group" || mention.kind === "everyone") {
    return (
      <View
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          backgroundColor: tokens.muted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 9 }}>
          {mention.kind === "group" ? "G" : "@"}
        </Text>
      </View>
    );
  }
  return (
    <View
      style={{
        width: 14,
        height: 14,
        borderRadius: 4,
        backgroundColor: mention.color ?? tokens.mutedForeground,
      }}
    />
  );
}
