import { createServer } from "node:http";
import QRCode from "qrcode";
import { parseJsonObject } from "./lib.js";

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return parseJsonObject(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startHttpServer({
  port = 3000,
  logger = console,
  locations,
  targetChatIds,
  testChatIds,
  eventTypes,
  resolveEventType,
  isDeliverableEventType,
  resolveTargetChatIds,
  enqueuePresetAlert,
  simulateAlerts,
  enqueueAlertNotifications,
  getEvolutionConnectInfo,
  evolutionInstance,
  summarizeDebugCaptureStores,
  debugCaptureStores,
  listDebugCaptureEntries,
  buildOpsStatusResponse,
  buildRecentReceivedMessage,
  buildRecentReceivedTownMessage,
  buildRecentFlowMessage,
  buildRecentSentMessage,
  setDeliveryEnabled,
  buildOpsDeliveryResponse,
  buildOpsSendPresetResponse,
  setTelegramManagementState,
  buildHealthResponse,
  buildHealthErrorResponse,
} = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/test" && req.method === "GET") {
      try {
        const eventType = eventTypes.ACTIVE_ALERT;
        const result = await enqueuePresetAlert({
          eventType,
          chatIds: testChatIds,
          source: "test_api",
          idPrefix: "test-alert",
        });
        writeJson(res, 200, { ok: true, eventType, ...result });
      } catch (err) {
        writeJson(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (url.pathname === "/test" && req.method === "POST") {
      try {
        const payload = await readJsonBody(req);
        const eventType =
          payload.eventType === undefined
            ? eventTypes.ACTIVE_ALERT
            : resolveEventType(payload.eventType);
        if (!isDeliverableEventType(eventType)) {
          throw new TypeError(`Unknown event type: ${payload.eventType}`);
        }
        const chatIds = resolveTargetChatIds(payload, testChatIds);
        const result = await enqueuePresetAlert({
          eventType,
          chatIds,
          source: "test_api",
          idPrefix: "test-alert",
          desc: String(payload.desc || "זוהי הודעת בדיקה בלבד"),
        });
        writeJson(res, 200, { ok: true, eventType, ...result });
      } catch (err) {
        const statusCode =
          err instanceof SyntaxError || err instanceof TypeError ? 400 : 500;
        writeJson(res, statusCode, { ok: false, error: err.message });
      }
      return;
    }

    if (url.pathname === "/simulate" && req.method === "POST") {
      try {
        const payload = await readJsonBody(req);
        const result = await simulateAlerts(payload, {
          locations,
          targetChatIds,
          testChatIds,
          deliverAlert: enqueueAlertNotifications,
        });
        writeJson(res, 200, { ok: true, ...result });
      } catch (err) {
        const statusCode =
          err instanceof SyntaxError || err instanceof TypeError ? 400 : 500;
        writeJson(res, statusCode, { ok: false, error: err.message });
      }
      return;
    }

    if (url.pathname === "/connect" && req.method === "GET") {
      try {
        const info = await getEvolutionConnectInfo();
        writeJson(res, 200, { ok: true, instance: evolutionInstance, ...info });
      } catch (err) {
        writeJson(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (url.pathname === "/qr" && req.method === "GET") {
      try {
        const info = await getEvolutionConnectInfo();
        if (!info?.code) {
          writeJson(res, 409, { ok: false, error: "No QR code available", info });
          return;
        }

        const png = await QRCode.toBuffer(info.code, {
          margin: 1,
          scale: 8,
          type: "png",
        });
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(png);
      } catch (err) {
        writeJson(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (url.pathname === "/debug/captures" && req.method === "GET") {
      try {
        const limit = parseInt(url.searchParams.get("limit") || "100", 10);
        const kind = url.searchParams.get("kind") || "";
        const source = url.searchParams.get("source") || "";
        writeJson(res, 200, {
          ok: true,
          ...summarizeDebugCaptureStores(debugCaptureStores),
          entries: listDebugCaptureEntries(debugCaptureStores, { limit, kind, source }),
        });
      } catch (err) {
        writeJson(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (url.pathname === "/ops/status" && req.method === "GET") {
      writeJson(res, 200, await buildOpsStatusResponse());
      return;
    }

    if (url.pathname === "/ops/recent_received" && req.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "5", 10);
      writeJson(res, 200, { ok: true, message: await buildRecentReceivedMessage(limit) });
      return;
    }

    if (url.pathname === "/ops/recent_received_town" && req.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "5", 10);
      writeJson(res, 200, { ok: true, message: buildRecentReceivedTownMessage(limit) });
      return;
    }

    if (url.pathname === "/ops/recent_flow" && req.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "3", 10);
      writeJson(res, 200, { ok: true, message: buildRecentFlowMessage(limit) });
      return;
    }

    if (url.pathname === "/ops/recent_sent" && req.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "5", 10);
      writeJson(res, 200, { ok: true, message: buildRecentSentMessage(limit) });
      return;
    }

    if (url.pathname === "/ops/delivery" && req.method === "POST") {
      try {
        const payload = await readJsonBody(req);
        if (typeof payload.enabled !== "boolean") {
          throw new TypeError("enabled must be a boolean");
        }
        const enabled = setDeliveryEnabled(
          payload.enabled,
          String(payload.updatedBy || "ops-api"),
        );
        writeJson(res, 200, buildOpsDeliveryResponse(enabled));
      } catch (err) {
        const statusCode =
          err instanceof SyntaxError || err instanceof TypeError ? 400 : 500;
        writeJson(res, statusCode, { ok: false, error: err.message });
      }
      return;
    }

    if (url.pathname === "/ops/telegram_management" && req.method === "POST") {
      try {
        const payload = await readJsonBody(req);
        writeJson(res, 200, {
          ok: true,
          monitoring: setTelegramManagementState(payload),
        });
      } catch (err) {
        const statusCode =
          err instanceof SyntaxError || err instanceof TypeError ? 400 : 500;
        writeJson(res, statusCode, { ok: false, error: err.message });
      }
      return;
    }

    if (url.pathname === "/ops/send_preset" && req.method === "POST") {
      try {
        const payload = await readJsonBody(req);
        const eventType = resolveEventType(payload.eventType);
        if (!isDeliverableEventType(eventType)) {
          throw new TypeError(`Unknown event type: ${payload.eventType}`);
        }

        const result = await enqueuePresetAlert({
          eventType,
          source: "ops_api",
          idPrefix: "ops-preset",
        });
        writeJson(res, 200, buildOpsSendPresetResponse(result));
      } catch (err) {
        const statusCode =
          err instanceof SyntaxError || err instanceof TypeError ? 400 : 409;
        writeJson(res, statusCode, { ok: false, error: err.message });
      }
      return;
    }

    if (url.pathname === "/health") {
      try {
        writeJson(res, 200, await buildHealthResponse());
      } catch (err) {
        writeJson(res, 500, buildHealthErrorResponse(err));
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found. Use GET /health, GET /debug/captures, GET /connect, GET /qr, GET /test, POST /test, or POST /simulate");
  });

  server.listen(port, () => {
    logger.info("http_server_ready", {
      port,
      endpoints: [
        "GET /health",
        "GET /debug/captures",
        "GET /connect",
        "GET /qr",
        "GET /test",
        "POST /test",
        "POST /simulate",
      ],
    });
  });

  return server;
}
