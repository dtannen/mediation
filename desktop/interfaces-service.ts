import { randomBytes } from 'node:crypto';

interface AuthService {
  getGatewayUrl: () => string;
  getAuthHeaders: (input?: { forceRefresh?: boolean }) => Promise<Record<string, string>>;
}

interface GatewayClient {
  createIntegrationRoute?: (
    gatewayUrl: string,
    deviceToken: string,
    payload: Record<string, unknown>,
  ) => Promise<{ ok: boolean; status: number; data?: Record<string, unknown>; error?: string }>;
  updateIntegrationRoute?: (
    gatewayUrl: string,
    routeId: string,
    deviceToken: string,
    payload: Record<string, unknown>,
  ) => Promise<{ ok: boolean; status: number; data?: Record<string, unknown>; error?: string }>;
  deleteIntegrationRoute?: (
    gatewayUrl: string,
    routeId: string,
    deviceToken: string,
  ) => Promise<{ ok: boolean; status: number; data?: Record<string, unknown>; error?: string }>;
  rotateIntegrationRouteToken?: (
    gatewayUrl: string,
    routeId: string,
    deviceToken: string,
    graceSeconds?: number,
  ) => Promise<{ ok: boolean; status: number; data?: Record<string, unknown>; error?: string }>;
}

interface InterfaceRecord {
  id: string;
  profileId: string;
  provider: 'slack';
  status: 'active' | 'inactive';
  routeId?: string;
  publicUrl?: string;
  routeToken?: string;
  createdAt: string;
  updatedAt: string;
  config: {
    teamId?: string;
    channelId?: string;
    deadlineMs?: number;
    maxBodyBytes?: number;
    tokenMaxAgeDays?: number;
  };
}

interface InterfacesServiceDeps {
  auth: AuthService;
  gatewayClient: GatewayClient;
  emitAgentLog?: (source: string, message: string, profileId?: string | null) => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeRouteFromCreateResponse(response: Record<string, unknown> | undefined): {
  routeId: string;
  publicUrl: string;
  route: Record<string, unknown> | null;
  routeToken: string;
} {
  if (!response || typeof response !== 'object') {
    return { routeId: '', publicUrl: '', route: null, routeToken: '' };
  }

  const route = response.route && typeof response.route === 'object'
    ? response.route as Record<string, unknown>
    : response;

  const routeId = typeof route.route_id === 'string'
    ? route.route_id
    : (typeof route.routeId === 'string' ? route.routeId : '');

  const publicUrl = typeof response.public_url === 'string'
    ? response.public_url
    : (typeof response.publicUrl === 'string' ? response.publicUrl : '');

  const routeToken = typeof response.route_token === 'string'
    ? response.route_token
    : '';

  return {
    routeId,
    publicUrl,
    route,
    routeToken,
  };
}

export default function createInterfacesService(deps: InterfacesServiceDeps) {
  const interfacesById = new Map<string, InterfaceRecord>();

  function log(message: string, profileId: string | null = null): void {
    deps.emitAgentLog?.('system', `[interfaces] ${message}`, profileId);
  }

  async function getBearerToken(): Promise<string> {
    const headers = await deps.auth.getAuthHeaders();
    const auth = headers.Authorization || headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new Error('Missing bearer token');
    }
    return auth.slice('Bearer '.length);
  }

  async function listInterfaces(profileId = ''): Promise<Record<string, unknown>> {
    const items = [...interfacesById.values()]
      .filter((item) => !profileId || item.profileId === profileId)
      .map((item) => ({ ...item }));

    return { ok: true, interfaces: items };
  }

