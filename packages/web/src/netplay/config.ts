/**
 * Netplay ICE configuration (T23). TURN/STUN endpoints come from Vite build
 * env (`VITE_*`). Production TURN credentials are time-limited and issued per
 * session (T34/T42); the static values here are for local development against
 * the coturn service in `deploy/docker-compose.yml`.
 */
import type { IceServer } from "./types";

export interface NetplayEnv {
  VITE_STUN_URL?: string;
  VITE_TURN_URL?: string;
  VITE_TURN_USERNAME?: string;
  VITE_TURN_CREDENTIAL?: string;
}

export function iceServersFromEnv(env: NetplayEnv): IceServer[] {
  const servers: IceServer[] = [];
  if (env.VITE_STUN_URL) servers.push({ urls: env.VITE_STUN_URL });
  if (env.VITE_TURN_URL) {
    const turn: IceServer = { urls: env.VITE_TURN_URL };
    if (env.VITE_TURN_USERNAME) turn.username = env.VITE_TURN_USERNAME;
    if (env.VITE_TURN_CREDENTIAL) turn.credential = env.VITE_TURN_CREDENTIAL;
    servers.push(turn);
  }
  return servers;
}

export function defaultIceServers(): IceServer[] {
  const env = (import.meta as unknown as { env?: NetplayEnv }).env ?? {};
  return iceServersFromEnv(env);
}

/** Relay endpoint + room-join JWT from Vite build env (T24/T34). */
export interface RelayEnv {
  VITE_RELAY_URL?: string;
  VITE_RELAY_TOKEN?: string;
}

export interface RelayConfig {
  relayUrl: string;
  token: string;
}

/** The relay endpoint, or null until both URL and token are configured. */
export function relayConfigFromEnv(env: RelayEnv): RelayConfig | null {
  if (!env.VITE_RELAY_URL || !env.VITE_RELAY_TOKEN) return null;
  return { relayUrl: env.VITE_RELAY_URL, token: env.VITE_RELAY_TOKEN };
}
