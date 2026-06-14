// Minimal node-only HTTP client used for the DevEco login + token endpoints.
// Ported from deveco-code packages/opencode/src/plugin/deveco.ts (HttpClient),
// kept dependency-free (no axios / undici) so the plugin only needs node stdlib.

import http from "node:http"
import https from "node:https"

export interface HttpResponse {
  data: string
  statusCode: number
  headers: http.IncomingHttpHeaders
}

export interface HttpRequestConfig {
  timeout?: number
  headers?: Record<string, string>
  params?: Record<string, string>
}

export class HttpClient {
  private defaultTimeout: number = 20_000
  private defaultHeaders: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "accept-language": "zh-CN",
  }

  public async get(url: string, config?: HttpRequestConfig): Promise<HttpResponse> {
    return this.request(url, "GET", config)
  }

  public async post(url: string, config?: HttpRequestConfig): Promise<HttpResponse> {
    return this.request(url, "POST", config)
  }

  public parseJson<T = unknown>(response: HttpResponse): T {
    return JSON.parse(response.data) as T
  }

  private async request(
    url: string,
    method: string,
    config?: HttpRequestConfig,
  ): Promise<HttpResponse> {
    const parsedUrl = new URL(url)
    const isHttps = parsedUrl.protocol === "https:"
    const httpModule = isHttps ? https : http

    const searchParams = new URLSearchParams(config?.params ?? {})
    const queryString = searchParams.toString()
    const fullUrl = queryString ? `${url}?${queryString}` : url

    const headers = {
      ...this.defaultHeaders,
      ...(config?.headers || {}),
    }

    return new Promise((resolve, reject) => {
      const options: http.RequestOptions | https.RequestOptions = {
        method,
        headers,
        timeout: config?.timeout ?? this.defaultTimeout,
      }

      const req = httpModule.request(fullUrl, options, (res) => {
        let data = ""
        res.on("data", (chunk: Buffer | string) => {
          data += chunk.toString()
        })
        res.on("end", () => {
          resolve({
            data,
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
          })
        })
      })

      req.on("error", reject)
      req.on("timeout", () => {
        req.destroy()
        reject(new Error("Request timeout"))
      })

      if (method === "POST" && config?.params) {
        req.write(JSON.stringify(config.params))
      }

      req.end()
    })
  }
}

export const httpClient = new HttpClient()