  async function createSlackInterface(payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const profileId = typeof payload.profileId === 'string' ? payload.profileId.trim() : '';
    const interfaceId = typeof payload.interfaceId === 'string' && payload.interfaceId.trim()
      ? payload.interfaceId.trim()
      : `if_${randomBytes(6).toString('hex')}`;

    const gatewayUrl = deps.auth.getGatewayUrl();
    const bearerToken = await getBearerToken();

    const routePayload: Record<string, unknown> = {
      interface_type: 'slack',
      token_auth_mode: 'path',
      interface_id: interfaceId,
      device_id: typeof payload.deviceId === 'string' ? payload.deviceId : '',
      deadline_ms: typeof payload.deadlineMs === 'number' ? payload.deadlineMs : 2500,
      max_body_bytes: typeof payload.maxBodyBytes === 'number' ? payload.maxBodyBytes : 10 * 1024 * 1024,
      token_max_age_days: typeof payload.tokenMaxAgeDays === 'number' ? payload.tokenMaxAgeDays : 90,
    };

    if (typeof payload.routeToken === 'string' && payload.routeToken.trim()) {
      routePayload.route_token = payload.routeToken.trim();
    }

    let routeResult: { ok: boolean; status: number; data?: Record<string, unknown>; error?: string } = {
      ok: true,
      status: 201,
      data: {},
    };

    if (deps.gatewayClient.createIntegrationRoute) {
      routeResult = await deps.gatewayClient.createIntegrationRoute(gatewayUrl, bearerToken, routePayload);
      if (!routeResult.ok) {
        return {
          ok: false,
          error: routeResult.error || `gateway error ${routeResult.status}`,
          retryable: routeResult.status >= 500,
        };
      }
    }

    const route = normalizeRouteFromCreateResponse(routeResult.data);

    const record: InterfaceRecord = {
      id: interfaceId,
      profileId,
      provider: 'slack',
      status: 'active',
      routeId: route.routeId || undefined,
      publicUrl: route.publicUrl || undefined,
      routeToken: route.routeToken || undefined,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      config: {
        teamId: typeof payload.teamId === 'string' ? payload.teamId : undefined,
        channelId: typeof payload.channelId === 'string' ? payload.channelId : undefined,
        deadlineMs: typeof routePayload.deadline_ms === 'number' ? routePayload.deadline_ms : undefined,
        maxBodyBytes: typeof routePayload.max_body_bytes === 'number' ? routePayload.max_body_bytes : undefined,
        tokenMaxAgeDays: typeof routePayload.token_max_age_days === 'number' ? routePayload.token_max_age_days : undefined,
      },
    };

    interfacesById.set(interfaceId, record);
    log(`created slack interface ${interfaceId}`, profileId || null);

    return {
      ok: true,
      interface: record,
      route: route.route,
      publicUrl: record.publicUrl,
      routeToken: record.routeToken,
    };
  }

  async function updateInterface(payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const interfaceId = typeof payload.interfaceId === 'string' ? payload.interfaceId.trim() : '';
    const record = interfacesById.get(interfaceId);
    if (!record) {
      return { ok: false, error: `interface '${interfaceId}' not found` };
    }

    const updateBody: Record<string, unknown> = {};
    if (typeof payload.deadlineMs === 'number') {
      updateBody.deadline_ms = payload.deadlineMs;
    }
    if (typeof payload.maxBodyBytes === 'number') {
      updateBody.max_body_bytes = payload.maxBodyBytes;
    }
    if (typeof payload.status === 'string') {
      updateBody.status = payload.status;
    }
    if (typeof payload.deviceId === 'string') {
      updateBody.device_id = payload.deviceId;
    }

    if (record.routeId && deps.gatewayClient.updateIntegrationRoute) {
      const gatewayUrl = deps.auth.getGatewayUrl();
      const bearerToken = await getBearerToken();
      const result = await deps.gatewayClient.updateIntegrationRoute(gatewayUrl, record.routeId, bearerToken, updateBody);
      if (!result.ok) {
        return {
          ok: false,
          error: result.error || `gateway error ${result.status}`,
          retryable: result.status >= 500,
        };
      }
    }

    record.updatedAt = nowIso();
    if (typeof payload.teamId === 'string') {
      record.config.teamId = payload.teamId;
    }
    if (typeof payload.channelId === 'string') {
      record.config.channelId = payload.channelId;
    }
    if (typeof payload.deadlineMs === 'number') {
      record.config.deadlineMs = payload.deadlineMs;
    }
    if (typeof payload.maxBodyBytes === 'number') {
      record.config.maxBodyBytes = payload.maxBodyBytes;
    }
    if (payload.status === 'active' || payload.status === 'inactive') {
      record.status = payload.status;
    }

    return { ok: true, interface: { ...record } };
  }

