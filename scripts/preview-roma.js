"use strict";
// Local visual QA only. Reuse the shipped frontend with outbound analytics
// disabled so our testing cannot be confused with a prospect opening the demo.
const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("../index");
const preview = express();
preview.get("/demo/app.js", (_, res) => {
  const js = fs.readFileSync(path.join(__dirname, "../public/demo/app.js"), "utf8");
  res.type("js").send(js.replace("function captureAnalytics(event, properties = {}) {", "function captureAnalytics(event, properties = {}) { return; // LOCAL QA ONLY\n"));
});
preview.use(app);
preview.listen(3000, "0.0.0.0", () => console.log("Roma local QA preview: http://localhost:3000/demos/roma (analytics disabled)"));
