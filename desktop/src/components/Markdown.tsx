import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Render seguro de markdown del tema oscuro (reportes del agente: briefs,
 * planes, reportes de operación). react-markdown produce elementos React —
 * sin dangerouslySetInnerHTML — y remark-gfm habilita las tablas que los
 * reportes usan profusamente.
 */
export const Markdown: React.FC<{ children: string }> = ({ children }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      h1: ({ children }) => (
        <h1 className="text-lg font-bold text-white mt-5 mb-2 first:mt-0">{children}</h1>
      ),
      h2: ({ children }) => (
        <h2 className="text-base font-bold text-white mt-5 mb-2 border-b border-zinc-800 pb-1.5">{children}</h2>
      ),
      h3: ({ children }) => (
        <h3 className="text-sm font-semibold text-zinc-100 mt-4 mb-1.5">{children}</h3>
      ),
      h4: ({ children }) => (
        <h4 className="text-sm font-semibold text-zinc-300 mt-3 mb-1">{children}</h4>
      ),
      p: ({ children }) => <p className="text-sm text-zinc-300 leading-relaxed my-2">{children}</p>,
      strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
      a: ({ href, children }) => (
        <a href={href} target="_blank" rel="noreferrer" className="text-cyan-300 hover:underline break-all">
          {children}
        </a>
      ),
      ul: ({ children }) => <ul className="list-disc pl-5 my-2 space-y-1">{children}</ul>,
      ol: ({ children }) => <ol className="list-decimal pl-5 my-2 space-y-1">{children}</ol>,
      li: ({ children }) => <li className="text-sm text-zinc-300 leading-relaxed marker:text-zinc-500">{children}</li>,
      blockquote: ({ children }) => (
        <blockquote className="border-l-2 border-cyan-500/50 pl-3 my-3 text-zinc-400">{children}</blockquote>
      ),
      hr: () => <hr className="border-zinc-800 my-4" />,
      code: ({ className, children }) =>
        className ? (
          <code className={`${className} text-xs bg-zinc-900 border border-zinc-800 rounded px-1.5 py-0.5 text-amber-300 font-mono`}>
            {children}
          </code>
        ) : (
          <code className="text-xs bg-zinc-900 border border-zinc-800 rounded px-1.5 py-0.5 text-amber-300 font-mono">
            {children}
          </code>
        ),
      pre: ({ children }) => (
        <pre className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 my-3 overflow-x-auto text-xs text-zinc-300 font-mono leading-relaxed">
          {children}
        </pre>
      ),
      table: ({ children }) => (
        <div className="overflow-x-auto my-3 rounded-lg border border-zinc-800">
          <table className="w-full text-xs border-collapse">{children}</table>
        </div>
      ),
      thead: ({ children }) => <thead className="bg-zinc-900/80">{children}</thead>,
      th: ({ children }) => (
        <th className="text-left font-semibold text-zinc-200 px-3 py-2 border-b border-zinc-800 whitespace-nowrap">
          {children}
        </th>
      ),
      td: ({ children }) => (
        <td className="text-zinc-300 px-3 py-2 border-b border-zinc-800/60 align-top">{children}</td>
      ),
    }}
  >
    {children}
  </ReactMarkdown>
);
