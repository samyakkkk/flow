import { ListIcon } from "lucide-react";
import type { BrainSourceCard } from "./types.ts";

export function BrainSourceCatalog({
  title = "Sources",
  description,
  cards,
}: {
  readonly title?: string;
  readonly description: string;
  readonly cards: readonly BrainSourceCard[];
}) {
  return (
    <section className="flow-brain-sources" aria-label={title}>
      <header><h2>{title}</h2><p>{description}</p></header>
      <div className="flow-brain-source-grid">
        {cards.map((card) => (
          <article key={card.id}>
            <span className="flow-brain-source-icon">{card.icon}</span>
            <div><h3>{card.name}</h3><p>{card.description}</p></div>
            {card.onAction ? (
              <footer>
                <button type="button" className="flow-brain-button secondary" onClick={card.onAction}>{card.actionLabel ?? "Connect"}</button>
                {card.onList && <button type="button" className="flow-brain-icon-button" aria-label={`Connected ${card.name}`} onClick={card.onList}><ListIcon size={16} /></button>}
              </footer>
            ) : <span className="flow-brain-source-status">{card.status ?? "Coming later"}</span>}
          </article>
        ))}
      </div>
    </section>
  );
}
