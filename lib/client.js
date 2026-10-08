window.__ModuleLoader__.load({ id: "@puwenhui/dsh-rag-kb", factory: (require) => {


		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region settings-tab.tsx
		/**
		* 设置 → 插件 →「知识库」标签页：配置项 + 使用指引。
		* 复杂操作按设计走会话语义（对话里说「把 D:\docs 加入知识库」即可），
		* 面板只承载：检索参数、知识库描述、监视目录 + 操作提示。
		*/
		const FIELDS = [
			{
				key: "description",
				label: "知识库描述",
				type: "string",
				placeholder: "如：公司产品手册、技术规范、常见问题解答",
				hint: "agent 检索前会阅读这段描述，知道库里有什么"
			},
			{
				key: "watchDir",
				label: "自动索引目录",
				type: "string",
				placeholder: "D:\\docs",
				hint: "放入此目录的文档自动监视索引（可选）"
			},
			{
				key: "topK",
				label: "检索返回条数",
				type: "number",
				hint: "默认 5"
			},
			{
				key: "minScore",
				label: "相似度阈值",
				type: "number",
				hint: "0~1，默认 0.3，过低噪音多"
			},
			{
				key: "enableReranker",
				label: "启用 Reranker 重排序",
				type: "boolean",
				hint: "首次使用会下载约 500MB 模型"
			},
			{
				key: "rerankTopN",
				label: "重排后返回条数",
				type: "number",
				hint: "默认 3"
			}
		];
		function KbSettingsTab(props) {
			const face = props.face;
			const [ns, setNs] = (0, react.useState)(null);
			const [view, setView] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [draft, setDraft] = (0, react.useState)(null);
			const [saving, setSaving] = (0, react.useState)(false);
			const [message, setMessage] = (0, react.useState)(null);
			const [failed, setFailed] = (0, react.useState)(false);
			const reload = (0, react.useCallback)(async () => {
				setError(null);
				if (face === void 0 || typeof face.describe !== "function") {
					setError("组件未收到设置读写面");
					return;
				}
				const timeout = new Promise((_, reject) => setTimeout(() => reject(/* @__PURE__ */ new Error("settings.describe 8 秒未响应")), 8e3));
				let result;
				try {
					result = await Promise.race([face.describe(), timeout]);
				} catch (e) {
					setError(`读取设置失败：${String(e.message)}`);
					return;
				}
				if ("error" in result) {
					setError(result.error);
					return;
				}
				const rows = result.namespaces ?? [];
				const hit = rows.find((row) => row.ns === "rag-kb");
				if (hit === void 0) {
					setError(`设置视图中未找到 rag-kb 命名空间（共 ${String(rows.length)} 个）`);
					return;
				}
				setNs(hit.ns);
				setView(hit);
				setDraft(null);
			}, [face]);
			(0, react.useEffect)(() => {
				reload();
			}, [reload]);
			const current = view?.value ?? {};
			const userLayer = view?.user ?? {};
			const shown = draft ?? current;
			const edit = (key, value) => {
				setMessage(null);
				setFailed(false);
				setDraft((prev) => ({
					...prev ?? { ...current },
					[key]: value
				}));
			};
			const save = async () => {
				if (draft === null || ns === null || view === void 0) return;
				setSaving(true);
				try {
					const ops = [];
					for (const f of FIELDS) {
						const after = draft[f.key];
						if (after === void 0 || after === "") continue;
						const value = f.type === "number" ? Number(after) : after;
						if (Number.isNaN(value)) continue;
						if (JSON.stringify(value) === JSON.stringify(current[f.key])) continue;
						ops.push({
							op: "set",
							path: [f.key],
							value
						});
					}
					if (ops.length > 0) {
						const result = await face.mutate(ns, ops, view.revision);
						if (!result.ok) throw new Error(result.error ?? "写入失败");
					}
					setDraft(null);
					setFailed(false);
					setMessage(ops.length > 0 ? "已保存，插件已按新配置自动重载" : "无更改");
					await reload();
				} catch (e) {
					setFailed(true);
					setMessage(`保存失败：${String(e.message)}`);
				} finally {
					setSaving(false);
				}
			};
			const inputStyle = {
				width: "100%",
				padding: "6px 10px",
				font: "inherit",
				boxSizing: "border-box",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "6px",
				background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-primary)"
			};
			if (error !== null) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					...cardStyle,
					color: "var(--dsw-alias-label-tertiary)"
				},
				children: [
					"知识库配置加载失败：",
					error,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => {
							reload();
						},
						style: {
							...btnStyle,
							marginLeft: "10px"
						},
						children: "重试"
					})
				]
			});
			if (view === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					...cardStyle,
					color: "var(--dsw-alias-label-tertiary)"
				},
				children: "知识库配置加载中…"
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: cardStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
					style: { fontSize: "14px" },
					children: "知识库"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "grid",
						gridTemplateColumns: "1fr 1fr",
						gap: "10px 14px",
						marginTop: "12px"
					},
					children: [FIELDS.map((f) => {
						const overridden = Object.hasOwn(userLayer, f.key);
						const isBoolean = f.type === "boolean";
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: "4px",
								fontSize: "13px",
								...isBoolean ? {
									gridColumn: "span 1",
									justifyContent: "center"
								} : {}
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: { color: "var(--dsw-alias-label-secondary)" },
									children: [f.label, overridden && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											marginLeft: "6px",
											color: "var(--dsw-alias-brand-primary)"
										},
										children: "·已覆盖"
									})]
								}),
								isBoolean ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										alignItems: "center",
										gap: "12px",
										padding: "4px 0"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: {
											display: "flex",
											alignItems: "center",
											gap: "4px",
											cursor: "pointer"
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "radio",
											name: f.key,
											checked: shown[f.key] === true,
											onChange: () => {
												edit(f.key, true);
											}
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "开" })]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: {
											display: "flex",
											alignItems: "center",
											gap: "4px",
											cursor: "pointer"
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "radio",
											name: f.key,
											checked: shown[f.key] !== true,
											onChange: () => {
												edit(f.key, false);
											}
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "关" })]
									})]
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									value: draft !== null && draft[f.key] !== void 0 ? String(draft[f.key]) : String(shown[f.key] ?? ""),
									placeholder: f.placeholder ?? "",
									onChange: (e) => {
										edit(f.key, e.target.value);
									},
									style: inputStyle
								}),
								f.hint !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: "11px",
										color: "var(--dsw-alias-label-tertiary)"
									},
									children: f.hint
								})
							]
						}, f.key);
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							gridColumn: "1 / -1",
							display: "flex",
							alignItems: "center",
							gap: "10px",
							marginTop: "4px"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: saving || draft === null,
								onClick: () => {
									save();
								},
								style: {
									padding: "6px 16px",
									borderRadius: "6px",
									font: "inherit",
									border: "1px solid var(--dsw-alias-brand-primary)",
									background: "var(--dsw-alias-brand-primary)",
									color: "var(--dsw-alias-label-primary-foreground)",
									cursor: draft === null ? "default" : "pointer",
									opacity: draft === null ? .6 : 1
								},
								children: saving ? "保存中…" : "保存"
							}),
							draft !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: saving,
								onClick: () => {
									setDraft(null);
									setMessage(null);
									setFailed(false);
								},
								style: {
									padding: "6px 16px",
									border: "1px solid var(--dsw-alias-border-l2)",
									borderRadius: "6px",
									background: "transparent",
									font: "inherit",
									color: "var(--dsw-alias-label-secondary)",
									cursor: "pointer"
								},
								children: "放弃更改"
							}),
							message !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: "12px",
									color: failed ? "var(--dsw-alias-label-error)" : "var(--dsw-alias-label-secondary)"
								},
								children: message
							})
						]
					})]
				})]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					...cardStyle,
					marginTop: "12px",
					color: "var(--dsw-alias-label-secondary)"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
						style: { fontSize: "13px" },
						children: "💡 知识库管理：直接在对话里说"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							marginTop: "8px",
							lineHeight: 1.8,
							fontSize: "13px"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
								"💬 「把 ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
									style: {
										background: "var(--dsw-alias-bg-layer-2)",
										padding: "1px 4px",
										borderRadius: "3px"
									},
									children: "D:\\docs"
								}),
								" 目录加入知识库」"
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: "💬 「知识库里有哪些文档？」" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: "💬 「删掉知识库里的旧版手册」" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: "💬 「根据知识库回答：报销流程是什么？」" })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							marginTop: "8px",
							fontSize: "11px",
							color: "var(--dsw-alias-label-tertiary)"
						},
						children: "支持 pdf / docx / md / txt / csv / json；文件内容变化自动重新索引。 首次使用会自动下载中文向量化模型（约 100MB，下载后完全离线）。"
					})
				]
			})] });
		}
		const cardStyle = {
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "10px",
			padding: "14px 16px",
			background: "var(--dsw-alias-bg-layer-3)",
			font: "13px/1.5 system-ui, \"Segoe UI\", \"Microsoft YaHei\", sans-serif",
			color: "var(--dsw-alias-label-primary)"
		};
		const btnStyle = {
			padding: "6px 12px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "6px",
			background: "transparent",
			color: "inherit",
			font: "inherit",
			cursor: "pointer",
			whiteSpace: "nowrap"
		};
		//#endregion
		//#region index.tsx
		const name = "dsh-rag-kb";
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.settings"
		];
		const NS = "dsh-rag-kb";
		const zh = { tab: "知识库" };
		const en = { tab: "Knowledge" };
		function apply(ctx) {
			ctx.effect(() => {
				try {
					ctx.locale.register(NS, {
						zh,
						en
					});
				} catch {}
				const t = (key) => zh[key] ?? String(key);
				const face = {
					describe: async () => {
						const response = await ctx.remote.settings.describe();
						return response.ok && response.value !== void 0 ? { namespaces: response.value.namespaces } : { error: response.error?.message ?? "settings.describe failed" };
					},
					mutate: async (ns, ops, revision) => {
						const response = await ctx.remote.settings.mutate(ns, ops, revision);
						return response.ok ? { ok: true } : {
							ok: false,
							error: response.error?.message ?? "settings.mutate failed"
						};
					}
				};
				const offTab = ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
					name: "settings.plugins.tab",
					id: "rag-kb",
					order: 50,
					label: () => t("tab"),
					locale: NS,
					inject: () => ({ face })
				}, KbSettingsTab));
				return () => {
					offTab();
				};
			}, "dsh-rag-kb: settings tab");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map