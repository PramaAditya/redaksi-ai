import {
  Exa,
  type RegularSearchOptions,
  type FindSimilarOptions,
  type AnswerOptions,
} from "exa-js";

// We type GetContentsOptions as unknown since it might not be exported directly under a simple name.
type GetContentsOptions = unknown;

class ExaService {
  private keys: string[];
  private currentKeyIndex: number = 0;
  private cooldownUntil: Map<number, number> = new Map();
  private readonly cooldownMs: number = 60_000;
  private app: Exa;

  constructor() {
    const keysEnv = process.env.EXA_API_KEYS || process.env.EXA_API_KEY || "";
    this.keys = keysEnv
      .split(",")
      .map((k: string) => k.trim())
      .filter((k: string) => k.length > 0);

    if (this.keys.length === 0) {
      console.warn("[ExaService] No Exa API keys provided in environment.");
    } else {
      console.log(`[ExaService] Initialized with ${this.keys.length} keys.`);
    }

    this.app = new Exa(this.keys[this.currentKeyIndex] || "");
  }

  private rotateKey(failedKeyIndex: number = this.currentKeyIndex): boolean {
    if (this.keys.length <= 1) return false;

    const now = Date.now();
    this.cooldownUntil.set(failedKeyIndex, now + this.cooldownMs);

    // If another concurrent request already rotated away from failedKeyIndex to a healthy key, reuse it
    if (
      this.currentKeyIndex !== failedKeyIndex &&
      (this.cooldownUntil.get(this.currentKeyIndex) || 0) <= now
    ) {
      return true;
    }

    for (let offset = 1; offset <= this.keys.length; offset++) {
      const candidate = (failedKeyIndex + offset) % this.keys.length;
      if (candidate !== failedKeyIndex && (this.cooldownUntil.get(candidate) || 0) <= now) {
        this.currentKeyIndex = candidate;
        console.log(
          `[ExaService] Rotating to API key index ${this.currentKeyIndex}`,
        );
        this.app = new Exa(this.keys[this.currentKeyIndex] || "");
        return true;
      }
    }
    return false;
  }

  private isCreditOrQuotaError(error: unknown): boolean {
    if (error && typeof error === "object") {
      const e = error as Record<string, unknown>;
      const status =
        e.response && typeof e.response === "object" && "status" in e.response
          ? (e.response as Record<string, unknown>).status
          : e.statusCode || e.status;
      return (
        status === 402 || status === 429 || status === 401 || status === 403
      );
    }
    return false;
  }

  private getErrorStatus(error: unknown): unknown {
    if (error && typeof error === "object") {
      const e = error as Record<string, unknown>;
      if (
        e.response &&
        typeof e.response === "object" &&
        "status" in e.response
      ) {
        return (e.response as Record<string, unknown>).status;
      }
      return e.statusCode || e.status;
    }
    return undefined;
  }

  public async search(
    query: string,
    options?: RegularSearchOptions,
  ): Promise<unknown> {
    const keyIndexAtStart = this.currentKeyIndex;
    try {
      const fn = this.app.search as unknown as (
        q: string,
        opt?: RegularSearchOptions,
      ) => Promise<unknown>;
      return await fn.call(this.app, query, options);
    } catch (error: unknown) {
      if (this.isCreditOrQuotaError(error)) {
        const status = this.getErrorStatus(error);
        console.warn(
          `[ExaService] Search failed with status ${String(status)}. Key index: ${keyIndexAtStart}`,
        );

        if (this.rotateKey(keyIndexAtStart)) {
          console.log(`[ExaService] Retrying search with new key...`);
          return this.search(query, options);
        } else {
          console.error("[ExaService] All Exa API keys exhausted.");
          throw new Error("All Exa API keys exhausted or rate-limited.");
        }
      }
      throw error;
    }
  }

  public async getContents(
    urls: string | string[],
    options?: GetContentsOptions,
  ): Promise<unknown> {
    const keyIndexAtStart = this.currentKeyIndex;
    try {
      const fn = this.app.getContents as unknown as (
        u: string | string[],
        opt?: GetContentsOptions,
      ) => Promise<unknown>;
      return await fn.call(this.app, urls, options);
    } catch (error: unknown) {
      if (this.isCreditOrQuotaError(error)) {
        const status = this.getErrorStatus(error);
        console.warn(
          `[ExaService] getContents failed with status ${String(status)}. Key index: ${keyIndexAtStart}`,
        );

        if (this.rotateKey(keyIndexAtStart)) {
          console.log(`[ExaService] Retrying getContents with new key...`);
          return this.getContents(urls, options);
        } else {
          console.error("[ExaService] All Exa API keys exhausted.");
          throw new Error("All Exa API keys exhausted or rate-limited.");
        }
      }
      throw error;
    }
  }

  public async findSimilar(
    url: string,
    options?: FindSimilarOptions,
  ): Promise<unknown> {
    const keyIndexAtStart = this.currentKeyIndex;
    try {
      const fn = this.app.findSimilar as unknown as (
        u: string,
        opt?: FindSimilarOptions,
      ) => Promise<unknown>;
      return await fn.call(this.app, url, options);
    } catch (error: unknown) {
      if (this.isCreditOrQuotaError(error)) {
        const status = this.getErrorStatus(error);
        console.warn(
          `[ExaService] findSimilar failed with status ${String(status)}. Key index: ${keyIndexAtStart}`,
        );

        if (this.rotateKey(keyIndexAtStart)) {
          console.log(`[ExaService] Retrying findSimilar with new key...`);
          return this.findSimilar(url, options);
        } else {
          console.error("[ExaService] All Exa API keys exhausted.");
          throw new Error("All Exa API keys exhausted or rate-limited.");
        }
      }
      throw error;
    }
  }

  public async answer(
    query: string,
    options?: AnswerOptions,
  ): Promise<unknown> {
    const keyIndexAtStart = this.currentKeyIndex;
    try {
      const fn = this.app.answer as unknown as (
        q: string,
        opt?: AnswerOptions,
      ) => Promise<unknown>;
      return await fn.call(this.app, query, options);
    } catch (error: unknown) {
      if (this.isCreditOrQuotaError(error)) {
        const status = this.getErrorStatus(error);
        console.warn(
          `[ExaService] answer failed with status ${String(status)}. Key index: ${keyIndexAtStart}`,
        );

        if (this.rotateKey(keyIndexAtStart)) {
          console.log(`[ExaService] Retrying answer with new key...`);
          return this.answer(query, options);
        } else {
          console.error("[ExaService] All Exa API keys exhausted.");
          throw new Error("All Exa API keys exhausted or rate-limited.");
        }
      }
      throw error;
    }
  }
}

export const exaService = new ExaService();
