import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createUploadCapacityLimiter } from "./uploadCapacity.js";

const responseDouble = () => {
  const response = new EventEmitter() as EventEmitter &
    Partial<Response> & {
      statusCode?: number;
      body?: unknown;
      selectedType?: string;
      headers: Map<string, string>;
    };
  response.locals = {};
  response.headers = new Map();
  response.setHeader = vi.fn((name: string, value: string | number | readonly string[]) => {
    response.headers.set(name.toLowerCase(), String(value));
    return response as Response;
  });
  response.status = vi.fn((status: number) => {
    response.statusCode = status;
    return response as Response;
  });
  response.type = vi.fn((value: string) => {
    response.selectedType = value;
    return response as Response;
  });
  response.json = vi.fn((body: unknown) => {
    response.body = body;
    return response as Response;
  });
  return response as Response & typeof response;
};

describe("upload capacity limiter", () => {
  it("rejects excess API uploads with Problem Details and releases exactly once", () => {
    const limiter = createUploadCapacityLimiter(1);
    const request = {
      baseUrl: "/api/v1",
      originalUrl: "/api/v1/vendors/vendor-a/certificates",
    } as Request;
    const first = responseDouble();
    first.locals.apiRequestId = "request-a";
    const firstNext = vi.fn();
    limiter(request, first, firstNext);
    expect(firstNext).toHaveBeenCalledOnce();

    const rejected = responseDouble();
    rejected.locals.apiRequestId = "request-b";
    limiter(request, rejected, vi.fn());
    expect(rejected.statusCode).toBe(503);
    expect(rejected.selectedType).toBe("application/problem+json");
    expect(rejected.headers.get("retry-after")).toBe("1");
    expect(rejected.body).toMatchObject({ status: 503, requestId: "request-b" });

    first.emit("finish");
    first.emit("close");
    const afterRelease = responseDouble();
    const afterNext = vi.fn();
    limiter(request, afterRelease, afterNext);
    expect(afterNext).toHaveBeenCalledOnce();
  });

  it("rejects unsafe limiter bounds", () => {
    expect(() => createUploadCapacityLimiter(0)).toThrow(RangeError);
    expect(() => createUploadCapacityLimiter(17)).toThrow(RangeError);
  });
});