  async function deleteInterface(payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const interfaceId = typeof payload.interfaceId === 'string' ? payload.interfaceId.trim() : '';
    const record = interfacesById.get(interfaceId);
    if (!record) {
      return { ok: false, error: `interface '${interfaceId}' not found` };
    }

    if (record.routeId && deps.gatewayClient.deleteIntegrationRoute) {
      const gatewayUrl = deps.auth.getGatewayUrl();
      const bearerToken = await getBearerToken();
      const result = await deps.gatewayClient.deleteIntegrationRoute(gatewayUrl, record.routeId, bearerToken);
      if (!result.ok) {
        return {
          ok: false,
          error: result.error || `gateway error ${result.status}`,
          retryable: result.status >= 500,
        };
      }
    }

    interfacesById.delete(interfaceId);
    return { ok: true, interfaceId };
  }

  async function rotateInterfaceToken(payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const interfaceId = typeof payload.interfaceId === 'string' ? payload.interfaceId.trim() : '';
    const record = interfacesById.get(interfaceId);
    if (!record) {
      return { ok: false, error: `interface '${interfaceId}' not found` };
    }

    if (!record.routeId || !deps.gatewayClient.rotateIntegrationRouteToken) {
      record.routeToken = randomBytes(32).toString('base64url');
      record.updatedAt = nowIso();
      return { ok: true, interface: { ...record }, routeToken: record.routeToken };
    }

    const gatewayUrl = deps.auth.getGatewayUrl();
    const bearerToken = await getBearerToken();
    const graceSeconds = typeof payload.graceSeconds === 'number' ? payload.graceSeconds : 300;
    const result = await deps.gatewayClient.rotateIntegrationRouteToken(gatewayUrl, record.routeId, bearerToken, graceSeconds);

    if (!result.ok) {
      return {
        ok: false,
        error: result.error || `gateway error ${result.status}`,
        retryable: result.status >= 500,
      };
    }

    const routeToken = typeof result.data?.route_token === 'string'
      ? result.data.route_token
      : randomBytes(32).toString('base64url');

    record.routeToken = routeToken;
    record.updatedAt = nowIso();

    return {
      ok: true,
      interface: { ...record },
      routeToken,
    };
  }

  async function getWebhookUrl(payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const interfaceId = typeof payload.interfaceId === 'string' ? payload.interfaceId.trim() : '';
    const record = interfacesById.get(interfaceId);
    if (!record) {
      return { ok: false, error: `interface '${interfaceId}' not found` };
    }

    return {
      ok: true,
      interfaceId,
      webhookUrl: record.publicUrl || '',
      routeId: record.routeId || null,
    };
  }

  async function getInterfaceRuntimeStatus(): Promise<Record<string, unknown>> {
    const active = [...interfacesById.values()].filter((record) => record.status === 'active').length;
    return {
      ok: true,
      status: {
        totalInterfaces: interfacesById.size,
        activeInterfaces: active,
      },
    };
  }

  async function syncTunnel(): Promise<Record<string, unknown>> {
    return {
      ok: true,
      synced: true,
      count: interfacesById.size,
    };
  }

  return {
    listInterfaces,
    createSlackInterface,
    updateInterface,
    deleteInterface,
    rotateInterfaceToken,
    getWebhookUrl,
    getInterfaceRuntimeStatus,
    syncTunnel,
  };
}
