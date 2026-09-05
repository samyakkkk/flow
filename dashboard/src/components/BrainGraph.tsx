"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { useProject } from "@/lib/useProject";
import { Kicker } from "@/components/ui";
import type { FalkorDBCanvas, GraphNode as FalkorGraphNode } from "@falkordb/canvas";

// Node type → warm-analogous color palette (against --ink dark canvas)
const TYPE_COLORS: Record<string, string> = {
  service:      "#FFD580", // warm amber
  Service:      "#FFD580",
  capability:   "#A8D8A8", // muted sage green
  Capability:   "#A8D8A8",
  api:          "#F7B267", // soft orange
  Api:          "#F7B267",
  API:          "#F7B267",
  resource:     "#C9B8E8", // muted lavender
  Resource:     "#C9B8E8",
  concept:      "#9ECFE8", // calm blue
  Concept:      "#9ECFE8",
  decision:     "#F7C59F", // peachy
  Decision:     "#F7C59F",
  person:       "#E8B4C8", // rose
  Person:       "#E8B4C8",
  repo:         "#B8D4C8", // teal-sage
  Repo:         "#B8D4C8",
  file:         "#D4C8B8", // warm gray
  File:         "#D4C8B8",
};

const DEFAULT_NODE_COLOR = "rgb(162, 163, 148)"; // --text-muted adapted
const GRAPH_PAGE_LIMIT = 500;

function getTypeColor(type: string): string {
  return TYPE_COLORS[type] ?? DEFAULT_NODE_COLOR;
}

// Legend: unique types present in graph
function GraphLegend({ types }: { types: string[] }) {
  if (types.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-3 px-4 py-2.5 border-t border-line">
      {types.slice(0, 8).map((t) => (
        <div key={t} className="flex items-center gap-1.5">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ background: getTypeColor(t) }}
          />
          <span
            style={{ fontFamily: "var(--font-mono)" }}
            className="text-[10px] uppercase tracking-wider text-text-muted"
          >
            {t}
          </span>
        </div>
      ))}
    </div>
  );
}

interface CyNode {
  id: string;
  data: { name: string; type: string; description?: string };
}

interface CyEdge {
  source: string;
  target: string;
  label: string;
}

interface GraphData {
  nodes: CyNode[];
  edges: CyEdge[];
  total?: number;
  nodeTotal?: number;
  edgeTotal?: number;
  partial?: boolean;
  error?: string;
}

interface GraphPage extends GraphData {
  page?: {
    nextOffset: number | null;
  };
}

interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  error?: string;
}

interface NodeCardData {
  id: string;
  name: string;
  type: string;
  description?: string;
}

// Node info card shown on click
function NodeCard({ node, onClose }: { node: NodeCardData; onClose: () => void }) {
  const color = getTypeColor(node.type);
  return (
    <div
      className="absolute bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-72 rounded-lg border border-line bg-paper shadow-md p-4 rise-in"
      style={{ zIndex: 10 }}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{ background: color }}
          />
          <span
            style={{ fontFamily: "var(--font-mono)" }}
            className="text-[10px] uppercase tracking-wider text-text-muted"
          >
            {node.type}
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-text-muted hover:text-ink transition text-xs flex-shrink-0"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <div
        style={{ fontFamily: "var(--font-display)" }}
        className="text-ink text-base font-medium leading-snug mb-1 break-words"
      >
        {node.name}
      </div>
      {node.description && (
        <p className="text-text-muted text-[12px] leading-relaxed">
          {node.description}
        </p>
      )}
      {!node.description && (
        <p className="text-text-muted text-[12px] italic">No description available.</p>
      )}
    </div>
  );
}

interface BrainGraphProps {
  // If provided, show only the neighborhood of these cited node ids (Ask view highlight mode)
  citedNodeIds?: string[];
  // Poll interval for the full overview (ms). 0 to disable polling.
  pollInterval?: number;
  // Height of the graph canvas
  height?: number;
  // When true, the component expands to fill its flex parent instead of using a fixed pixel height
  fillHeight?: boolean;
  // Show the full overview (true) vs load neighborhood data externally
  mode?: "overview" | "neighborhood";
  // For neighborhood mode: pass pre-fetched data
  externalData?: GraphData | null;
  // When true, shows a pulsing "UPDATING THE BRAIN…" overlay on the canvas corner
  isIndexing?: boolean;
  // Callback when a node is clicked in the graph
  onNodeClick?: (nodeName: string) => void;
  // Emits total graph counts as soon as the paged overview reports them.
  onStats?: (stats: GraphStats) => void;
}

