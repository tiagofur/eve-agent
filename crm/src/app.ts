import { Hono } from "hono";
import { cors } from "hono/cors";
import { leadsRouter } from "./api/routes/leads";
import { outboxRouter } from "./api/routes/outbox";
import { ticketsRouter } from "./api/routes/tickets";
import { reportsRouter } from "./api/routes/reports";
import { dossiersRouter } from "./api/routes/dossiers";
import { projectsRouter } from "./api/routes/projects";
import { chatRouter } from "./api/routes/chat";
import { marketingRouter } from "./api/routes/marketing";
import { organizationsRouter } from "./api/routes/organizations";
import { interactionsRouter } from "./api/routes/interactions";
import { contactsRouter } from "./api/routes/contacts";
import { estimatesRouter } from "./api/routes/estimates";
import { contractsRouter } from "./api/routes/contracts";
import { contentPacksRouter } from "./api/routes/content-packs";
import { productsRouter } from "./api/routes/products";
import { schedulesRouter } from "./api/routes/schedules";
import { metricsRouter } from "./api/routes/metrics";
import { publicChatRouter } from "./api/routes/public-chat";
import { publicContentRouter } from "./api/routes/public-content";
import { publicMetricsRouter } from "./api/routes/public-metrics";
import { inboundRouter } from "./api/routes/inbound";

export const app = new Hono();

app.onError((err, c) => {
  console.error("[app.onError]", err);
  return c.json({ error: err.message }, 500);
});

// Enable CORS for Desktop App (Tauri / WKWebView origin)
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// Health check endpoint (no auth needed)
app.get("/health", (c) => {
  return c.json({
    status: "healthy",
    service: "creapolis-crm-api",
    timestamp: new Date().toISOString(),
  });
});

// Mount modular routers
app.route("/api/leads", leadsRouter);
app.route("/api/outbox", outboxRouter);
app.route("/api/tickets", ticketsRouter);
app.route("/api/reports", reportsRouter);
app.route("/api/dossiers", dossiersRouter);
app.route("/api/projects", projectsRouter);
app.route("/api/chat", chatRouter);
app.route("/api/marketing", marketingRouter);
app.route("/api/organizations", organizationsRouter);
app.route("/api/interactions", interactionsRouter);
app.route("/api/contacts", contactsRouter);
app.route("/api/estimates", estimatesRouter);
app.route("/api/contracts", contractsRouter);
app.route("/api/content-packs", contentPacksRouter);
app.route("/api/products", productsRouter);
app.route("/api/schedules", schedulesRouter);
app.route("/api/metrics", metricsRouter);
app.route("/api/public/chat", publicChatRouter);
app.route("/api/public/content", publicContentRouter);
app.route("/api/public/metrics", publicMetricsRouter);
// Provider webhooks: authenticated by signature, not by API key.
app.route("/api/inbound", inboundRouter);

