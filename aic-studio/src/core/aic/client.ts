// src/core/aic/client.ts
import axios from "axios";
import type { AxiosResponse } from "axios";
import type { TokenCache } from "./auth";

export interface AuthedClient {
  get<T = unknown>(url: string): Promise<AxiosResponse<T>>;
}

export function createAuthedClient(cache: TokenCache): AuthedClient {
  async function request<T>(url: string, isRetry: boolean): Promise<AxiosResponse<T>> {
    const token = await cache.get();
    try {
      return await axios.get<T>(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
      });
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 401 && !isRetry) {
        cache.invalidate();
        return request<T>(url, true);
      }
      if (axios.isAxiosError(err) && err.response) {
        throw new Error(`AIC GET ${url} → ${err.response.status}`);
      }
      throw err;
    }
  }
  return {
    get: <T>(url: string) => request<T>(url, false)
  };
}
