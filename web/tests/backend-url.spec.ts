import {test, expect} from "@playwright/test";
import {backendBase, backendUrl} from "../app/api/backend-url";

function env(internal?: string, fallback?: string) {
  const prevInternal = process.env.CHEF_FASTAPI_INTERNAL_URL, prevFallback = process.env.FASTAPI_BASE_URL;
  if (internal === undefined) delete process.env.CHEF_FASTAPI_INTERNAL_URL;
  else process.env.CHEF_FASTAPI_INTERNAL_URL = internal;
  if (fallback === undefined) delete process.env.FASTAPI_BASE_URL;
  else process.env.FASTAPI_BASE_URL = fallback;
  return () => {
    if (prevInternal === undefined) delete process.env.CHEF_FASTAPI_INTERNAL_URL;
    else process.env.CHEF_FASTAPI_INTERNAL_URL = prevInternal;
    if (prevFallback === undefined) delete process.env.FASTAPI_BASE_URL;
    else process.env.FASTAPI_BASE_URL = prevFallback;
  };
}

test("https backend origins are accepted", async () => {
  const restore = env("https://chef-ai-workspace-api.onrender.com");
  try {
    expect(backendBase()).toBe("https://chef-ai-workspace-api.onrender.com");
    expect(backendUrl()?.toString()).toBe("https://chef-ai-workspace-api.onrender.com/");
  } finally {
    restore();
  }
});

test("http internal binding host is accepted; credentials and exotic schemes are not", async () => {
  // Render private address / Vercel service mesh style: http-only by platform design.
  const restore = env("http://chef-ai-workspace-api:10000");
  try {
    expect(backendUrl()?.toString()).toBe("http://chef-ai-workspace-api:10000/");
  } finally {
    restore();
  }
  for (const bad of ["https://user:pw@chef-ai-workspace-api.onrender.com", "http://user@chef-ai-workspace-api:10000",
    "file:///etc/passwd", "not a url"]) {
    const restoreBad = env(bad);
    try {
      expect(backendUrl()).toBeUndefined();
    } finally {
      restoreBad();
    }
  }
});

test("loopback http fallback stays available; arbitrary http fallback is rejected", async () => {
  for (const loop of ["http://127.0.0.1:8100", "http://localhost:8100"]) {
    const restore = env(undefined, loop);
    try {
      expect(backendUrl()?.origin).toBe(new URL(loop).origin);
    } finally {
      restore();
    }
  }
  const restore = env(undefined, "http://example.com:8100");
  try {
    expect(backendBase()).toBeUndefined();
    expect(backendUrl()).toBeUndefined();
  } finally {
    restore();
  }
});

test("missing binding yields no backend URL", async () => {
  const restore = env(undefined, undefined);
  try {
    expect(backendBase()).toBeUndefined();
    expect(backendUrl()).toBeUndefined();
  } finally {
    restore();
  }
});
