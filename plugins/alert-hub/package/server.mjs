import { createHash, randomUUID } from "node:crypto";
// plugins/alert-hub/routes.json
var routes_default = [
	["GET", "/api/health"],
	["POST", "/api/auth/login"],
	["POST", "/api/auth/logout"],
	["GET", "/api/auth/me"],
	["POST", "/api/auth/password"],
	["GET", "/api/me"],
	["GET", "/api/filter-options"],
	["GET", "/api/summary"],
	["GET", "/api/dashboard"],
	["GET", "/api/diagnostics"],
	["GET", "/api/events"],
	["GET", "/api/events/export"],
	["GET", "/api/events/{id}"],
	["POST", "/api/ingest/tencent-cls"],
	["POST", "/api/ingest/generic"],
	["POST", "/api/ingest/prometheus"],
	["POST", "/api/ingest/tencent-monitor"],
	["GET", "/api/cases"],
	["GET", "/api/cases/export"],
	["GET", "/api/cases/{id}"],
	["POST", "/api/cases/{id}/ack"],
	["POST", "/api/cases/{id}/assign"],
	["POST", "/api/cases/{id}/triage"],
	["POST", "/api/cases/{id}/severity"],
	["POST", "/api/cases/{id}/resolve"],
	["POST", "/api/cases/{id}/close"],
	["POST", "/api/cases/{id}/noise"],
	["POST", "/api/cases/{id}/reopen"],
	["POST", "/api/cases/{id}/merge"],
	["POST", "/api/cases/{id}/comments"],
	["GET", "/api/cases/reclassify-services"],
	["POST", "/api/cases/reclassify-services"],
	["GET", "/api/todos"],
	["POST", "/api/todos"],
	["GET", "/api/todos/{id}"],
	["PUT", "/api/todos/{id}"],
	["POST", "/api/todos/{id}/start"],
	["POST", "/api/todos/{id}/complete"],
	["POST", "/api/todos/{id}/cancel"],
	["POST", "/api/todos/{id}/reopen"],
	["POST", "/api/cases/{id}/todos"],
	["GET", "/api/owners"],
	["POST", "/api/owners"],
	["PUT", "/api/owners/{id}"],
	["DELETE", "/api/owners/{id}"],
	["GET", "/api/people"],
	["POST", "/api/people"],
	["PUT", "/api/people/{id}"],
	["DELETE", "/api/people/{id}"],
	["GET", "/api/teams"],
	["POST", "/api/teams"],
	["PUT", "/api/teams/{id}"],
	["DELETE", "/api/teams/{id}"],
	["GET", "/api/teams/{id}/usage"],
	["POST", "/api/teams/{id}/merge"],
	["GET", "/api/rules"],
	["POST", "/api/rules"],
	["PUT", "/api/rules/{id}"],
	["DELETE", "/api/rules/{id}"],
	["POST", "/api/rules/dry-run"],
	["GET", "/api/fingerprint-rules"],
	["POST", "/api/fingerprint-rules"],
	["PUT", "/api/fingerprint-rules/{id}"],
	["DELETE", "/api/fingerprint-rules/{id}"],
	["POST", "/api/fingerprint-rules/preview"],
	["POST", "/api/fingerprint-rules/dry-run"],
	["GET", "/api/notification-channels"],
	["POST", "/api/notification-channels"],
	["PUT", "/api/notification-channels/{id}"],
	["DELETE", "/api/notification-channels/{id}"],
	["GET", "/api/notification-policies"],
	["POST", "/api/notification-policies"],
	["PUT", "/api/notification-policies/{id}"],
	["GET", "/api/service-notification-routes"],
	["POST", "/api/service-notification-routes"],
	["PUT", "/api/service-notification-routes/{id}"],
	["GET", "/api/notification-deliveries"]
];
// plugins/alert-hub/application.ts
var endpoint = "https://thor-alert-hub.hahavending.com";
var patterns = routes_default.map(([method, path]) => ({
	method,
	pattern: new RegExp("^" + path.replace("{id}", "[a-zA-Z0-9_-]+") + "$")
}));
var fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function createPlugin(_host, fetchImpl = fetch) {
	let cookie = "";
	const tickets = /* @__PURE__ */ new Map();
	function validate(raw) {
		if (!raw || typeof raw.path !== "string" || !raw.path.startsWith("/") || raw.path.startsWith("//") || /[\\\x00-\x20]/.test(raw.path)) throw new Error("请求路径无效");
		const url = new URL(raw.path, endpoint), method = raw.method || "GET";
		if (url.origin !== "https://thor-alert-hub.hahavending.com" || !patterns.some((p) => p.method === method && p.pattern.test(url.pathname)) && !(method === "GET" && ["/samples/generic-alert.json", "/samples/tencent-cls.ndjson"].includes(url.pathname))) throw new Error("该操作未在插件接口清单中");
		if (raw.body !== void 0 && (typeof raw.body !== "string" || Buffer.byteLength(raw.body) > 35e4)) throw new Error("请求内容过大或格式无效");
		return {
			path: url.pathname + url.search,
			method,
			body: raw.body
		};
	}
	async function send(input) {
		let response;
		try {
			response = await fetchImpl(endpoint + input.path, {
				method: input.method,
				headers: {
					Accept: "application/json, text/csv, text/plain",
					"Content-Type": "application/json",
					...cookie ? { Cookie: cookie } : {}
				},
				body: input.body,
				redirect: "error",
				signal: AbortSignal.timeout(2e4)
			});
		} catch {
			throw new Error(input.method === "GET" ? "连接告警中心失败，请检查网络后重试" : "请求结果未知，请到告警中心核对后再操作；未自动重试");
		}
		const setCookies = response.headers.getSetCookie();
		for (const value of setCookies) {
			const match = /^ah_session=([^;]*)/.exec(value);
			if (match) cookie = match[1] ? `ah_session=${match[1]}` : "";
		}
		if (input.path === "/api/auth/logout") {
			cookie = "";
			tickets.clear();
		}
		if (response.status === 401) {
			cookie = "";
			tickets.clear();
		}
		const reader = response.body?.getReader();
		let text = "", size = 0;
		const decoder = new TextDecoder();
		if (reader) try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > 4e6) {
					await reader.cancel();
					throw new Error("响应超过 4 MB，请缩小查询范围");
				}
				text += decoder.decode(value, { stream: true });
			}
			text += decoder.decode();
		} catch (error) {
			throw new Error(input.method === "GET" ? "读取响应失败，请缩小查询范围" : "响应读取失败，操作结果未知，请先核对远端状态");
		}
		return {
			status: response.status,
			body: text,
			headers: {
				"content-type": response.headers.get("content-type") || "application/json",
				"content-disposition": response.headers.get("content-disposition") || ""
			}
		};
	}
	return {
		async request(method, raw) {
			if (method === "status") return {
				endpoint,
				authenticated: !!cookie
			};
			const input = validate(raw);
			const login = ["/api/auth/login", "/api/auth/logout"].includes(input.path);
			if (method === "prepare") {
				if (input.method === "GET" || login) throw new Error("该操作无需写入预览");
				if (!cookie) throw new Error("请先登录告警中心");
				for (const [id, t] of tickets) if (t.expires < Date.now()) tickets.delete(id);
				if (tickets.size >= 20) throw new Error("待确认操作过多");
				const ticket = randomUUID();
				tickets.set(ticket, {
					digest: fingerprint(input),
					expires: Date.now() + 12e4
				});
				return {
					ticket,
					endpoint,
					path: input.path,
					method: input.method,
					body: input.path === "/api/auth/password" ? "密码修改（不展示密码）" : input.body || ""
				};
			}
			if (method !== "request") throw new Error("不支持的插件操作");
			if (input.method !== "GET" && !login) {
				const t = tickets.get(raw.ticket);
				tickets.delete(raw.ticket);
				if (!t || t.expires < Date.now() || t.digest !== fingerprint(input)) throw new Error("写入确认已失效，请重新预览");
			}
			return send(input);
		},
		async close() {
			cookie = "";
			tickets.clear();
		}
	};
}
export { createPlugin, endpoint };