export function BrainGraph({
  citedNodeIds,
  pollInterval = 0,
  height = 420,
  mode = "overview",
  externalData,
  isIndexing = false,
  onNodeClick,
  onStats,
}: BrainGraphProps) {
  const { prefix } = useProject();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<FalkorDBCanvas | null>(null);
  const activeFetchRef = useRef<AbortController | null>(null);
  const hasGraphDataRef = useRef(false);
  // Display id (string) → stable numeric id: @falkordb/canvas addresses nodes
  // by number, and keeping numbers stable across poll refreshes lets
  // setGraphData preserve simulation positions instead of re-randomizing.
  const numericIdsRef = useRef<Map<string, number>>(new Map());
  const dataSignatureRef = useRef<string>("");
  const topologySignatureRef = useRef<string>("");
  const citedSetRef = useRef<Set<string>>(new Set());
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(mode === "overview");
  const [selectedNode, setSelectedNode] = useState<NodeCardData | null>(null);

  const fetchOverview = useCallback(async () => {
    activeFetchRef.current?.abort();
    const controller = new AbortController();
    activeFetchRef.current = controller;

    if (!hasGraphDataRef.current) setLoading(true);

    const fetchPart = async (part: "summary" | "nodes" | "edges", offset = 0): Promise<GraphPage> => {
      const qs = new URLSearchParams({ part, limit: String(GRAPH_PAGE_LIMIT) });
      if (part !== "summary") qs.set("offset", String(offset));
      const res = await fetch(prefix(`/api/graph/overview?${qs.toString()}`), {
        signal: controller.signal,
      });
      const data = (await res.json()) as GraphPage;
      if (!res.ok) throw new Error(data.error ?? `status ${res.status}`);
      return data;
    };

    const nodesById = new Map<string, CyNode>();
    const edgesByKey = new Map<string, CyEdge>();
    let nodeTotal = 0;
    let edgeTotal = 0;

    const publish = (partial: boolean) => {
      const nodes = Array.from(nodesById.values());
      const edges = Array.from(edgesByKey.values());
      const data: GraphData = { nodes, edges, total: nodeTotal || nodes.length, nodeTotal, edgeTotal, partial };
      hasGraphDataRef.current = true;
      setGraphData(data);
      onStats?.({ nodeCount: nodeTotal || nodes.length, edgeCount: edgeTotal || edges.length });
    };

    const merge = (page: GraphData) => {
      for (const n of page.nodes ?? []) nodesById.set(n.id, n);
      for (const e of page.edges ?? []) edgesByKey.set(`${e.source}->${e.label}->${e.target}`, e);
    };

    try {
      const summary = await fetchPart("summary");
      nodeTotal = summary.nodeTotal ?? summary.total ?? 0;
      edgeTotal = summary.edgeTotal ?? 0;
      onStats?.({ nodeCount: nodeTotal, edgeCount: edgeTotal });

      if (nodeTotal === 0) {
        publish(false);
        return;
      }

      let nodeOffset = 0;
      for (;;) {
        const page = await fetchPart("nodes", nodeOffset);
        merge(page);
        publish(true);
        if (page.page?.nextOffset === null || page.page?.nextOffset === undefined) break;
        nodeOffset = page.page.nextOffset;
      }

      let edgeOffset = 0;
      for (;;) {
        const page = await fetchPart("edges", edgeOffset);
        merge(page);
        if (page.page?.nextOffset === null || page.page?.nextOffset === undefined) break;
        publish(true);
        edgeOffset = page.page.nextOffset;
      }

      publish(false);
    } catch {
      if (controller.signal.aborted) return;
      hasGraphDataRef.current = true;
      setGraphData({ nodes: [], edges: [], error: "unavailable" });
      onStats?.({ nodeCount: 0, edgeCount: 0, error: "unavailable" });
    } finally {
      if (activeFetchRef.current === controller) {
        activeFetchRef.current = null;
        setLoading(false);
      }
    }
  }, [onStats, prefix]);

  // Load data
  useEffect(() => {
    if (mode === "neighborhood" && externalData !== undefined) {
      activeFetchRef.current?.abort();
      const timer = setTimeout(() => {
        hasGraphDataRef.current = Boolean(externalData);
        setGraphData(externalData);
        setLoading(false);
      }, 0);
      return () => clearTimeout(timer);
    }
    if (mode === "overview") {
      const timer = setTimeout(() => {
        void fetchOverview();
      }, 0);
      if (pollInterval > 0) {
        const iv = setInterval(fetchOverview, pollInterval);
        return () => {
          clearTimeout(timer);
          clearInterval(iv);
          activeFetchRef.current?.abort();
        };
      }
      return () => {
        clearTimeout(timer);
        activeFetchRef.current?.abort();
      };
    }
    return () => {
      activeFetchRef.current?.abort();
    };
  }, [mode, externalData, pollInterval, fetchOverview]);

  // Build/update the graph via @falkordb/canvas — the same renderer FalkorDB's
  // own browser uses (force-graph + d3-force under a web component). It gives
  // us the spread-out constellation the cytoscape layout never achieved:
  // charge -400, collision = node size + padding, weak centering, and
  // level-of-detail zoom (labels appear as you zoom in — semantic zoom).
  useEffect(() => {
    // Node-only pages would settle and pin nodes before their edges arrive.
    // Keep pagination progress separate from the complete graph's layout.
    if (!graphData || graphData.partial || !containerRef.current) return;

    const nodes = graphData.nodes ?? [];
    const edges = graphData.edges ?? [];

    const citedSet = new Set(citedNodeIds ?? []);
    const hasCited = citedSet.size > 0;
    citedSetRef.current = citedSet;

    if (nodes.length === 0) {
      canvasRef.current?.remove();
      canvasRef.current = null;
      dataSignatureRef.current = "";
      topologySignatureRef.current = "";
      return;
    }

    let cancelled = false;
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    import("@falkordb/canvas").then(() => {
      if (cancelled || !containerRef.current) return;

      // Stable numeric ids across refreshes so incremental updates keep positions.
      const numericIds = numericIdsRef.current;
      const numId = (displayId: string): number => {
        let n = numericIds.get(displayId);
        if (n === undefined) {
          n = numericIds.size + 1;
          numericIds.set(displayId, n);
        }
        return n;
      };

      // Degree drives node radius — hubs anchor the constellation.
      const degree = new Map<string, number>();
      for (const e of edges) {
        degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
        degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
      }

      const data = {
        nodes: nodes.map((n) => ({
          id: numId(n.id),
          labels: [n.data.type],
          color: hasCited && citedSet.has(n.id) ? "rgb(255, 247, 129)" : getTypeColor(n.data.type),
          visible: true,
          size: 8 + Math.min(degree.get(n.id) ?? 0, 20) * 0.8, // 8–24 world units
          data: {
            name: n.data.name,
            displayId: n.id,
            type: n.data.type,
            description: n.data.description ?? "",
          },
        })),
        links: edges.map((e, i) => ({
          id: i + 1,
          relationship: e.label,
          color: "rgba(242, 243, 235, 0.18)",
          visible: true,
          source: numId(e.source),
          target: numId(e.target),
          data: {},
        })),
      };

      let canvas = canvasRef.current;
      const firstPaint = !canvas;
      if (!canvas) {
        canvas = document.createElement("falkordb-canvas");
        canvas.style.display = "block";
        canvas.style.position = "absolute";
        canvas.style.top = "0";
        canvas.style.left = "0";
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.maxHeight = "100%";
        canvas.style.maxWidth = "100%";
        canvas.style.overflow = "hidden";
        containerRef.current.appendChild(canvas);
        canvasRef.current = canvas;
        canvas.setBackgroundColor("rgb(54, 55, 38)"); // --ink
        canvas.setForegroundColor("rgb(242, 243, 235)"); // --paper
      }

      canvas.setConfig({
        // Tuples, not bare strings — entries are destructured as [key, exactMatch].
        captionsKeys: [["name", true]],
        showPropertyKeyPrefix: false,
        nodeStyle: { fontFamily: "Space Mono, monospace" },
        isNodeDimmed: (node: FalkorGraphNode) =>
          hasCited && !citedSetRef.current.has(String(node.data?.displayId ?? "")),
        eventHandlers: {
          onNodeClick: (node: FalkorGraphNode) => {
            const d = (node.data ?? {}) as Record<string, string>;
            const nodeName = d.name ?? String(node.id);
            setSelectedNode({
              id: d.displayId ?? String(node.id),
              name: nodeName,
              type: d.type ?? node.labels?.[0] ?? "node",
              description: d.description || undefined,
            });
            onNodeClick?.(nodeName);
          },
          onBackgroundClick: () => setSelectedNode(null),
        },
      });
      canvas.setDimmed(hasCited);

      // setData re-runs layout + zoomToFit; setGraphData merges and preserves
      // positions. Poll refreshes with identical data are skipped entirely so
      // the constellation never jitters while we watch indexing progress.
      const topologySignature = JSON.stringify([
        nodes.map((n) => n.id).sort(),
        edges.map((e) => JSON.stringify([e.source, e.target, e.label])).sort(),
      ]);
      const signature = JSON.stringify([topologySignature, citedNodeIds ?? []]);
      const changed = signature !== dataSignatureRef.current;
      const topologyChanged = topologySignature !== topologySignatureRef.current;
      if (firstPaint || topologyChanged) {
        canvas.setData(data);
      } else if (changed) {
        canvas.setGraphData(data);
      }
      dataSignatureRef.current = signature;
      topologySignatureRef.current = topologySignature;

      // Fit the view to the connected constellation: isolated nodes drift to
      // the edges under charge and would otherwise shrink the main cluster to
      // a fraction of the canvas. Runs after the canvas's own zoomToFit (50ms)
      // and a chunk of simulation warmup.
      if (firstPaint || changed) {
        const connected = new Set<number>();
        for (const l of data.links) {
          connected.add(l.source);
          connected.add(l.target);
        }
        if (connected.size > 0) {
          fitTimer = setTimeout(() => {
            if (canvasRef.current === canvas) {
              canvas.zoomToFit(1, (n: FalkorGraphNode) => connected.has(n.id as number));
            }
          }, 900);
        }
      }
    });

    return () => {
      cancelled = true;
      clearTimeout(fitTimer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData, citedNodeIds?.join(",")]);

  // Remove the canvas element on unmount.
  useEffect(
    () => () => {
      canvasRef.current?.remove();
      canvasRef.current = null;
    },
    []
  );

  const uniqueTypes = Array.from(new Set((graphData?.nodes ?? []).map((n) => n.data.type))).filter(Boolean);
  const nodeCount = graphData?.nodes?.length ?? 0;
  const edgeCount = graphData?.edges?.length ?? 0;
  const nodeTotal = graphData?.nodeTotal ?? graphData?.total ?? nodeCount;
  const edgeTotal = graphData?.edgeTotal ?? edgeCount;
  const isEmpty = !loading && nodeCount === 0;
  const graphUnavailable = !loading && graphData?.error;
  const countText =
    graphData?.partial && nodeTotal > nodeCount
      ? `${nodeCount}/${nodeTotal} nodes · ${edgeCount}/${edgeTotal} edges`
      : `${nodeTotal || nodeCount} nodes · ${edgeTotal || edgeCount} edges`;

  const headerHeight = 36;
  const canvasHeight = height - headerHeight;

  return (
    <div
      className="rounded-lg border border-line overflow-hidden flex flex-col w-full relative"
      style={{ background: "rgb(54, 55, 38)", height: `${height}px`, maxHeight: `${height}px`, minHeight: `${height}px` }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/8 flex-shrink-0" style={{ height: `${headerHeight}px` }}>
        <Kicker>The brain</Kicker>
        {(nodeCount > 0 || nodeTotal > 0) && (
          <span
            style={{ fontFamily: "var(--font-mono)" }}
            className="text-[10px] uppercase tracking-wider text-white/40"
          >
            {countText}
          </span>
        )}
      </div>

      {/* Canvas Wrapper - Fixed height pixel bounds */}
      <div className="relative w-full overflow-hidden" style={{ height: `${canvasHeight}px`, maxHeight: `${canvasHeight}px`, minHeight: `${canvasHeight}px` }}>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <div
                className="w-10 h-10 rounded-full border border-white/20 mx-auto mb-3 animate-pulse"
                style={{ background: "rgba(255,247,129,0.08)" }}
              />
              <p
                style={{ fontFamily: "var(--font-mono)" }}
                className="text-[11px] uppercase tracking-wider text-white/30"
              >
                Thinking…
              </p>
            </div>
          </div>
        )}

        {isEmpty && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center px-8">
              <div
                className="w-12 h-12 rounded-full border border-white/12 mx-auto mb-4 flex items-center justify-center"
                style={{ background: isIndexing ? "rgba(255,247,129,0.12)" : "rgba(255,247,129,0.06)", transition: "background 0.4s" }}
              >
                {isIndexing ? (
                  <span className="w-4 h-4 rounded-full animate-pulse" style={{ background: "rgba(255,247,129,0.5)" }} />
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="3" fill="rgba(255,247,129,0.6)" />
                    <circle cx="5" cy="7" r="1.6" fill="rgba(255,247,129,0.3)" />
                    <circle cx="19" cy="7" r="1.6" fill="rgba(255,247,129,0.3)" />
                    <circle cx="5" cy="17" r="1.6" fill="rgba(255,247,129,0.3)" />
                    <circle cx="19" cy="17" r="1.6" fill="rgba(255,247,129,0.3)" />
                    <path d="M12 12L5 7M12 12L19 7M12 12L5 17M12 12L19 17" stroke="rgba(255,247,129,0.2)" strokeWidth="0.8" />
                  </svg>
                )}
              </div>
              <p
                style={{ fontFamily: "var(--font-display)" }}
                className="text-white/50 text-sm mb-1"
              >
                {graphUnavailable
                  ? "Brain gateway unavailable."
                  : mode === "neighborhood"
                  ? "No graph context for these citations."
                  : isIndexing
                  ? "The brain is being built…"
                  : "The brain is empty."}
              </p>
              <p
                style={{ fontFamily: "var(--font-mono)" }}
                className="text-[10px] uppercase tracking-wider text-white/25"
              >
                {graphUnavailable
                  ? "Graph data could not be loaded."
                  : mode === "overview"
                  ? isIndexing
                    ? "Nodes will appear as Flow reads your sources."
                    : "Connect a source to start building."
                  : "Gateway may be unavailable."}
              </p>
            </div>
          </div>
        )}

        {/* Hard-bounded canvas container */}
        <div
          ref={containerRef}
          className="absolute inset-0 w-full h-full overflow-hidden"
          style={{
            visibility: isEmpty || loading ? "hidden" : "visible",
            opacity: isIndexing && !isEmpty && !loading ? 0.6 : 1,
            transition: "opacity 0.4s ease",
          }}
        />

        {/* Indexing overlay — pulsing accent dot + mono label in top-right corner.
            Shown whenever indexing is active, regardless of whether graph has nodes.
            When graph has nodes it also dims them (opacity above); when empty it
            shows alongside the empty-state message. */}
        {isIndexing && !loading && (
          <div
            className="absolute top-3 right-3 flex items-center gap-2 px-2.5 py-1.5 rounded-lg"
            style={{
              background: "rgba(54, 55, 38, 0.85)",
              border: "1px solid rgba(255, 247, 129, 0.2)",
              backdropFilter: "blur(4px)",
              zIndex: 5,
            }}
            data-testid="brain-indexing-overlay"
          >
            <span
              className="inline-block w-2 h-2 rounded-full animate-pulse flex-shrink-0"
              style={{ background: "rgb(255, 247, 129)" }}
            />
            <span
              style={{ fontFamily: "var(--font-mono)", color: "rgba(255, 247, 129, 0.85)" }}
              className="text-[9px] uppercase tracking-widest"
            >
              Updating the brain…
            </span>
          </div>
        )}

        {selectedNode && (
          <NodeCard node={selectedNode} onClose={() => setSelectedNode(null)} />
        )}
      </div>

      {/* Legend */}
      {!isEmpty && !loading && (
        <div style={{ background: "rgba(54,55,38,0.95)", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          <GraphLegend types={uniqueTypes} />
        </div>
      )}
    </div>
  );
}
