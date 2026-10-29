import React, { useEffect, useRef, useState } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { Check, Copy, Mail, Phone, X } from "lucide-react";

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

/* ------------------------------------------------------------------ */
/* Overlays: un solo vocabulario para todos los drawers y modales.     */
/* Todos cierran con la X, con Escape y con clic en el backdrop, y en  */
/* un Escape solo cierra el overlay superior (pila compartida).        */
/* ------------------------------------------------------------------ */

const dismissStack: Array<() => void> = [];

function useDismiss(onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const entry = () => closeRef.current();
    dismissStack.push(entry);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissStack[dismissStack.length - 1] === entry) entry();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      const i = dismissStack.indexOf(entry);
      if (i >= 0) dismissStack.splice(i, 1);
      document.body.style.overflow = prevOverflow;
    };
  }, []);
}

const closeBtnClass =
  "p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition shrink-0";

interface SlideOverProps {
  children?: React.ReactNode;
  onClose: () => void;
  title: React.ReactNode;
  meta?: React.ReactNode;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  footerClassName?: string;
  width?: string;
}

/** Drawer lateral derecho. Los children van dentro del área scrolleable sin padding: envolver en `p-6`. */
export const SlideOver: React.FC<SlideOverProps> = ({
  onClose,
  title,
  meta,
  badge,
  actions,
  footer,
  footerClassName,
  width = "max-w-2xl",
  children,
}) => {
  useDismiss(onClose);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 anim-fade-in" onClick={onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          "relative w-full h-full flex flex-col outline-none bg-zinc-950 border-l border-zinc-800 shadow-2xl anim-slide-in",
          width
        )}
      >
        <header className="shrink-0 px-6 py-5 border-b border-zinc-800/80 bg-zinc-900/40 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap min-w-0">
              <h3 className="text-lg font-bold text-white truncate">{title}</h3>
              {badge}
            </div>
            {meta && (
              <div className="text-xs text-zinc-400 mt-1.5 flex items-center gap-x-3 gap-y-1 flex-wrap">
                {meta}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {actions}
            <button onClick={onClose} aria-label="Cerrar" className={closeBtnClass}>
              <X className="w-5 h-5" />
            </button>
          </div>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
        {footer && (
          <footer
            className={cn("shrink-0 p-4 border-t border-zinc-800 bg-zinc-900/60", footerClassName)}
          >
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
};

interface ModalProps {
  children?: React.ReactNode;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}

/** Modal centrado. Children = cuerpo (los formularios traen sus propios botones). */
export const Modal: React.FC<ModalProps> = ({
  onClose,
  title,
  description,
  footer,
  width = "max-w-md",
  children,
}) => {
  useDismiss(onClose);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm anim-fade-in" onClick={onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          "relative w-full rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl outline-none anim-scale-in",
          width
        )}
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <button onClick={onClose} aria-label="Cerrar" className={closeBtnClass}>
            <X className="w-5 h-5" />
          </button>
        </div>
        {description && <p className="text-xs text-zinc-400 px-6 mt-1 leading-relaxed">{description}</p>}
        <div className="p-6">{children}</div>
        {footer && (
          <div className="flex items-center justify-between gap-2 border-t border-zinc-800 px-5 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Piezas de contenido compartidas.                                    */
/* ------------------------------------------------------------------ */

const BADGE_TONES: Record<string, string> = {
  zinc: "bg-zinc-800 text-zinc-300 border-zinc-700",
  slate: "bg-slate-700 text-slate-200 border-slate-600",
  emerald: "bg-emerald-900/60 text-emerald-300 border-emerald-700",
  teal: "bg-teal-900/60 text-teal-300 border-teal-700",
  cyan: "bg-cyan-900/60 text-cyan-300 border-cyan-700",
  sky: "bg-sky-900/60 text-sky-300 border-sky-700",
  blue: "bg-blue-900/60 text-blue-300 border-blue-700",
  indigo: "bg-indigo-900/60 text-indigo-300 border-indigo-700",
  purple: "bg-purple-900/60 text-purple-300 border-purple-700",
  amber: "bg-amber-900/60 text-amber-300 border-amber-700",
  orange: "bg-orange-900/60 text-orange-300 border-orange-700",
  rose: "bg-rose-900/60 text-rose-300 border-rose-700",
};

export const Badge: React.FC<{
  tone?: keyof typeof BADGE_TONES;
  className?: string;
  children: React.ReactNode;
}> = ({ tone = "zinc", className, children }) => (
  <span
    className={cn(
      "shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border",
      BADGE_TONES[tone],
      className
    )}
  >
    {children}
  </span>
);

export const EmptyState: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint?: string;
}> = ({ icon: Icon, title, hint }) => (
  <div className="p-6 bg-zinc-900/50 border border-zinc-800 rounded-xl text-center text-sm text-zinc-400">
    <Icon className="w-8 h-8 text-zinc-600 mx-auto mb-2" />
    {title}
    {hint && <div className="text-xs text-zinc-500 mt-1">{hint}</div>}
  </div>
);

export const SectionHeading: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  count?: number;
  action?: React.ReactNode;
}> = ({ icon: Icon, title, count, action }) => (
  <div className="flex items-center justify-between gap-3">
    <h4 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
      <Icon className="w-4 h-4 text-zinc-400" /> {title}
      {typeof count === "number" && (
        <span className="text-xs font-normal text-zinc-500">({count})</span>
      )}
    </h4>
    {action}
  </div>
);

/** Contenedor de lista de sección: un borde, filas divididas. Envuelve las filas de una sección. */
export const SectionList: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className,
}) => <div className={cn("rounded-xl border border-zinc-800 divide-y divide-zinc-800/70 px-4", className)}>{children}</div>;

