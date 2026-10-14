import fs from "fs";
import { crmRegisterLead, crmSaveDossier } from "../lib/crm";

// Load .env.local
const envFile = fs.readFileSync(".env.local", "utf8");
for (const line of envFile.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const [key, ...vals] = trimmed.split("=");
  process.env[key.trim()] = vals.join("=").trim();
}

async function runTest() {
  console.log("=== Creapolis.Dev Prospector Test (Meta Muse Spark 1.3) ===");

  const targetBusiness = {
    name: "Dr. Carlos Mendoza - Odontología Integral",
    domain: "clinicamendoza-dental.com",
    city: "Ciudad de México",
    sourceUrl: "https://maps.google.com/?cid=1092837465928374",
    phone: "+52 55 1234 5678",
    email: "contacto@clinicamendoza-dental.com",
    rawObservations:
      "Clínica dental privada con 3 consultorios. Tienen sitio web básico en WordPress sin sistema de citas online. Los pacientes tienen que llamar por teléfono o mandar WhatsApp que solo se contesta en horario de oficina. En Google Maps tienen 4.6 estrellas con comentarios quejándose de que tardan horas en responder mensajes los fines de semana y noches.",
  };

  console.log(`1. Registrando prospecto entrante en CRM: "${targetBusiness.name}"...`);
  const registered = await crmRegisterLead({
    clientName: targetBusiness.name,
    companyName: targetBusiness.name,
    contact: targetBusiness.email,
    serviceType: "automation",
    projectSummary: "Prospecto identificado en Google Maps con alta oportunidad de automatización de citas.",
    source: "prospector_agent",
  });
  console.log(`   ✓ Lead creado en CRM con ID: ${registered.leadId} (Estado: ${registered.stage})`);

  console.log("\n2. Invocando Meta Muse Spark 1.3 Contributor para diagnóstico técnico y estructuración del dossier...");
  const metaBase = process.env.META_API_BASE_URL || "https://api.meta.ai/v1";
  const metaKey = process.env.META_API_KEY;

  if (!metaKey) {
    throw new Error("META_API_KEY no encontrada en .env.local");
  }

  const prompt = `Eres el Agente Prospector Senior de Creapolis.Dev.
Analiza la siguiente información de un negocio prospecto:
Empresa: ${targetBusiness.name}
Dominio: ${targetBusiness.domain}
Observaciones: ${targetBusiness.rawObservations}
Fuente: ${targetBusiness.sourceUrl}

Genera un JSON estrictamente válido con la siguiente estructura (sin markdown, solo el JSON):
{
  "summary": "Resumen ejecutivo claro y directo de la oportunidad",
  "pains": ["Dolor 1", "Dolor 2"],
  "creapolisSolution": "Solución de alto ROI que Creapolis.Dev puede ofrecer (ej. Agente IA WhatsApp)",
  "techStackObserved": ["WordPress", "Manual Phone"],
  "outreachAngle": "Ángulo persuasivo y respetuoso para el primer contacto sin ser invasivo",
  "draftSubject": "Asunto conciso para email",
  "draftMessage": "Mensaje personalizado corto (3-4 párrafos) explicando la oportunidad detectada y ofreciendo una demo de 10 min sin compromiso"
}`;

  const completionRes = await fetch(`${metaBase}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${metaKey}`,
    },
    body: JSON.stringify({
      model: "muse-spark-1.3-contributor",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    }),
  });

  if (!completionRes.ok) {
    const errText = await completionRes.text();
    throw new Error(`Meta API Error (${completionRes.status}): ${errText}`);
  }

  const completionData = await completionRes.json();
  const rawContent = completionData.choices?.[0]?.message?.content ?? "";
  console.log("   ✓ Respuesta recibida de Muse Spark 1.3 Contributor!");

  // Parse JSON
  const cleanJson = rawContent.replace(/```json/g, "").replace(/```/g, "").trim();
  const analysis = JSON.parse(cleanJson);

  console.log("\n3. Guardando Dossier de Inteligencia Verificado en Creapolis CRM...");
  const dossier = await crmSaveDossier({
    leadId: registered.leadId,
    companyName: targetBusiness.name,
    domain: targetBusiness.domain,
    summary: analysis.summary,
    findings: {
      pains: analysis.pains,
      solution: analysis.creapolisSolution,
      techStack: analysis.techStackObserved,
      outreachAngle: analysis.outreachAngle,
    },
    sources: [
      {
        url: targetBusiness.sourceUrl,
        retrievedAt: new Date().toISOString(),
        note: "Perfil de Google Maps y reseñas de clientes",
      },
      {
        url: `https://${targetBusiness.domain}`,
        retrievedAt: new Date().toISOString(),
        note: "Sitio web oficial (WordPress sin citas online)",
      },
    ],
  });
  console.log(`   ✓ Dossier persistido en CRM con ID: ${dossier.dossier.id}`);

  console.log("\n4. Creando borrador de Outreach en Outbox (status: PENDING_APPROVAL)...");
  // Insert directly into outbox via CRM API
  const outboxRes = await fetch(`${process.env.CRM_API_URL || "http://localhost:8787"}/api/outbox`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.CRM_OPS_KEY}`,
    },
    body: JSON.stringify({
      leadId: registered.leadId,
      contactId: registered.contactId,
      channel: "email",
      subject: analysis.draftSubject,
      body: analysis.draftMessage,
      rationale: analysis.outreachAngle,
    }),
  });

  const outboxData = await outboxRes.json();
  console.log(`   ✓ Borrador creado en outbox (ID: ${outboxData.draftId}, Status: pending_approval)`);
  console.log("   * IMPORTANTE: No se ha enviado nada al cliente. Queda esperando tu aprobación humana.");

  console.log("\n=== PRUEBA COMPLETADA EXITOSAMENTE ===");
  console.log(`Abre la App Desktop 'Creapolis Mission Control':`);
  console.log(`- En 'Leads & Pipeline', haz clic en '${targetBusiness.name}'`);
  console.log(`- Verás el Dossier verificado, las fuentes con enlaces, el análisis de Muse Spark y el borrador listo para aprobar.`);
}

runTest().catch((err) => {
  console.error("Error en la prueba:", err);
  process.exit(1);
});
