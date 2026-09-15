import { useEffect, useId, useRef, type ReactNode } from "react";
import { XIcon } from "lucide-react";

export function BrainConnectionDialog({ title, description, children, onClose }: { title: string; description: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="flow-brain-connection-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header><h2 id={titleId}>{title}</h2><p>{description}</p><button type="button" className="flow-brain-icon-button" aria-label="Close dialog" onClick={onClose}><XIcon size={16} /></button></header>
    <div className="flow-brain-connection-body">{children}</div>
    <footer><button type="button" className="flow-brain-button secondary" onClick={onClose}>Close</button></footer>
  </dialog>;
}
