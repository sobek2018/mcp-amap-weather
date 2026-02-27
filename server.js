import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Env
 * - AMAP_API_KEY (required): 高德 Web服务 Key
 * - PORT (provided by Zeabur)
 * - ALLOWED_ORIGINS (optional): 允许的 Origin，用逗号分隔。例：https://app.n8n.cloud,https://your-n8n-domain.com
 */
const PORT = Number(process.env.PORT || 3000);
const AMAP_API_KEY = process.env.AMAP_API_KEY;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!AMAP_API_KEY) {
  console.error("Missing env AMAP_API_KEY");
  process.exit(1);
}

function originAllowed(origin) {
  if (!origin) return true; // 某些服务端调用可能不带 Origin
  if (ALLOWED_ORIGINS.length === 0) return true; // 不设置则全放行（生产建议设置）
  return ALLOWED_ORIGINS.includes(origin);
}

async function amapWeather({ city, extensions }) {
  const url = new URL("https://restapi.amap.com/v3/weather/weatherInfo");
  url.searchParams.set("key", AMAP_API_KEY);
  url.searchParams.set("city", String(city));
  // base=实况, all=预报
  url.searchParams.set("extensions", extensions || "base");

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: { "Accept": "application/json" }
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`AMap HTTP ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  // AMap status: "1" success, "0" fail
  if (data?.status !== "1") {
    throw new Error(`AMap API error: ${data?.info || "unknown"} (infocode=${data?.infocode})`);
  }
  return data;
}

const app = express();

// 仅对 POST 解析 JSON，GET 不需要 body
app.use(express.json({ limit: "1mb" }));

/**
 * MCP endpoint (Streamable HTTP):
 * - 必须同一路径同时支持 GET + POST
 * - 建议路径用 /mcp，便于 n8n 填写 Endpoint
 */
app.all("/mcp", async (req, res) => {
  try {
    const origin = req.headers.origin;
    if (!originAllowed(origin)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    const server = new McpServer({
      name: "amap-weather-mcp",
      version: "1.0.0"
    });

    // 注册一个工具：cn-weather-amap
    server.registerTool(
      "cn-weather-amap",
      {
        title: "China Weather (AMap)",
        description:
          "Get China weather from AMap (Gaode). city can be adcode (e.g., 340100) or city code supported by AMap. extensions: base (current) / all (forecast)."
      },
      async (input) => {
        const city = input?.city;
        const extensions = input?.extensions || "base";
        if (!city) {
          return {
            content: [{ type: "text", text: "Missing required parameter: city" }]
          };
        }
        if (!["base", "all"].includes(extensions)) {
          return {
            content: [{ type: "text", text: "extensions must be 'base' or 'all'" }]
          };
        }

        const data = await amapWeather({ city, extensions });

        // 直接把原始 JSON 返回，n8n 里更容易做后处理
        return {
          content: [
            { type: "text", text: JSON.stringify(data, null, 2) }
          ]
        };
      }
    );

    await server.connect(transport);

    // SDK 示例：handleRequest(req, res, body) :contentReference[oaicite:1]{index=1}
    const body = req.method === "POST" ? req.body : undefined;
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("MCP error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      });
    }
  }
});

// 简单健康检查（可选）
app.get("/", (req, res) => res.status(200).send("OK"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AMap MCP server listening on 0.0.0.0:${PORT}`);
  console.log(`MCP endpoint: /mcp`);
});