/** Definición compacta etiqueta/valor para carátulas. */
export const InfoGrid: React.FC<{
  items: Array<{ label: string; value: React.ReactNode; full?: boolean }>;
}> = ({ items }) => (
  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
    {items.map((it, i) => (
      <div key={i} className={cn("min-w-0", it.full && "sm:col-span-2")}>
        <dt className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          {it.label}
        </dt>
        <dd className="text-sm text-zinc-200 mt-0.5 truncate">
          {it.value ?? <span className="text-zinc-600">—</span>}
        </dd>
      </div>
    ))}
  </dl>
);

const contactActionClass =
  "p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 border border-transparent hover:border-zinc-700 transition";

/** Acciones de contacto: email y teléfono con mailto/tel y copiado con confirmación. */
export const ContactActions: React.FC<{ email?: string | null; phone?: string | null }> = ({
  email,
  phone,
}) => {
  const [copied, setCopied] = useState<"email" | "phone" | null>(null);

  const copy = async (what: "email" | "phone", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Portapapeles no disponible: quedan los enlaces mailto/tel.
    }
  };

  return (
    <span className="inline-flex items-center gap-0.5">
      {email && (
        <>
          <a href={`mailto:${email}`} title={`Escribir a ${email}`} className={contactActionClass}>
            <Mail className="w-3.5 h-3.5" />
          </a>
          <button
            type="button"
            onClick={() => copy("email", email)}
            title="Copiar email"
            className={contactActionClass}
          >
            {copied === "email" ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </>
      )}
      {phone && (
        <>
          <a
            href={`tel:${phone.replace(/[\s()-]/g, "")}`}
            title={`Llamar a ${phone}`}
            className={contactActionClass}
          >
            <Phone className="w-3.5 h-3.5" />
          </a>
          <button
            type="button"
            onClick={() => copy("phone", phone)}
            title="Copiar teléfono"
            className={contactActionClass}
          >
            {copied === "phone" ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </>
      )}
    </span>
  );
};

export const Skeleton: React.FC<{ className?: string }> = ({ className }) => (
  <div className={cn("animate-pulse rounded-md bg-zinc-800/80", className)} />
);
