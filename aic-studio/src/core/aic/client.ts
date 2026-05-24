// src/core/aic/client.ts
import axios from "axios";
import type { AxiosResponse } from "axios";
import type { TokenCache } from "./auth";

export interface AuthedClient {
  get<T = unknown>(url: string): Promise<AxiosResponse<T>>;
  put<T = unknown>(url: string, body: unknown): Promise<AxiosResponse<T>>;
}

export function createAuthedClient(cache: TokenCache): AuthedClient {
  async function request<T>(
    method: "GET" | "PUT",
    url: string,
    body: unknown,
    isRetry: boolean
  ): Promise<AxiosResponse<T>> {
    const token = await cache.get();
    try {
      if (method === "GET") {
        return await axios.get<T>(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
        });
      }
      return await axios.put<T>(url, body, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json"
        }
      });
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 401 && !isRetry) {
        cache.invalidate();
        return request<T>(method, url, body, true);
      }
      if (axios.isAxiosError(err) && err.response) {
        throw new Error(`AIC ${method} ${url} → ${err.response.status}`);
      }
      throw err;
    }
  }
  return {
    get: <T>(url: string) => request<T>("GET", url, undefined, false),
    put: <T>(url: string, body: unknown) => request<T>("PUT", url, body, false)
  };
}
