import React, { useEffect, useState } from "react";
import {
  Sparkles,
  Instagram,
  Facebook,
  Linkedin,
  Twitter,
  CheckCircle2,
  Send,
  Loader2,
  Copy,
  Check,
  Image as ImageIcon,
  Plus,
  RefreshCw,
} from "lucide-react";
import { Modal } from "../components/ui";
import { crmApi, type SocialPostItem } from "../api";

export const MarketingView: React.FC = () => {
  const [posts, setPosts] = useState<SocialPostItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null);

  // Form states
  const [platform, setPlatform] = useState<"instagram" | "facebook" | "linkedin" | "twitter">("instagram");
  const [topic, setTopic] = useState("");
  const [tone, setTone] = useState("Moderno, técnico y orientado a ROI");

  const loadPosts = async () => {
    try {
      setLoading(true);
      const res = await crmApi.getSocialPosts();
      setPosts(res.posts);
    } catch (err) {
      console.error("Failed to load social posts:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPosts();
  }, []);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim() || generating) return;

    try {
      setGenerating(true);
      await crmApi.generateSocialPost({
        platform,
        topic,
        tone,
      });
      setShowGenerateModal(false);
      setTopic("");
      await loadPosts();
    } catch (err: any) {
      alert(`Error al generar post: ${err.message}`);
    } finally {
      setGenerating(false);
    }
  };

  const handleReview = async (id: string, decision: "approved" | "rejected") => {
    try {
      setActionLoading(id);
      await crmApi.reviewSocialPost(id, decision);
      await loadPosts();
    } catch (err: any) {
      alert(`Error en revisión: ${err.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handlePublish = async (id: string) => {
    try {
      setActionLoading(id);
      await crmApi.publishSocialPost(id);
      await loadPosts();
    } catch (err: any) {
      alert(`Error al publicar: ${err.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleCopyPrompt = (id: string, promptText: string) => {
    navigator.clipboard.writeText(promptText);
    setCopiedPromptId(id);
    setTimeout(() => setCopiedPromptId(null), 2000);
  };

  const getPlatformIcon = (plat: string) => {
    switch (plat) {
      case "instagram":
        return <Instagram className="w-4 h-4 text-pink-400" />;
      case "facebook":
        return <Facebook className="w-4 h-4 text-blue-400" />;
      case "linkedin":
        return <Linkedin className="w-4 h-4 text-sky-400" />;
      case "twitter":
        return <Twitter className="w-4 h-4 text-zinc-300" />;
      default:
        return <Sparkles className="w-4 h-4 text-emerald-400" />;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-xl font-bold tracking-tight text-white">
              Marketing Studio & Social Hub
            </h2>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-950/80 border border-emerald-800 text-emerald-400">
              Muse Spark 1.3
            </span>
          </div>
          <p className="text-xs text-zinc-400 mt-0.5">
            Generación autónoma de copies técnicos, prompts visuales y cola de publicación para Instagram / Facebook
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={loadPosts}
            disabled={loading}
            className="p-2 rounded-lg bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-400 hover:text-white transition"
            title="Refrescar"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            onClick={() => setShowGenerateModal(true)}
            className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-xs transition shadow-md shadow-emerald-500/20"
          >
            <Plus className="w-4 h-4" />
            <span>Generar Campaña IA</span>
          </button>
        </div>
      </div>

      {/* Posts Grid */}
      {loading ? (
        <div className="flex items-center justify-center p-16 text-zinc-500 text-xs">
          <Loader2 className="w-5 h-5 animate-spin mr-2 text-emerald-400" />
          <span>Cargando publicaciones del estudio...</span>
        </div>
      ) : posts.length === 0 ? (
        <div className="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-12 text-center max-w-lg mx-auto">
          <div className="w-12 h-12 rounded-xl bg-zinc-800 flex items-center justify-center mx-auto mb-3 text-zinc-400">
            <Sparkles className="w-6 h-6 text-emerald-400" />
          </div>
          <h3 className="text-sm font-bold text-white mb-1">No hay publicaciones activas</h3>
          <p className="text-xs text-zinc-400 mb-4">
            Genera tu primera campaña con el subagente de Marketing para Instagram, Facebook o LinkedIn.
          </p>
          <button
            onClick={() => setShowGenerateModal(true)}
            className="px-4 py-2 rounded-lg bg-emerald-500 text-black font-semibold text-xs hover:bg-emerald-400 transition"
          >
            Crear Nueva Publicación
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {posts.map((post) => (
            <div
              key={post.id}
              className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 flex flex-col justify-between hover:border-zinc-700 transition shadow-lg"
            >
              <div>
                {/* Post Top Meta */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="p-1.5 rounded-lg bg-zinc-800 border border-zinc-700/60">
                      {getPlatformIcon(post.platform)}
                    </span>
                    <span className="text-xs font-bold uppercase tracking-wider text-zinc-200">
                      {post.platform}
                    </span>
                  </div>

                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                      post.status === "pending_approval"
                        ? "bg-amber-950/70 border-amber-800 text-amber-400"
                        : post.status === "approved"
                        ? "bg-emerald-950/70 border-emerald-800 text-emerald-400"
                        : post.status === "published"
                        ? "bg-cyan-950/70 border-cyan-800 text-cyan-400"
                        : "bg-rose-950/70 border-rose-800 text-rose-400"
                    }`}
                  >
                    {post.status.replace("_", " ")}
                  </span>
                </div>

                <h4 className="text-sm font-bold text-white mb-2 leading-snug">
                  {post.topic}
                </h4>

                {/* Caption Box */}
                <div className="p-3 bg-zinc-950/80 rounded-lg border border-zinc-800/80 text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto mb-3">
                  {post.caption}
                </div>

                {/* Hashtags */}
                {post.hashtags && post.hashtags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-3">
                    {post.hashtags.map((tag, i) => (
                      <span
                        key={i}
                        className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800/80 text-zinc-400"
                      >
                        #{tag.replace(/^#/, "")}
                      </span>
                    ))}
                  </div>
                )}

                {/* Rendered Graphic from Muse Image */}
                {post.imageUrl && (
                  <div className="mb-3 rounded-lg overflow-hidden border border-zinc-800 bg-zinc-950 flex items-center justify-center max-h-64">
                    <img
                      src={post.imageUrl}
                      alt={post.topic}
                      className="w-full h-auto object-cover max-h-64 rounded-lg"
                    />
                  </div>
                )}

                {/* Image Prompt Concept (Muse Image) */}
                {post.imagePrompt && (
                  <div className="p-3 bg-emerald-950/20 border border-emerald-900/40 rounded-lg mb-4">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-400">
                        <ImageIcon className="w-3.5 h-3.5" />
                        <span>Prompt Visual Sugerido (Muse Image)</span>
                      </div>
                      <button
                        onClick={() => handleCopyPrompt(post.id, post.imagePrompt!)}
                        className="text-[10px] flex items-center gap-1 text-zinc-400 hover:text-white transition"
                        title="Copiar prompt"
                      >
                        {copiedPromptId === post.id ? (
                          <Check className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        <span>{copiedPromptId === post.id ? "Copiado" : "Copiar"}</span>
                      </button>
                    </div>
                    <p className="text-[11px] text-zinc-300 font-mono leading-relaxed italic">
                      "{post.imagePrompt}"
                    </p>
                  </div>
                )}
              </div>

              {/* Bottom Actions */}
              <div className="pt-3 border-t border-zinc-800/80 flex items-center justify-between text-xs">
                <span className="text-[10px] font-mono text-zinc-500">
                  {new Date(post.createdAt).toLocaleDateString()} • {post.createdBy}
                </span>

                <div className="flex items-center gap-2">
                  {post.status === "pending_approval" && (
                    <>
                      <button
                        onClick={() => handleReview(post.id, "rejected")}
                        disabled={actionLoading === post.id}
                        className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-rose-950/60 hover:text-rose-300 border border-zinc-700 text-zinc-300 font-medium text-xs transition"
                      >
                        Rechazar
                      </button>
                      <button
                        onClick={() => handleReview(post.id, "approved")}
                        disabled={actionLoading === post.id}
                        className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-xs transition flex items-center gap-1"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Aprobar</span>
                      </button>
                    </>
                  )}

                  {post.status === "approved" && (
                    <button
                      onClick={() => handlePublish(post.id)}
                      disabled={actionLoading === post.id}
                      className="px-3.5 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black font-semibold text-xs transition flex items-center gap-1.5 shadow-md shadow-cyan-500/20"
                    >
                      <Send className="w-3.5 h-3.5" />
                      <span>Publicar a Meta</span>
                    </button>
                  )}

                  {post.status === "published" && (
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold text-cyan-400 flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Publicado</span>
                      </span>
                      {post.externalPostUrl && (
                        <a
                          href={post.externalPostUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-cyan-300 text-[10px] font-medium transition inline-flex items-center gap-1"
                        >
                          <span>Ver en Meta</span>
                          <span>↗</span>
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Generation Modal */}
      {showGenerateModal && (
        <Modal onClose={() => setShowGenerateModal(false)} title={
          <span className="flex items-center gap-2 text-base">
            <Sparkles className="w-4 h-4 text-emerald-400" />
            Generar Campaña con Subagente de Marketing
          </span>
        } width="max-w-lg">
            <form onSubmit={handleGenerate} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Plataforma
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {(["instagram", "facebook", "linkedin", "twitter"] as const).map((p) => (
                    <button
                      type="button"
                      key={p}
                      onClick={() => setPlatform(p)}
                      className={`flex flex-col items-center gap-1.5 p-2.5 rounded-lg border text-xs font-semibold uppercase transition ${
                        platform === p
                          ? "bg-zinc-800 border-emerald-500 text-white"
                          : "bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                      }`}
                    >
                      {getPlatformIcon(p)}
                      <span className="text-[10px]">{p}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Tema o Caso de Éxito a Promover
                </label>
                <textarea
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="Ej: Caso de éxito Creapolis.Dev: Cómo un agente de WhatsApp automatizó el agendamiento y recuperó $3,000/mes para una clínica dental..."
                  rows={3}
                  required
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Tono de Comunicación
                </label>
                <select
                  value={tone}
                  onChange={(e) => setTone(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-emerald-500"
                >
                  <option value="Moderno, técnico y orientado a ROI">Moderno, técnico y orientado a ROI</option>
                  <option value="Educativo y pedagógico (Explicar arquitectura)">Educativo y pedagógico (Explicar arquitectura)</option>
                  <option value="Storytelling de fundador / Caso de estudio real">Storytelling de fundador / Caso de estudio real</option>
                  <option value="Directo al grano y oferta comercial">Directo al grano y oferta comercial</option>
                </select>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowGenerateModal(false)}
                  disabled={generating}
                  className="px-3.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={!topic.trim() || generating}
                  className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-bold transition flex items-center gap-1.5 disabled:opacity-50"
                >
                  {generating ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Generando con Muse...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>Generar y Notificar Telegram</span>
                    </>
                  )}
                </button>
              </div>
            </form>
        </Modal>
      )}
    </div>
  );
};
