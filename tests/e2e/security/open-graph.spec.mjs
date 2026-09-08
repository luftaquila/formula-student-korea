import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const requireVue = createRequire(require.resolve("vue/package.json"));
const { parse } = await import(requireVue.resolve("@vue/compiler-dom"));

test("homepage social images follow the request host without JavaScript", async ({ request }) => {
  for (const host of ["test.luftaquila.io", "fsk.luftaquila.io", "preview.example.org"]) {
    const response = await request.get("/", {
      headers: { Host: host, "X-Forwarded-Host": "unrelated.example.org" },
    });
    expect(response.status()).toBe(200);
    const metadata = new Map();
    function visit(node) {
      if (node.tag === "meta") {
        const attrs = Object.fromEntries(node.props.map(attr => [attr.name, attr.value?.content]));
        metadata.set(attrs.property ?? attrs.name, attrs.content);
      }
      for (const child of node.children ?? []) visit(child);
    }
    visit(parse(await response.text()));
    expect(metadata.get("og:type")).toBe("website");
    expect(metadata.get("og:title")).toBeTruthy();
    expect(metadata.get("og:image:alt")).toBeTruthy();
    expect(metadata.get("twitter:card")).toBe("summary_large_image");
    expect(metadata.get("twitter:image")).toBe(metadata.get("og:image"));
    const imageUrl = new URL(metadata.get("og:image"));
    expect(imageUrl.origin).toBe(`https://${host}`);
    const image = await request.get(imageUrl.pathname, { headers: { Host: host } });
    expect(image.status()).toBe(200);
    expect(image.headers()["content-type"]).toBe(metadata.get("og:image:type"));
    const bytes = await image.body();
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(bytes.readUInt32BE(16)).toBe(Number(metadata.get("og:image:width")));
    expect(bytes.readUInt32BE(20)).toBe(Number(metadata.get("og:image:height")));
  }
});


test("public service pages expose the shared image before JavaScript runs", async ({ request }) => {
  for (const path of ["/course/public", "/course/public/", "/queue/", "/calendar/"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    const html = await response.text();
    const metadata = new Map();
    function visit(node) {
      if (node.tag === "meta") {
        const attrs = Object.fromEntries(node.props.map(attr => [attr.name, attr.value?.content]));
        metadata.set(attrs.property ?? attrs.name, attrs.content);
      }
      for (const child of node.children ?? []) visit(child);
    }
    visit(parse(html));
    expect(metadata.get("og:image"), path).toBe("https://localhost:9000/og-image.png");
    if (path.startsWith("/course/public")) {
      expect(metadata.get("og:title")).toBe("FSK 경기 코스");
    }
  }
});
