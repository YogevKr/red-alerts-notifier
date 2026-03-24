export function createEvolutionClient({
  baseUrl,
  apiKey,
  timeoutMs,
  primaryInstance,
  fallbackInstance,
  buildEvolutionHeaders,
  getInstances,
  getConnectionState,
  chooseEvolutionInstance,
  monitor,
} = {}) {
  async function fetchEvolution(path, options = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        ...buildEvolutionHeaders(apiKey),
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function fetchEvolutionConnectionState(instanceName = primaryInstance) {
    const stateRes = await fetchEvolution(
      `/instance/connectionState/${instanceName}`,
    );
    if (!stateRes.ok) {
      throw new Error(
        `evolution connectionState ${instanceName} responded ${stateRes.status}: ${await stateRes.text()}`,
      );
    }

    return getConnectionState(await stateRes.json());
  }

  async function ensureEvolutionInstance(instanceName = primaryInstance, { createIfMissing = true } = {}) {
    const instancesRes = await fetchEvolution("/instance/fetchInstances");
    if (!instancesRes.ok) {
      throw new Error(
        `evolution fetchInstances responded ${instancesRes.status}: ${await instancesRes.text()}`,
      );
    }

    const instances = getInstances(await instancesRes.json());
    const exists = instances.some(
      (instance) =>
        instance?.name === instanceName ||
        instance?.instanceName === instanceName,
    );

    if (exists) return;
    if (!createIfMissing) return;

    const createRes = await fetchEvolution("/instance/create", {
      method: "POST",
      body: JSON.stringify({
        instanceName,
        integration: "WHATSAPP-BAILEYS",
        qrcode: true,
      }),
    });
    if (!createRes.ok) {
      throw new Error(
        `evolution create responded ${createRes.status}: ${await createRes.text()}`,
      );
    }
  }

  async function getEvolutionConnectInfo() {
    await ensureEvolutionInstance(primaryInstance);
    const res = await fetchEvolution(`/instance/connect/${primaryInstance}`);
    if (!res.ok) {
      throw new Error(
        `evolution connect responded ${res.status}: ${await res.text()}`,
      );
    }
    return res.json();
  }

  async function fetchEvolutionInstanceStatus(instanceName, { createIfMissing = false } = {}) {
    if (!instanceName) {
      return { instanceName: null, connectionState: null, error: null };
    }

    try {
      await ensureEvolutionInstance(instanceName, { createIfMissing });
      const connectionState = await fetchEvolutionConnectionState(instanceName);
      return { instanceName, connectionState, error: null };
    } catch (err) {
      return { instanceName, connectionState: null, error: err.message };
    }
  }

  async function resolveActiveEvolutionInstance() {
    const primary = await fetchEvolutionInstanceStatus(primaryInstance, { createIfMissing: true });
    const fallback = fallbackInstance
      ? await fetchEvolutionInstanceStatus(fallbackInstance, { createIfMissing: false })
      : { instanceName: null, connectionState: null, error: null };

    const choice = chooseEvolutionInstance({
      primaryInstance: primary.instanceName,
      primaryState: primary.connectionState,
      fallbackInstance: fallback.instanceName,
      fallbackState: fallback.connectionState,
    });

    if (monitor) {
      monitor.whatsappPrimaryInstance = primary.instanceName;
      monitor.whatsappPrimaryState = primary.connectionState;
      monitor.whatsappFallbackInstance = fallback.instanceName;
      monitor.whatsappFallbackState = fallback.connectionState;
      monitor.whatsappActiveInstance = choice.instanceName;
      monitor.whatsappConnectionState = choice.connectionState;
    }

    if (choice.instanceName && String(choice.connectionState).toLowerCase() === "open") {
      return {
        instanceName: choice.instanceName,
        connectionState: choice.connectionState,
        usedFallback: choice.usedFallback,
        primary,
        fallback,
      };
    }

    throw new Error(
      `evolution sender unavailable: primary=${primary.connectionState || primary.error || "missing"} fallback=${fallback.instanceName ? fallback.connectionState || fallback.error || "missing" : "disabled"}`,
    );
  }

  return {
    fetchEvolution,
    ensureEvolutionInstance,
    getEvolutionConnectInfo,
    resolveActiveEvolutionInstance,
  };
}
