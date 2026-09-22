"use strict";

// Real HTTP routing and the existing Tiller/Frank Olsen answer handlers, with
// only conversational context enabled. No API, database, analytics or mail calls.
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");

if (process.env.JEMLIO_CONTEXT_TEST_CHILD === "true") {
  global.fetch = async () => { throw new Error("External network is forbidden in this test"); };
  const { app, upgrades } = require("../index");
  if (process.env.JEMLIO_CONTEXT_TEST_FEATURE_FAILURE === "true") {
    upgrades.features = async () => { throw new Error("Synthetic optional-service failure"); };
  }
  const server = app.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
  process.on("message", message => {
    if (message === "close") server.close(() => upgrades.close().then(() => process.exit(0)));
  });
} else {
  const origin = "https://nova-dynamics-bot-server.onrender.com";
  let checks = 0, failures = 0;
  async function check(name, run) {
    try { await run(); console.log(`ok ${++checks} - ${name}`); }
    catch (error) { failures++; console.error(`not ok - ${name}\n${error.stack}`); }
  }
  async function withServer(extra, run) {
    const child = fork(__filename, [], { env: {
      ...process.env, JEMLIO_CONTEXT_TEST_CHILD: "true", OPENAI_API_KEY: "",
      NOVA_CONVERSATION_CLIENTS: "tiller,frankolsen", NOVA_PREVIEW_ENABLED: "false",
      NOVA_CAPTURE_ENABLED: "false", NOVA_CAPTURE_WORKER_ENABLED: "false",
      NOVA_CAPTURE_CONFIG: "", NOVA_DATABASE_URL: "", RESEND_API_KEY: "",
      NOVA_CAPTURE_SECRET: "", NOVA_CAPTURE_FROM: "", ...extra
    }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.stdout.resume(); child.stderr.resume();
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Test server did not start")), 10000);
      child.once("message", message => { clearTimeout(timer); resolve(message); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Test server exited ${code}`)); });
    });
    try {
      const { port } = await ready;
      const request = async (path, body, selectedOrigin = origin) => {
        const result = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: body ? "POST" : "GET", signal: AbortSignal.timeout(5000),
          headers: { Origin: selectedOrigin, ...(body ? { "Content-Type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {})
        });
        const data = (result.headers.get("content-type") || "").includes("application/json")
          ? await result.json() : await result.text();
        return { status: result.status, data };
      };
      const ask = async (client, message, conversationId, selectedOrigin = origin) => {
        const result = await request("/chat", { client, message, ...(conversationId ? { conversationId } : {}) }, selectedOrigin);
        assert.equal(result.status, 200, `${client}: ${message}`);
        assert.equal(typeof result.data.reply, "string");
        assert.notEqual(result.data.captureIntent, true, "capture is disabled throughout this test");
        return result.data;
      };
      await run({ request, ask });
    } finally {
      if (child.connected) child.send("close");
      const timer = setTimeout(() => child.kill("SIGTERM"), 2000);
      await new Promise(resolve => child.exitCode !== null ? resolve() : child.once("exit", resolve));
      clearTimeout(timer);
    }
  }
  const unclear = reply => {
    assert.equal(reply.contextApplied, false);
    assert.equal(reply.unsure, true);
    assert.match(reply.reply, /Hvilken tjeneste|Hva vil du vite/);
    assert.doesNotMatch(reply.reply, /800 kr|2 900 kr|gratis/i);
    assert.deepEqual(reply.followUps, []);
  };

  (async () => {
    await withServer({}, async ({ request, ask }) => {
      await check("only Tiller and Frank Olsen expose conversation; every existing demo keeps capture off", async () => {
        for (const client of ["fram", "fyllingsdalen", "onsoy", "tiller", "trafikk1", "frankolsen", "roma", "jemlio"]) {
          const config = await request(`/api/demo-config/${client}`);
          assert.equal(config.status, 200);
          assert.equal(config.data.features.conversation, ["tiller", "frankolsen"].includes(client), client);
          assert.equal(config.data.features.capture.enabled, false, client);
          assert.doesNotMatch(JSON.stringify(config.data.features), /recipient|secret|database|apiKey/i);
          if (client !== "jemlio") assert.equal((await request(`/demos/${client}`)).status, 200);
        }
        assert.equal((await request("/previews/tiller")).status, 404);
        assert.equal((await request("/api/capture/session", { client: "tiller" })).status, 503);
        assert.equal((await request("/api/capture/session", { client: "frankolsen" })).status, 503);
      });

      await check("Tiller followups retain the known lesson and refuse unsupported manual training", async () => {
        const first = await ask("tiller", "Hva koster en kjøretime?");
        assert.match(first.reply, /800 kr/);
        const automatic = await ask("tiller", "automat", first.conversationId);
        assert.match(automatic.reply, /800 kr/);
        assert.equal(automatic.contextApplied, true);
        assert.equal(automatic.conversationId, first.conversationId);
        const manual = await ask("tiller", "Hva med manuell?", first.conversationId);
        assert.match(manual.reply, /ikke oppført/i);
        assert.doesNotMatch(manual.reply, /800 kr/);
        const basic = await ask("tiller", "Hva koster trafikalt grunnkurs?", first.conversationId);
        const basicPrice = await ask("tiller", "Hva koster det?", basic.conversationId);
        assert.equal(basicPrice.contextApplied, true);
        assert.match(basicPrice.reply, /2 900 kr/);
      });

      await check("Frank Olsen follows the selected service and never assigns the free exam price to lenses", async () => {
        const first = await ask("frankolsen", "Hva inngår i synsundersøkelsen?");
        assert.match(first.reply, /fundusbilde|trykkmåling/i);
        const price = await ask("frankolsen", "Hva koster det?", first.conversationId);
        assert.equal(price.contextApplied, true);
        assert.match(price.reply, /gratis/i);
        const lenses = await ask("frankolsen", "Kontaktlinser", first.conversationId);
        assert.equal(lenses.contextApplied, true);
        assert.match(lenses.reply, /ikke spesifisert|ingen generell pris/i);
        assert.doesNotMatch(lenses.reply, /gratis/i);
      });

      await check("bounded class/service clarifications still resolve after an uncertain answer", async () => {
        const first = await ask("tiller", "B");
        assert.equal(first.unsure, true);
        assert.match(first.reply, /Hva vil du vite om klasse B/);
        const service = await ask("tiller", "kjøretime", first.conversationId);
        assert.equal(service.contextApplied, true);
        const price = await ask("tiller", "Hva koster det?", first.conversationId);
        assert.equal(price.contextApplied, true);
        assert.match(price.reply, /800 kr/);
      });

      await check("a context ID cannot move between Tiller and Frank Olsen or between allowed origins", async () => {
        const driving = await ask("tiller", "Hva koster en kjøretime?");
        const eye = await ask("frankolsen", "Hva koster en synsundersøkelse?");
        for (const [client, id] of [["frankolsen", driving.conversationId], ["tiller", eye.conversationId]]) {
          const crossed = await ask(client, "Hva koster det?", id);
          unclear(crossed);
          assert.equal(crossed.contextExpired, true);
          assert.notEqual(crossed.conversationId, id);
        }
        const moved = await ask("tiller", "Hva koster det?", driving.conversationId, "https://tillertrafikkskole.no");
        unclear(moved);
        assert.notEqual(moved.conversationId, driving.conversationId);
        const rejected = await request("/chat", { client: "tiller", message: "Hva koster det?", conversationId: driving.conversationId }, "https://unapproved.example");
        assert.equal(rejected.status, 403);
        assert.equal(rejected.data.conversationId, undefined);
      });

      await check("omitting the ID after UI reset creates a new context; an explicit reset clears remembered service", async () => {
        for (const [client, seed] of [["tiller", "Hva koster en kjøretime?"], ["frankolsen", "Hva koster en synsundersøkelse?"]]) {
          const first = await ask(client, seed);
          const fresh = await ask(client, "Hva koster det?");
          unclear(fresh);
          assert.notEqual(fresh.conversationId, first.conversationId);
          await ask(client, "Start på nytt", first.conversationId);
          unclear(await ask(client, "Hva koster det?", first.conversationId));
        }
      });

      const qualified = [
        ["tiller", "Hvordan avbestiller jeg en kjøretime?"],
        ["tiller", "Hva koster en kjøretime etter kl 16?"],
        ["tiller", "Jeg har epilepsi og vil ta kjøretime"],
        ["tiller", "Jeg heter Kari og vil ta kjøretime"],
        ["frankolsen", "Hvordan avbestiller jeg synsundersøkelsen?"],
        ["frankolsen", "Jeg fikk plutselig synstap og trenger synsundersøkelse"],
        ["frankolsen", "Jeg har sterke øyesmerter og vil bestille synsundersøkelse"],
        ["frankolsen", "Hvilken brillestyrke trenger jeg til nye briller?"],
        ["frankolsen", "Jeg har tørre øyne og vil ha synsundersøkelse"],
        ["frankolsen", "Jeg har diabetes og vil vite mer om synsundersøkelse"]
      ];
      for (const [client, question] of qualified) {
        await check(`${client}: qualification is preserved and cannot turn into a later ordinary price: ${question}`, async () => {
          const first = await ask(client, client === "tiller" ? "Hva koster en kjøretime?" : "Hva koster en synsundersøkelse?");
          const baseline = await ask(client, question);
          const qualifiedReply = await ask(client, question, first.conversationId);
          assert.equal(qualifiedReply.contextApplied, false);
          assert.equal(qualifiedReply.reply, baseline.reply, "the original medical/cancellation answer must stay unchanged");
          assert.deepEqual(qualifiedReply.followUps, []);
          unclear(await ask(client, "Hva koster det?", first.conversationId));
        });
      }

      const unsupportedEyeQuestions = [
        "Jeg har skade i øyet og trenger synsundersøkelse",
        "Jeg har kjemikalie i øyet og trenger synstest",
        "Jeg mistenker grønn stær og vil ha synstest",
        "Tilbyr dere synsundersøkelse for barn?",
        // No medical/eligibility guard matches this: the handler's uncertainty
        // must itself prevent collapsing an unverified duration into a price.
        "Hvor lang tid tar en synsundersøkelse?"
      ];
      // A separate process keeps this new scenario group below the real abuse
      // limit without weakening or disabling the application's rate limiter.
      await withServer({}, async ({ ask }) => {
        for (const question of unsupportedEyeQuestions) {
          await check(`an uncertain qualified eye-care answer cannot seed price or booking: ${question}`, async () => {
            for (const followup of ["Hva koster det?", "Hvordan bestiller jeg det?"]) {
              const seeded = await ask("frankolsen", "Hva inngår i synsundersøkelsen?");
              const baseline = await ask("frankolsen", question);
              const response = await ask("frankolsen", question, seeded.conversationId);
              assert.equal(response.reply, baseline.reply, "preserve the original safety/unsupported answer");
              assert.equal(response.unsure, true);
              unclear(await ask("frankolsen", followup, response.conversationId));
              const fresh = await ask("frankolsen", "Hva inngår i synsundersøkelsen?", response.conversationId);
              assert.match((await ask("frankolsen", "Hva koster det?", fresh.conversationId)).reply, /gratis/i,
                "an explicit new routine topic may establish fresh context");
            }
          });
        }
      });

      await check("a general dry-eye service question stays an informational question", async () => {
        const question = "Tilbyr dere behandling for tørre øyne?";
        const baseline = await ask("frankolsen", question);
        const seeded = await ask("frankolsen", "Hva koster en synsundersøkelse?");
        const reply = await ask("frankolsen", question, seeded.conversationId);
        assert.equal(reply.contextApplied, false);
        assert.equal(reply.reply, baseline.reply);
        assert.doesNotMatch(reply.reply, /Hvilken tjeneste eller førerkortklasse mener du/);
      });

      await check("callback requests do not claim a contact request was saved when collection is off", async () => {
        for (const client of ["tiller", "frankolsen"]) {
          const reply = await ask(client, "Kan dere ringe meg tilbake?");
          assert.match(reply.reply, /kan ikke lagre|kan ikke.*videresende/i);
          assert.doesNotMatch(reply.reply, /forespørselen er registrert|kontaktskjemaet nedenfor/i);
        }
      });
    });

    await withServer({}, async ({ ask }) => {
      for (const [name, price, otherPrice] of [["Standardpakken", /18 900 kr/, /24 900 kr/], ["Superpakken", /24 900 kr/, /18 900 kr/]]) {
        await check(`Tiller retains ${name} through price, contents and the existing contact link`, async () => {
          const first = await ask("tiller", `Hva inkluderer ${name}?`);
          for (const message of ["Hva koster den?", "Hva er inkludert?", "Hva inneholder den?"]) {
            const next = await ask("tiller", message, first.conversationId);
            assert.equal(next.contextApplied, true);
            assert.match(next.reply, price);
            assert.doesNotMatch(next.reply, otherPrice);
          }
          const booking = await ask("tiller", "Hvordan bestiller jeg den?", first.conversationId);
          assert.match(booking.reply, /tillertrafikkskole\.no\/contact/);
          assert.doesNotMatch(booking.reply, /bestillingen er bekreftet|du er påmeldt/i);
        });
      }

      await check("Tiller switches named packages but clarifies after a comparison", async () => {
        const first = await ask("tiller", "Hva koster Standardpakken?");
        const switched = await ask("tiller", "Hva med Superpakken?", first.conversationId);
        assert.equal(switched.contextApplied, true);
        assert.match(switched.reply, /24 900 kr/);
        assert.doesNotMatch(switched.reply, /18 900 kr/);
        await ask("tiller", "Sammenlign Standardpakken og Superpakken", first.conversationId);
        unclear(await ask("tiller", "Hva koster den?", first.conversationId));
      });

      for (const [service, duration] of [["trafikalt grunnkurs", /17 undervisningstimer/], ["trinnvurdering 2", /45 minutter/], ["trinnvurdering 3", /60 minutter/]]) {
        await check(`Tiller resolves the duration follow-up for ${service}`, async () => {
          const first = await ask("tiller", `Hva koster ${service}?`);
          const next = await ask("tiller", "Og hvor lenge varer det?", first.conversationId);
          assert.equal(next.contextApplied, true);
          assert.match(next.reply, duration);
          assert.equal(next.unsure, false);
        });
      }

      await check("changing the assessment stage keeps the price question", async () => {
        const first = await ask("tiller", "Hva koster trinnvurdering 2?");
        const next = await ask("tiller", "Hva med trinnvurdering 3?", first.conversationId);
        assert.match(next.reply, /1 000 kr/);
        assert.doesNotMatch(next.reply, /850 kr/);
        assert.equal(next.contextApplied, true);
      });

      await check("a comparison of both assessment stages does not select only one", async () => {
        for (const message of ["Hva koster trinnvurdering 2 og 3?", "Hva koster trinnvurdering tre eller to?"]) {
          const first = await ask("tiller", message);
          assert.match(first.reply, /850 kr/);
          assert.match(first.reply, /1 000 kr/);
          unclear(await ask("tiller", "Hva koster den?", first.conversationId));
        }
      });

      for (const message of ["Hva koster en kjøretime på 60 minutter?", "Hva koster en 90-minutters kjøretime?", "Hva koster en dobbeltime?"]) {
        await check(`Tiller does not assign the ordinary lesson price to: ${message}`, async () => {
          const first = await ask("tiller", message);
          assert.equal(first.unsure, true);
          assert.doesNotMatch(first.reply, /800 kr/);
          unclear(await ask("tiller", "Hva koster det?", first.conversationId));
        });
      }

      await check("Tiller does not convert an unknown package duration into a later price", async () => {
        const first = await ask("tiller", "Hva koster Superpakken?");
        const duration = await ask("tiller", "Hvor lenge varer den?", first.conversationId);
        assert.equal(duration.unsure, true);
        assert.doesNotMatch(duration.reply, /24 900 kr/);
        unclear(await ask("tiller", "Hva koster det?", first.conversationId));
      });

      await check("requesting a lesson with be om differs from requesting licence BE", async () => {
        const request = await ask("tiller", "Kan jeg be om en kjøretime?");
        assert.match(request.reply, /tillertrafikkskole\.no\/contact/);
        assert.doesNotMatch(request.reply, /BE|B96/);
        const price = await ask("tiller", "Kan jeg be om prisen på en kjøretime?");
        assert.match(price.reply, /800 kr/);
        for (const licence of ["BE", "B 96", "B kode 96"]) {
          const trailer = await ask("tiller", `Kan jeg be om en kjøretime for klasse ${licence}?`);
          assert.match(trailer.reply, /BE og B96 er ikke oppført/);
          assert.doesNotMatch(trailer.reply, /800 kr/);
        }
      });

      await check("Frank Olsen keeps repairs separate from a routine eye examination", async () => {
        const first = await ask("frankolsen", "Reparerer dere briller?");
        const next = await ask("frankolsen", "Hva koster det?", first.conversationId);
        assert.equal(next.contextApplied, true);
        assert.equal(next.unsure, true);
        assert.match(next.reply, /Pris på reparasjoner/);
        assert.doesNotMatch(next.reply, /gratis|førerkortklasse/);
      });

      for (const message of ["Hva koster synsundersøkelse for førerkortattest?", "Hvordan bestiller jeg en synsattest?", "Tilbyr dere synstest for førerkort?"]) {
        await check(`Frank Olsen does not imply a verified special exam: ${message}`, async () => {
          const seed = await ask("frankolsen", "Hva inngår i synsundersøkelsen?");
          const special = await ask("frankolsen", message, seed.conversationId);
          assert.equal(special.unsure, true);
          assert.match(special.reply, /ikke bekreftet/);
          assert.doesNotMatch(special.reply, /gratis|Velg «Bestill»/);
          unclear(await ask("frankolsen", "Hva koster det?", seed.conversationId));
        });
      }

      await check("an eye-exam duration follow-up remains unknown and clears the price context", async () => {
        const first = await ask("frankolsen", "Hva inngår i synsundersøkelsen?");
        const duration = await ask("frankolsen", "Hvor lenge varer den?", first.conversationId);
        assert.equal(duration.unsure, true);
        assert.match(duration.reply, /Varighet.*ikke publisert/);
        unclear(await ask("frankolsen", "Hva koster det?", first.conversationId));
      });
    });

    await withServer({}, async ({ ask }) => {
      await check("every offered follow-up is a complete, answerable question for the selected service", async () => {
        const cases = [
          ["tiller", "Fortell om Standardpakken"], ["tiller", "Fortell om Superpakken"],
          ["tiller", "Fortell om trafikalt grunnkurs"], ["tiller", "Hva koster en kjøretime for klasse B automat?"],
          ["tiller", "Hva koster trinnvurdering 2?"], ["tiller", "Hva koster trinnvurdering 3?"],
          ["tiller", "Hva koster mørkekjøring?"], ["tiller", "Hva koster førstehjelpskurs?"],
          ["tiller", "Hva koster sikkerhetskurs på veg?"], ["tiller", "Hva koster sikkerhetskurs på bane?"],
          ["frankolsen", "Fortell om synsundersøkelse"], ["frankolsen", "Tilbyr dere kontaktlinser?"],
          ["frankolsen", "Reparerer dere briller?"], ["frankolsen", "Hvilke briller har dere?"]
        ];
        for (const [client, question] of cases) {
          const first = await ask(client, question);
          assert.equal(first.unsure, false, question);
          assert.ok(first.followUps.length >= 1 && first.followUps.length <= 3, question);
          assert.equal(new Set(first.followUps.map(x => x.id)).size, first.followUps.length);
          for (const choice of first.followUps) {
            assert.ok(["price", "contents", "booking", "contact"].includes(choice.id));
            const clicked = await ask(client, choice.message); // also works after session expiry/reset
            assert.equal(clicked.unsure, false, `${client}: ${choice.message}`);
            assert.doesNotMatch(clicked.reply, /bestillingen er bekreftet|du er påmeldt/i);
            if (["booking", "contact"].includes(choice.id)) {
              assert.match(clicked.reply, client === "tiller" ? /tillertrafikkskole\.no\/contact/ : /frankolsen\.no\/kontakt/);
            }
          }
        }
      });
      await check("privacy questions, ambiguous services and unsupported prices offer no follow-up buttons", async () => {
        for (const [client, message] of [
          ["tiller", "Sammenlign Standardpakken og Superpakken"],
          ["tiller", "Hva koster en kjøretime for manuell?"],
          ["tiller", "Lagrer dere chat om kjøretime?"],
          ["frankolsen", "Hva koster kontaktlinser?"],
          ["frankolsen", "Jeg har sterke øyesmerter og vil bestille synsundersøkelse"],
          ["frankolsen", "Lagrer dere chat om synsundersøkelse?"]
        ]) assert.deepEqual((await ask(client, message)).followUps, [], message);
        assert.equal((await ask("fram", "Hva koster en kjøretime?")).followUps, undefined);
      });
    });

    await withServer({ JEMLIO_CONTEXT_TEST_FEATURE_FAILURE: "true" }, async ({ request, ask }) => {
      await check("failure of optional feature lookup preserves answers without promising unavailable forms", async () => {
        for (const client of ["tiller", "frankolsen"]) {
          const config = await request(`/api/demo-config/${client}`);
          assert.equal(config.status, 200);
          assert.equal(config.data.features.capture.enabled, false);
          const reply = await ask(client, "Kan dere ringe meg tilbake?");
          assert.match(reply.reply, /kan ikke lagre|kan ikke.*videresende/i);
          assert.doesNotMatch(reply.reply, /kontaktskjemaet nedenfor/i);
        }
      });
    });
    console.log(`Live-context HTTP checks: ${checks} passed, ${failures} failed. External network and collection disabled.`);
    if (failures) process.exitCode = 1;
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
