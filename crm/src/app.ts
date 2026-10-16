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

export const app = new Hono();

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

