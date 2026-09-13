import { useEffect, useRef, useState } from "react";
import type { FalkorDBCanvas, GraphNode } from "@falkordb/canvas";
import { XIcon } from "lucide-react";
import type { BrainUiKnowledge } from "./types.ts";

const colors = ["#d39c38", "#64a58a", "#8296d9", "#b28bc5", "#62a5bb", "#c48180"];
const noHighlightedNodeIds: readonly string[] = [];

export function BrainGraph({
  knowledge,
  compact = false,
  highlightedNodeIds = noHighlightedNodeIds,
}: {
  readonly knowledge: BrainUiKnowledge;
  readonly compact?: boolean;
  readonly highlightedNodeIds?: readonly string[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<FalkorDBCanvas | null>(null);
  const numericIds = useRef(new Map<string, number>());
  const topology = useRef("");
  const signature = useRef("");
  const highlightedIds = useRef(new Set<string>());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const types = [...new Set(knowledge.entities.map((entry) => entry.kind))].sort();
  const selected = knowledge.entities.find((entry) => entry.id === selectedId);
  const highlightSignature = [...new Set(highlightedNodeIds)].sort().join("\u0000");

  useEffect(() => {
    let cancelled = false;
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    void import("@falkordb/canvas")
      .then(() => {
        if (cancelled || !host.current) return;
        const numId = (id: string) => {
          let numeric = numericIds.current.get(id);
          if (numeric === undefined) {
            numeric = numericIds.current.size + 1;
            numericIds.current.set(id, numeric);
          }
          return numeric;
        };
        const degree = new Map<string, number>();
        for (const edge of knowledge.edges) {
          degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
          degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
        }
        const nodeTypes = [...new Set(knowledge.entities.map((entry) => entry.kind))].sort();
        const highlighted = new Set(highlightSignature ? highlightSignature.split("\u0000") : []);
        const hasHighlights = highlighted.size > 0;
        highlightedIds.current = highlighted;
        const dark = matchMedia("(prefers-color-scheme: dark)").matches || document.documentElement.classList.contains("dark");
        const data = {
          nodes: knowledge.entities.map((entry) => ({
            id: numId(entry.id),
            labels: [entry.kind],
            color: highlighted.has(entry.id)
              ? "#f8cf54"
              : colors[nodeTypes.indexOf(entry.kind) % colors.length]!,
            visible: true,
            size: 8 + Math.min(degree.get(entry.id) ?? 0, 20) * 0.8 + (highlighted.has(entry.id) ? 4 : 0),
            data: { name: entry.name, displayId: entry.id },
          })),
          links: knowledge.edges.map((edge, index) => ({
            id: index + 1,
            relationship: edge.label,
            source: numId(edge.from),
            target: numId(edge.to),
            color: dark ? "rgba(220,220,230,.25)" : "rgba(80,80,100,.25)",
            visible: true,
            data: {},
          })),
        };
        let canvas = canvasRef.current;
        const firstPaint = !canvas;
        if (!canvas) {
          canvas = document.createElement("falkordb-canvas");
          canvas.className = "flow-brain-canvas-element";
          host.current.appendChild(canvas);
          canvasRef.current = canvas;
        }
        const style = getComputedStyle(host.current);
        canvas.setBackgroundColor(style.backgroundColor);
        canvas.setForegroundColor(style.color);
        canvas.setConfig({
          captionsKeys: [["name", true]],
          showPropertyKeyPrefix: false,
          nodeStyle: { fontFamily: style.fontFamily },
          isNodeDimmed: (node: GraphNode) =>
            hasHighlights && !highlightedIds.current.has(String(node.data?.displayId ?? "")),
          eventHandlers: {
            onNodeClick: (node: GraphNode) => setSelectedId(String(node.data?.displayId ?? "")),
            onBackgroundClick: () => setSelectedId(null),
          },
        });
        canvas.setDimmed(hasHighlights);
        const nextTopology = JSON.stringify([
          knowledge.entities.map((entry) => entry.id).sort(),
          knowledge.edges,
        ]);
        const nextSignature = JSON.stringify([knowledge, dark, highlightSignature]);
        if (firstPaint || topology.current !== nextTopology) canvas.setData(data);
        else if (signature.current !== nextSignature) canvas.setGraphData(data);
        topology.current = nextTopology;
        signature.current = nextSignature;
        if (firstPaint) {
          const connected = new Set(data.links.flatMap((edge) => [edge.source, edge.target]));
          if (connected.size > 0)
            // @effect-diagnostics-next-line globalTimers:off -- canvas layout settles asynchronously before zoom-to-fit.
            fitTimer = setTimeout(() => {
              if (canvasRef.current === canvas)
                canvas.zoomToFit(1, (node: GraphNode) => connected.has(node.id as number));
            }, 900);
        }
      })
      .catch(() => {
        if (!cancelled) setError("The graph could not be displayed. Reload this page to retry.");
      });
    return () => {
      cancelled = true;
      clearTimeout(fitTimer);
    };
  }, [knowledge, highlightSignature]);

  useEffect(
    () => () => {
      canvasRef.current?.remove();
      canvasRef.current = null;
    },
    [],
  );

  return (
    <div className="flow-brain-graph">
      <div className={compact ? "flow-brain-graph-canvas compact" : "flow-brain-graph-canvas"}>
        <div ref={host} className="flow-brain-graph-host" />
        {error && <p role="alert" className="flow-brain-alert">{error}</p>}
        {selected && (
          <article className="flow-brain-node-details">
            <div className="flow-brain-node-details-heading">
              <span>{selected.kind}</span>
              <button type="button" aria-label="Close entity details" onClick={() => setSelectedId(null)}>
                <XIcon size={12} />
              </button>
            </div>
            <h3>{selected.name}</h3>
            <p>{selected.description}</p>
            {selected.properties && (
              <dl>
                {Object.entries(selected.properties).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key.replaceAll("_", " ")}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {selected.source?.startsWith("https://github.com/") ? (
              <a href={selected.source} target="_blank" rel="noreferrer">View source ↗</a>
            ) : selected.source ? <p className="flow-brain-node-source">{selected.source}</p> : null}
          </article>
        )}
      </div>
      {!compact && (
        <footer className="flow-brain-graph-legend">
          {types.map((type, index) => (
            <span key={type}>
              <i className={`flow-brain-color-${index % colors.length}`} />
              {type}
            </span>
          ))}
          <span className="flow-brain-graph-help">Drag to explore · Scroll to zoom</span>
        </footer>
      )}
    </div>
  );
}
