"use strict";

// Local-only synthetic preview: never connect production storage or delivery.
process.env.NOVA_PREVIEW_ENABLED = "true";
process.env.NOVA_CAPTURE_ENABLED = "false";
process.env.NOVA_CAPTURE_WORKER_ENABLED = "false";
process.env.NOVA_CONVERSATION_CLIENTS = "";
process.env.NOVA_DATABASE_URL = "";
process.env.RESEND_API_KEY = "";
process.env.NOVA_CAPTURE_FROM = "";
process.env.NOVA_CAPTURE_CONFIG = "";
process.env.NOVA_PREVIEW_ORIGINS = "http://localhost:8788,http://127.0.0.1:8788";
process.env.OPENAI_API_KEY = "";

const { app } = require("../index");
app.listen(8788, "127.0.0.1", () => {
  console.log("Upgrade preview: http://localhost:8788/previews/tiller");
  console.log("Optician preview: http://localhost:8788/previews/frankolsen");
  console.log("Use invented contact details only. No enquiries are sent to a business.");
});
