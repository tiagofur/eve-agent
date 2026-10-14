---
description: "Use when analyzing a client's business operations to identify high-ROI opportunities for workflow automation or AI agent integration."
---

# Automation & AI Assessment Framework

When auditing a company's workflow, evaluate these 4 dimensions:

1. Volume & Frequency:
   - Does this task happen multiple times a day or week?
   - How many team members are tied up running it?

2. Rule-Based vs. Probabilistic:
   - Rule-based (Deterministic): Direct API syncs, webhook triggers, web scraping, data transformations. Best solved with clean backend automation (Node.js/Python).
   - Probabilistic (AI-driven): Document parsing, unstructured email/WhatsApp triage, text summarization, context-aware reasoning. Best solved with an Eve AI agent.

3. System Connectivity:
   - What SaaS platforms or databases are involved (e.g., WhatsApp, HubSpot, Notion, Stripe, custom database)?
   - Are standard REST APIs or webhooks available?

4. Financial / Operational ROI:
   - Calculate saved hours: `(Hours spent/week) * (Hourly labor cost) * 52`.
   - Contrast against development cost using `generate_service_estimate`.
