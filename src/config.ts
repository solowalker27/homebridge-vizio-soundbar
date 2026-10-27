import type { PlatformConfig } from 'homebridge';

export interface SoundbarConfig {
  name: string;
  endpoint: URL;
  authToken?: string;
  requestTimeout: number;
  pollInterval: number;
  debug: boolean;
}

export function parseConfig(config: PlatformConfig): SoundbarConfig {
  if (typeof config.ip !== 'string' || !config.ip.trim()) {
    throw new Error('ip is required (a soundbar IP address or hostname, optionally followed by :port)');
  }
  const host = config.ip.trim();
  const endpoint = new URL(`https://${host}`);
  if (endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
    || host.includes('/') || host.includes('?') || host.includes('#')) {
    throw new Error('ip must contain only a hostname or IP address and optional port, without a URL scheme');
  }
  // Vizio soundbars use a local HTTPS API with a self-signed certificate on port 9000.
  if (!endpoint.port && !host.endsWith(':443')) {
    endpoint.port = '9000';
  }
  const name = config.name === undefined ? 'Vizio Soundbar' : config.name;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 64) {
    throw new Error('name must contain 1–64 characters');
  }
  if (config.authToken !== undefined && (typeof config.authToken !== 'string' || /[\r\n]/.test(config.authToken))) {
    throw new Error('authToken must be a string without line breaks');
  }
  const requestTimeout = config.requestTimeout ?? 3000;
  if (!Number.isInteger(requestTimeout) || requestTimeout < 500 || requestTimeout > 4000) {
    throw new Error('requestTimeout must be an integer from 500 to 4000 milliseconds');
  }
  const pollInterval = config.pollInterval ?? 30;
  if (!Number.isInteger(pollInterval) || (pollInterval !== 0 && (pollInterval < 10 || pollInterval > 3600))) {
    throw new Error('pollInterval must be 0 (disabled) or an integer from 10 to 3600 seconds');
  }
  const debug = config.debug ?? false;
  if (typeof debug !== 'boolean') {
    throw new Error('debug must be a boolean');
  }
  return { name: name.trim(), endpoint, authToken: config.authToken, requestTimeout, pollInterval, debug };
}
