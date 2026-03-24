import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkDbConnection, createDbPool, queryRows, withDbClient, withDbTransaction } from "./db.js";

describe("createDbPool", () => {
  it("builds a pool from POLLER_DATABASE_URL", () => {
    const calls = [];

    class FakePool {
      constructor(config) {
        calls.push(config);
      }
    }

    const pool = createDbPool({
      connectionString: "postgresql://postgres:postgres@db:5432/red_alerts",
      PoolClass: FakePool,
      applicationName: "red-alerts-test",
      max: 7,
      idleTimeoutMillis: 1234,
    });

    assert.ok(pool instanceof FakePool);
    assert.deepEqual(calls, [{
      connectionString: "postgresql://postgres:postgres@db:5432/red_alerts",
      application_name: "red-alerts-test",
      max: 7,
      idleTimeoutMillis: 1234,
    }]);
  });

  it("throws when the connection string is missing", () => {
    assert.throws(
      () => createDbPool({ connectionString: "" }),
      /POLLER_DATABASE_URL is required/,
    );
  });
});

describe("withDbClient", () => {
  it("releases the client after running the callback", async () => {
    const calls = [];
    const client = {
      release() {
        calls.push("release");
      },
    };
    const pool = {
      async connect() {
        calls.push("connect");
        return client;
      },
    };

    const result = await withDbClient(pool, async (connectedClient) => {
      calls.push(connectedClient === client ? "callback" : "wrong-client");
      return "ok";
    });

    assert.equal(result, "ok");
    assert.deepEqual(calls, ["connect", "callback", "release"]);
  });
});

describe("queryRows", () => {
  it("runs a query and returns rows", async () => {
    const calls = [];
    const db = {
      async query(text, values) {
        calls.push({ text, values });
        return { rows: [{ id: 1 }] };
      },
    };

    const rows = await queryRows(db, "select * from test where id = $1", [1]);

    assert.deepEqual(rows, [{ id: 1 }]);
    assert.deepEqual(calls, [{
      text: "select * from test where id = $1",
      values: [1],
    }]);
  });
});

describe("withDbTransaction", () => {
  it("wraps the callback in BEGIN/COMMIT", async () => {
    const calls = [];
    const client = {
      async query(text) {
        calls.push(text);
        return { rows: [] };
      },
      release() {
        calls.push("release");
      },
    };
    const pool = {
      async connect() {
        calls.push("connect");
        return client;
      },
    };

    const result = await withDbTransaction(pool, async (connectedClient) => {
      calls.push(connectedClient === client ? "callback" : "wrong-client");
      return "done";
    });

    assert.equal(result, "done");
    assert.deepEqual(calls, ["connect", "BEGIN", "callback", "COMMIT", "release"]);
  });

  it("rolls back on error", async () => {
    const calls = [];
    const client = {
      async query(text) {
        calls.push(text);
        return { rows: [] };
      },
      release() {
        calls.push("release");
      },
    };
    const pool = {
      async connect() {
        calls.push("connect");
        return client;
      },
    };

    await assert.rejects(
      () => withDbTransaction(pool, async () => {
        calls.push("callback");
        throw new Error("boom");
      }),
      /boom/,
    );

    assert.deepEqual(calls, ["connect", "BEGIN", "callback", "ROLLBACK", "release"]);
  });
});

describe("checkDbConnection", () => {
  it("returns database metadata and latency", async () => {
    const db = {
      async query(text) {
        assert.match(text, /current_database/);
        return {
          rows: [{
            database_name: "red_alerts",
            server_time: new Date("2026-03-18T16:00:00.000Z"),
          }],
        };
      },
    };

    const result = await checkDbConnection(db, Date.parse("2026-03-18T16:01:00.000Z"));

    assert.equal(result.checkedAt, "2026-03-18T16:01:00.000Z");
    assert.equal(result.databaseName, "red_alerts");
    assert.equal(result.serverTime, "2026-03-18T16:00:00.000Z");
    assert.equal(typeof result.latencyMs, "number");
    assert.ok(result.latencyMs >= 0);
  });
});
