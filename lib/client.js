window.__ModuleLoader__.load({
	id: "dsh-pgadmin",
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		"use strict";
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __export = (target, all) => {
		  for (var name2 in all)
		    __defProp(target, name2, { get: all[name2], enumerable: true });
		};
		var __copyProps = (to, from, except, desc) => {
		  if (from && typeof from === "object" || typeof from === "function") {
		    for (let key of __getOwnPropNames(from))
		      if (!__hasOwnProp.call(to, key) && key !== except)
		        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
		  }
		  return to;
		};
		var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

		// src/client/index.tsx
		var index_exports = {};
		__export(index_exports, {
		  apply: () => apply,
		  inject: () => inject,
		  name: () => name
		});
		module.exports = __toCommonJS(index_exports);
		var import_react = require("react");
		var import_jsx_runtime = require("react/jsx-runtime");
		var name = "dsh-pgadmin";
		var inject = ["slots", "locale", "sidebarRight", "sidebarRightTabs"];
		var PAGE_ID = "dsh-pgadmin";
		var PAGE_KIND = "pgadmin";
		var NS = "dsh-pgadmin";
		var OPEN_COMMAND = "pgadmin.open";
		var DEFAULT_PORT = 5051;
		var EN = {
		  title: "pgAdmin",
		  guide: "Start pgAdmin 4 and show it in this panel.",
		  reload: "Reload",
		  open: "Open in browser",
		  frame: "pgAdmin 4"
		};
		var DICTIONARIES = {
		  en: EN,
		  ko: {
		    title: "pgAdmin",
		    guide: "pgAdmin 4\uB97C \uCF1C\uC11C \uC774 \uD328\uB110\uC5D0 \uB744\uC6C1\uB2C8\uB2E4.",
		    reload: "\uC0C8\uB85C\uACE0\uCE68",
		    open: "\uBE0C\uB77C\uC6B0\uC800\uB85C \uC5F4\uAE30",
		    frame: "pgAdmin 4"
		  },
		  ja: {
		    title: "pgAdmin",
		    guide: "pgAdmin 4 \u3092\u8D77\u52D5\u3057\u3066\u3053\u306E\u30D1\u30CD\u30EB\u306B\u8868\u793A\u3057\u307E\u3059\u3002",
		    reload: "\u518D\u8AAD\u307F\u8FBC\u307F",
		    open: "\u30D6\u30E9\u30A6\u30B6\u3067\u958B\u304F",
		    frame: "pgAdmin 4"
		  },
		  zh: {
		    title: "pgAdmin",
		    guide: "\u542F\u52A8 pgAdmin 4 \u5E76\u5728\u6B64\u9762\u677F\u4E2D\u663E\u793A\u3002",
		    reload: "\u91CD\u65B0\u52A0\u8F7D",
		    open: "\u5728\u6D4F\u89C8\u5668\u4E2D\u6253\u5F00",
		    frame: "pgAdmin 4"
		  }
		};
		function frameUrl(config) {
		  if (typeof config.url === "string" && config.url !== "") return config.url;
		  const port = Number(config.port ?? DEFAULT_PORT);
		  const host = typeof window === "undefined" ? "127.0.0.1" : window.location.hostname;
		  return `http://${host}:${String(port)}`;
		}
		function PgAdminIcon({ size = 16, className }) {
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
		    "svg",
		    {
		      width: size,
		      height: size,
		      viewBox: "0 0 16 16",
		      fill: "none",
		      stroke: "currentColor",
		      strokeWidth: "1.15",
		      strokeLinecap: "round",
		      className,
		      "aria-hidden": "true",
		      children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ellipse", { cx: "8", cy: "3.5", rx: "5.1", ry: "2" }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M2.9 3.5v9c0 1.1 2.28 2 5.1 2s5.1-.9 5.1-2v-9" }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M2.9 8c0 1.1 2.28 2 5.1 2s5.1-.9 5.1-2" })
		      ]
		    }
		  );
		}
		var buttonStyle = {
		  display: "inline-flex",
		  alignItems: "center",
		  height: 22,
		  padding: "0 8px",
		  border: "1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.28))",
		  borderRadius: 5,
		  background: "transparent",
		  color: "var(--dsw-alias-label-secondary, inherit)",
		  font: "inherit",
		  fontSize: 11,
		  cursor: "pointer",
		  flex: "none"
		};
		function PgAdminPage({ url, t }) {
		  const [generation, setGeneration] = (0, import_react.useState)(0);
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
		      "div",
		      {
		        style: {
		          display: "flex",
		          alignItems: "center",
		          gap: 6,
		          padding: "4px 8px",
		          borderBottom: "1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.22))"
		        },
		        children: [
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		            "span",
		            {
		              style: {
		                flex: 1,
		                minWidth: 0,
		                overflow: "hidden",
		                textOverflow: "ellipsis",
		                whiteSpace: "nowrap",
		                fontSize: 11,
		                color: "var(--dsw-alias-label-tertiary, inherit)"
		              },
		              children: url
		            }
		          ),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: buttonStyle, onClick: () => setGeneration((value) => value + 1), children: t("reload") }),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: buttonStyle, onClick: () => window.open(url, "_blank", "noopener,noreferrer"), children: t("open") })
		        ]
		      }
		    ),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		      "iframe",
		      {
		        src: url,
		        title: t("frame"),
		        sandbox: "allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals",
		        style: { flex: 1, width: "100%", minHeight: 0, border: 0, background: "#fff" }
		      },
		      generation
		    )
		  ] });
		}
		function apply(ctx, config = {}) {
		  ctx.effect(() => ctx.locale.register(NS, { en: { ...EN }, ...DICTIONARIES }), "dsh-pgadmin: copy");
		  const bound = ctx.locale.bind(NS);
		  const t = (key) => bound(key);
		  const url = frameUrl(config);
		  ctx.effect(() => ctx.sidebarRightTabs.register({
		    id: PAGE_ID,
		    kind: PAGE_KIND,
		    keepMounted: true,
		    title: () => t("title"),
		    guide: [{
		      id: "open",
		      commandId: OPEN_COMMAND,
		      order: 40,
		      title: () => t("title"),
		      description: () => t("guide"),
		      icon: PgAdminIcon
		    }]
		  }), "dsh-pgadmin: page type");
		  const Body = () => PgAdminPage({ url, t });
		  ctx.effect(
		    () => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: PAGE_ID }, Body)),
		    "dsh-pgadmin: page body"
		  );
		  ctx.inject(["shortcuts"], (scope) => {
		    const shortcuts = scope.get("shortcuts");
		    if (shortcuts === void 0) return;
		    scope.effect(() => shortcuts.register({
		      id: OPEN_COMMAND,
		      label: () => t("title"),
		      aliases: ["pgadmin", "postgres", "database"],
		      regions: ["page", "editable", "terminal"],
		      modals: [],
		      resolve: ({ target }) => {
		        const destination = scope.sidebarRight.commandTarget(target);
		        if (destination === void 0) return { status: "blocked", reason: t("guide") };
		        return { status: "handled", run: () => {
		          scope.sidebarRight.openTabFromTarget(PAGE_KIND, destination);
		        } };
		      }
		    }), "dsh-pgadmin: command");
		  });
		}

		return module.exports
	}
})
