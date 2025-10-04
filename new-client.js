// server/new-client.js
const fs = require("fs");
const path = require("path");

const slugRaw = process.argv[2] || "";
const origin  = process.argv[3] || ""; // e.g. https://www.acme.com

const slug = slugRaw.toLowerCase().replace(/[^a-z0-9\-]/g,"");
if(!slug || !origin){
  console.log("Usage: node new-client.js <slug> <https://client-domain>");
  process.exit(1);
}

// Default origins so your iframe can call the API
const defaultOrigins = [
  "https://nova-dynamics.no",
  "https://www.nova-dynamics.no",
  "https://prismatic-taffy-e96ac7.netlify.app"
];

const clientsDir = path.join(__dirname, "clients");
const base = path.join(clientsDir, slug);
fs.mkdirSync(base, { recursive: true });

// Create starter KB
const kbPath = path.join(base, "kb.json");
if (!fs.existsSync(kbPath)) {
  fs.writeFileSync(kbPath, JSON.stringify([
    {"q":"Opening hours","a":"We’re open Mon–Fri 09–17."},
    {"q":"Support email","a":"support@" + slug + ".com"}
  ], null, 2));
}

// Update registry
const regPath = path.join(clientsDir, "clients.json");
let reg = {};
try { reg = JSON.parse(fs.readFileSync(regPath, "utf8")); } catch {}
const origins = Array.from(new Set([origin, ...defaultOrigins]));
reg[slug] = { name: slug, origins };
fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));

console.log(`✅ Created client '${slug}'`);
console.log(` - KB: clients/${slug}/kb.json`);
console.log(` - Origins:`, origins);
