import { useEffect, useMemo, useRef, useState } from "react";
import { retainChatContextOnError } from "@t3tools/client-runtime/state/brain";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  AppState,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Markdown } from "react-native-nitro-markdown";
import {
  ThreadId,
  type BrainDocument,
  type BrainDocumentSummary,
  type BrainResponse,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { brainCommand } from "../../state/brain";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";

type Params = { environmentId?: string; threadId?: string } | undefined;
export function BrainRouteScreen({ route }: StaticScreenProps<Params>) {
  const { environments } = useEnvironments();
  const [computer, setComputer] = useState<string | null>(route.params?.environmentId ?? null);
  const environment = computer
    ? environments.find((item) => item.environmentId === computer)
    : environments[0];
  const environmentId = environment?.environmentId;
  return (
    <BrainScreenContent
      key={`${environmentId ?? "disconnected"}:${route.params?.threadId ?? "brain"}`}
      environmentId={environmentId}
      connected={environment?.connection.phase === "connected"}
      threadId={route.params?.threadId}
      environments={environments}
      setComputer={setComputer}
    />
  );
}

function BrainScreenContent({
  environmentId,
  connected,
  threadId,
  environments,
  setComputer,
}: {
  environmentId: EnvironmentId | undefined;
  connected: boolean;
  threadId: string | undefined;
  environments: ReturnType<typeof useEnvironments>["environments"];
  setComputer: (id: string) => void;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const execute = useAtomCommand(brainCommand, { reportFailure: false });
  const [response, setResponse] = useState<BrainResponse | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<"graph" | "skill" | "memory">("graph");
  const reload = useRef<() => void>(() => {});
  const [selected, setSelected] = useState<BrainDocumentSummary | null>(null);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let revision: string | undefined;
    let pending = false;
    if (!environmentId || !connected) return;
    async function load() {
      if (disposed || pending || AppState.currentState !== "active") return;
      pending = true;
      try {
        const result = await execute({
          environmentId: environmentId!,
          input: threadId
            ? {
                action: "readChat",
                threadId: ThreadId.make(threadId),
                ...(revision ? { revision } : {}),
              }
            : { action: "read" },
        });
        if (disposed) return;
        if (result._tag === "Failure") {
          setError("Could not reach this brain. Reconnect and retry.");
          revision = undefined;
        } else {
          setResponse((previous) =>
            threadId ? retainChatContextOnError(previous, result.value) : result.value,
          );
          setError(result.value.error ?? "");
          revision = result.value.error ? undefined : result.value.chatMemories?.revision;
        }
      } catch {
        if (!disposed) setError("Could not refresh this brain.");
      } finally {
        pending = false;
        if (!disposed) setRefreshing(false);
        if (!disposed) timer = setTimeout(() => void load(), threadId && revision ? 100 : 5000);
      }
    }
    reload.current = () => {
      if (pending) return;
      revision = undefined;
      if (timer) clearTimeout(timer);
      setRefreshing(true);
      void load();
    };
    void load();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void load();
    });
    return () => {
      disposed = true;
      reload.current = () => {};
      if (timer) clearTimeout(timer);
      subscription.remove();
    };
  }, [environmentId, connected, threadId, execute]);
  const workspace = workspaceId
    ? response?.state.workspaces.find((item) => item.id === workspaceId)
    : response?.state.workspaces[0];
  const graphEntities = useMemo(() => {
    const entities = workspace?.knowledge.entities ?? [];
    const names = new Map(entities.map((entity) => [entity.id, entity.name]));
    const outgoing = new Map<string, Array<{ key: string; text: string }>>();
    for (const edge of workspace?.knowledge.edges ?? []) {
      const links = outgoing.get(edge.from) ?? [];
      links.push({
        key: `${edge.label}:${edge.to}`,
        text: `${edge.label} → ${names.get(edge.to) ?? edge.to}`,
      });
      outgoing.set(edge.from, links);
    }
    return entities.map((entity) => ({ ...entity, links: outgoing.get(entity.id) ?? [] }));
  }, [workspace?.knowledge]);
  const notes = response?.chatMemories;
  const documents = threadId ? (notes?.documents ?? []) : (workspace?.knowledge.documents ?? []);
  const legacy = threadId
    ? (notes?.memories ?? []).map((item) => ({ id: item.id, body: item.text }))
    : (workspace?.knowledge.memories ?? []);
  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" && (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={threadId ? "Brain & notes" : "Brain"}
            onBack={() => navigation.goBack()}
          />
        </>
      )}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: insets.bottom + 30 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => reload.current()} />
        }
      >
        {!threadId && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2"
          >
            {environments.map((item) => (
              <Pressable
                key={item.environmentId}
                accessibilityRole="button"
                accessibilityLabel={`Brain computer: ${item.label}`}
                onPress={() => setComputer(item.environmentId)}
                className={`rounded-full px-4 py-2 ${item.environmentId === environmentId ? "bg-foreground" : "bg-surface"}`}
              >
                <Text
                  className={
                    item.environmentId === environmentId ? "text-background" : "text-foreground"
                  }
                >
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        )}
        {!connected ? (
          <Text className="text-foreground-muted">
            {environmentId
              ? "This computer is offline. Reconnect to read its brain."
              : "Connect to a computer to open its brain."}
          </Text>
        ) : !response && !error ? (
          <Text accessibilityRole="text" className="text-foreground-muted">
            Opening brain…
          </Text>
        ) : null}
        {!!error && (
          <Text accessibilityRole="alert" className="text-red-500">
            {error}
          </Text>
        )}
        {workspace && (
          <View className="gap-2">
            <Text className="text-2xl font-t3-bold text-foreground">{workspace.name}</Text>
            <Text className="text-sm text-foreground-muted">
              {threadId
                ? "Context preserved from this conversation"
                : "Skills and memories shared across your projects"}
            </Text>
          </View>
        )}
        {!threadId && response && response.state.workspaces.length > 1 && (
          <ScrollView
            horizontal
            contentContainerClassName="gap-2"
            showsHorizontalScrollIndicator={false}
          >
            {response.state.workspaces.map((item) => (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                onPress={() => {
                  setWorkspaceId(item.id);
                  setSelected(null);
                }}
                className="rounded-xl bg-surface px-4 py-3"
              >
                <Text className="text-foreground">
                  {item.id === workspace?.id ? "✓ " : ""}
                  {item.name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        )}
        {!threadId && (
          <View accessibilityRole="tablist" className="flex-row border-b border-border">
            {(
              [
                ["graph", "Knowledge Graph"],
                ["skill", "Auto-Skills"],
                ["memory", "Memories"],
              ] as const
            ).map(([value, label]) => (
              <Pressable
                key={value}
                accessibilityRole="tab"
                accessibilityState={{ selected: tab === value }}
                onPress={() => setTab(value)}
                className={`flex-1 border-b-2 px-1 py-3 ${tab === value ? "border-blue-500" : "border-transparent"}`}
              >
                <Text
                  className={`text-center text-sm ${tab === value ? "text-blue-500" : "text-foreground-muted"}`}
                >
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        {!threadId && tab === "graph" && workspace && (
          <View className="gap-3">
            <Text className="text-sm text-foreground-muted">
              {workspace.knowledge.entities.length} entities · {workspace.knowledge.edges.length}{" "}
              relationships
            </Text>
            {!workspace.knowledge.entities.length && (
              <Text className="py-6 text-foreground-muted">
                Connect a source to map your code and its connections.
              </Text>
            )}
            {graphEntities.map((entity) => (
              <View key={entity.id} className="gap-2 rounded-2xl bg-surface p-4">
                <Text className="font-t3-semibold text-foreground">{entity.name}</Text>
                <Text className="text-xs text-foreground-muted">{entity.kind}</Text>
                {!!entity.description && (
                  <Text className="text-sm leading-5 text-foreground">{entity.description}</Text>
                )}
                {entity.links.map((link) => (
                  <Text key={link.key} className="text-xs text-foreground-muted">
                    {link.text}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        )}
        {threadId && (
          <View className="gap-3 rounded-2xl bg-surface p-4">
            <Text className="text-lg font-t3-semibold text-foreground">Conversation notes</Text>
            <Text className="text-xs text-foreground-muted">
              {notes?.status === "extracting"
                ? "Updating notes, memories, and skills…"
                : notes?.status === "error"
                  ? "Extraction needs attention. Flow will retry."
                  : notes?.status === "disabled"
                    ? "Automatic extraction is disabled."
                    : notes?.notes
                      ? "Saved from this conversation"
                      : workspace
                        ? "Ready for conversation notes"
                        : "Connect a brain to preserve this conversation."}
            </Text>
            {notes?.notes ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Read conversation notes"
                onPress={() => setSelected(notes.notes!)}
              >
                <Text numberOfLines={8} className="text-base leading-6 text-foreground">
                  {notes.notes.text}
                </Text>
                <Text className="mt-3 text-sm text-blue-500">Read full notes →</Text>
              </Pressable>
            ) : (
              <Text className="text-sm text-foreground-muted">
                Your task, progress, and corrections will appear here.
              </Text>
            )}
            {!!notes?.extractionError && (
              <Text className="text-xs text-red-500">{notes.extractionError}</Text>
            )}
          </View>
        )}
        {(["skill", "memory"] as const).map((kind) => {
          if (!threadId && tab !== kind) return null;
          const rows = documents.filter((doc) => doc.kind === kind);
          const old = kind === "memory" ? legacy : [];
          if (!rows.length && !old.length)
            return threadId ? null : (
              <Text key={kind} className="py-6 text-foreground-muted">
                {kind === "skill"
                  ? "No auto-skills yet. Reusable procedures will appear as you work in connected chats."
                  : "No memories yet. Decisions, lessons, and useful context will appear as you work in connected chats."}
              </Text>
            );
          return (
            <View key={kind} className="gap-3">
              <Text className="text-lg font-t3-semibold text-foreground">
                {kind === "skill" ? (threadId ? "Skills" : "Auto-Skills") : "Memories"} ·{" "}
                {rows.length + old.length}
              </Text>
              {rows.map((doc) => (
                <Pressable
                  key={doc.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Read ${kind}: ${doc.name}`}
                  onPress={() => setSelected(doc)}
                  className="gap-2 rounded-2xl bg-surface p-4"
                >
                  <Text className="font-t3-semibold text-foreground">{doc.name}</Text>
                  {!!doc.description && (
                    <Text numberOfLines={3} className="text-sm leading-5 text-foreground-muted">
                      {doc.description}
                    </Text>
                  )}
                  <Text className="text-xs text-foreground-muted">
                    {kind === "skill" ? "SKILL.md · " : ""}
                    {doc.status === "resolved"
                      ? "Resolved · lesson retained"
                      : doc.lifecycle === "temporal"
                        ? "Time-sensitive context"
                        : doc.lifecycle === "issue"
                          ? "Open issue"
                          : "Reusable context"}
                  </Text>
                </Pressable>
              ))}
              {old.map((doc) => (
                <View key={doc.id} className="rounded-2xl bg-surface p-4">
                  <Text selectable className="text-base leading-6 text-foreground">
                    {doc.body}
                  </Text>
                </View>
              ))}
            </View>
          );
        })}
        {response && !workspace && (
          <Text className="text-foreground-muted">
            {threadId
              ? "Connect a brain to this project from Flow on your computer."
              : "Create a brain in Flow on this computer to start collecting shared knowledge."}
          </Text>
        )}
      </ScrollView>
      {environmentId && workspace && (
        <MobileBrainDocument
          document={selected}
          initial={selected?.kind === "notes" ? (notes?.notes ?? undefined) : undefined}
          environmentId={environmentId}
          workspaceId={workspace.id}
          onClose={() => setSelected(null)}
        />
      )}
    </View>
  );
}

function MobileBrainDocument(props: Parameters<typeof MobileBrainDocumentContent>[0]) {
  return (
    <MobileBrainDocumentContent
      key={`${props.environmentId}:${props.workspaceId}:${props.document?.id ?? "closed"}:${props.document?.revision ?? 0}`}
      {...props}
    />
  );
}

function MobileBrainDocumentContent({
  document,
  initial,
  environmentId,
  workspaceId,
  onClose,
}: {
  document: BrainDocumentSummary | null;
  initial?: BrainDocument;
  environmentId: EnvironmentId;
  workspaceId: string;
  onClose: () => void;
}) {
  const execute = useAtomCommand(brainCommand, { reportFailure: false });
  const insets = useSafeAreaInsets();
  const styles = useMarkdownPreviewStyles();
  const [loaded, setLoaded] = useState<BrainDocument | null>(
    initial?.id === document?.id ? (initial ?? null) : null,
  );
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const id = document?.id,
    revision = document?.revision;
  useEffect(() => {
    let disposed = false;
    if (!id) return;
    if (initial?.id === id && initial.revision === revision) {
      return;
    }
    void execute({ environmentId, input: { action: "readDocument", workspaceId, documentId: id } })
      .then((result) => {
        if (disposed) return;
        if (result._tag === "Failure") setError("Could not load this document.");
        else if (result.value.error || !result.value.document)
          setError(result.value.error ?? "Document unavailable.");
        else setLoaded(result.value.document);
      })
      .catch(() => {
        if (!disposed) setError("Could not load this document.");
      });
    return () => {
      disposed = true;
    };
  }, [id, revision, initial, environmentId, workspaceId, execute]);
  return (
    <Modal
      visible={Boolean(document)}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View
        className="flex-1 bg-sheet"
        style={{ paddingTop: Platform.OS === "android" ? insets.top : 18 }}
      >
        <View className="flex-row items-center justify-between px-5 py-3">
          <Text className="text-xs text-foreground-muted">
            {document?.kind === "skill" ? "SKILL.md" : "Brain document"}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close document"
            onPress={onClose}
            className="px-3 py-2"
          >
            <Text className="font-t3-semibold text-blue-500">Done</Text>
          </Pressable>
        </View>
        <ScrollView
          contentContainerClassName="gap-4 px-5"
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        >
          <Text className="text-2xl font-t3-bold text-foreground">{document?.name}</Text>
          {!!error && (
            <Text accessibilityRole="alert" className="text-red-500">
              {error}
            </Text>
          )}
          {!loaded && !error && <Text className="text-foreground-muted">Opening document…</Text>}
          {loaded && (
            <>
              <Text className="text-xs text-foreground-muted">
                Revision {loaded.revision} · Updated{" "}
                {new Date(loaded.updatedAt).toLocaleDateString()}
                {loaded.observedAt !== undefined &&
                  ` · Evidence from ${new Date(loaded.observedAt).toLocaleDateString()}`}
              </Text>
              {loaded.kind === "skill" && (
                <>
                  <Text className="text-sm leading-5 text-foreground-muted">
                    {loaded.description}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() =>
                      void tryCopyTextWithHaptic(
                        `Use the “${loaded.name}” skill from Flow brain ${workspaceId} in a chat connected to that brain. Read its latest version with read_skill (id: ${loaded.id}) before applying it to this task.`,
                      ).then(setCopied)
                    }
                    className="self-start rounded-full bg-surface px-4 py-3"
                  >
                    <Text className="text-blue-500">{copied ? "Copied" : "Copy chat prompt"}</Text>
                  </Pressable>
                  <Text className="text-xs text-foreground-muted">
                    Use this skill in a chat connected to this brain.
                  </Text>
                </>
              )}
              <Markdown
                options={{ gfm: true }}
                renderers={styles.renderers}
                styles={styles.styles}
                theme={styles.theme}
              >
                {loaded.kind === "skill"
                  ? loaded.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
                  : loaded.text}
              </Markdown>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
