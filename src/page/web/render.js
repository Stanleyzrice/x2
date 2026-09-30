// 在浏览器里把 page 的声明（window.X2_PAGE）画出来。纯 JS，不用框架、不用编译。
// ask：window.X2_ANSWER 是交答案的地址，提交时 POST { submitted, values }
// 写法统一：每个组件是一个函数，拿声明返回一个元素；有 id 的组件用 answer() 登记取答案的函数。
// 样式只用 style.css 的 token 和三个共用的类：.card（框）、.pick（可以选的东西：.on 选中、.off 选不了）、.label（小号灰字）
(() => {
	const page = window.X2_PAGE;
	const root = document.getElementById("root");
	const h = (tag, attrs = {}, ...kids) => {
		const el = document.createElement(tag);
		for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : String(v));
		for (const k of kids.flat()) if (k !== null && k !== undefined) el.append(k instanceof Node ? k : String(k));
		return el;
	};

	// 取答案的函数，一个 id 一个
	const readers = {};
	const answer = (id, read) => { if (id) readers[id] = read; };

	// 图片：三档大小（sm、md、lg）；点一下看大图，再点一下关掉。zoom: false 的图点了交给外面（例 规格的图块点了是选它）
	const img = (src, size, { zoom = true } = {}) => {
		if (!src) return h("div", { class: `img ${size} empty` });
		const el = h("img", { src, class: `img ${size}${zoom ? " zoom" : ""}`, loading: "lazy", alt: "" });
		if (zoom) el.onclick = (e) => {
			e.stopPropagation();
			const layer = h("div", { class: "lightbox" }, h("img", { src }));
			layer.onclick = () => layer.remove();
			document.body.append(layer);
		};
		return el;
	};

	const inputEl = (input, value) => {
		if (input.type === "select") return h("select", {}, h("option", { value: "" }, "—"), ...input.options.map((o) => h("option", { value: o.value, selected: String(value ?? "") === o.value }, o.label)));
		return h("input", { type: input.type === "number" ? "number" : input.type === "url" ? "url" : "text", value: value ?? "", placeholder: input.placeholder });
	};
	const valueOf = (el, input) => (el.value === "" ? null : input.type === "number" ? Number(el.value) : el.value);

	const cell = (col, v) => {
		if (col.show === "image") return img(v, "sm");
		if (col.show === "link") return v ? h("a", { href: v, target: "_blank" }, v) : "";
		return v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
	};

	const heading = (b) => h("h2", {}, b.text);

	const text = (b) => h("p", { class: "text" }, b.text);

	const image = (b) => h("figure", {}, img(b.src, "lg"), b.caption ? h("figcaption", { class: "label" }, b.caption) : null);

	const table = (b) => {
		const rows = b.rows ?? [];
		const inputs = rows.map(() => ({}));
		const checks = [];
		const head = h("tr", {}, b.select ? h("th", { class: "label" }) : null, ...b.columns.map((c) => h("th", { class: "label" }, c.label)));
		const body = rows.map((r, i) => h("tr", {},
			b.select ? h("td", {}, (checks[i] = h("input", { type: "checkbox", checked: r._selected === true }))) : null,
			...b.columns.map((c) => h("td", {}, c.input ? (inputs[i][c.key] = inputEl(c.input, r[c.key])) : cell(c, r[c.key]))),
		));
		answer(b.id, () => rows.map((r, i) => ({
			...r,
			...Object.fromEntries(b.columns.filter((c) => c.input).map((c) => [c.key, valueOf(inputs[i][c.key], c.input)])),
			...(b.select ? { _selected: checks[i].checked } : {}),
		})));
		const empty = h("tr", {}, h("td", { colspan: b.columns.length + (b.select ? 1 : 0), class: "empty label" }, "没有"));
		return h("div", { class: "scroll" }, h("table", {}, h("thead", {}, head), h("tbody", {}, rows.length ? body : empty)));
	};

	const input = (b) => {
		const el = inputEl(b.input, b.value);
		answer(b.id, () => valueOf(el, b.input));
		return h("label", { class: "field" }, h("span", { class: "label" }, b.label), el);
	};

	// 选项是一张张卡片：点卡片选中，单选时再点一下取消；卡片上的图点了是看大图
	const choice = (b) => {
		const on = new Set();
		const cards = b.options.map((o) => {
			const el = h("button", { type: "button", class: "pick card opt" }, o.image ? img(o.image, "md") : null, h("span", {}, o.label, o.note ? h("small", { class: "label" }, o.note) : null));
			el.onclick = () => {
				const was = on.has(o.value);
				if (!b.multiple) on.clear();
				was ? on.delete(o.value) : on.add(o.value);
				for (const c of cards) c.el.classList.toggle("on", on.has(c.o.value));
			};
			return { o, el };
		});
		answer(b.id, () => (b.multiple ? [...on] : ([...on][0] ?? null)));
		return h("fieldset", {}, h("legend", { class: "label" }, b.label), h("div", { class: "opts" }, cards.map((c) => c.el)));
	};

	// 每一行选一个规格：属性的取值有图的是图块、没图的是按钮；行的图和选中规格的图并排
	const variants = (b) => {
		const picked = {};
		const fits = (o, sel) => o.attrs.every((v, i) => sel[i] === null || sel[i] === v);
		const rows = b.rows.map((r) => {
			let sel = b.options.find((o) => o.value === r.value)?.attrs.slice() ?? b.attrs.map(() => null);
			let cleared = !r.value && b.attrs.length === 0;
			const theirs = h("div");
			const result = h("div");
			const chips = b.attrs.map((a, i) => a.values.map((v) => {
				const el = h("button", { type: "button", class: v.image ? "pick swatch" : "pick chip", title: v.name }, v.image ? img(v.image, "sm", { zoom: false }) : null, h("span", {}, v.name));
				el.onclick = () => { sel[i] = sel[i] === v.name ? null : v.name; cleared = false; update(); };
				return { i, v, el };
			}));
			const none = h("button", { type: "button" }, "都不对");
			none.onclick = () => { sel = b.attrs.map(() => null); cleared = true; update(); };
			const update = () => {
				const full = sel.every((v) => v !== null);
				const o = cleared || !full ? undefined : b.options.find((x) => x.attrs.every((v, i) => v === sel[i]));
				picked[r.key] = o?.value ?? null;
				theirs.replaceChildren(img(o?.image ?? b.attrs[0]?.values.find((v) => v.name === sel[0])?.image, "lg"));
				result.replaceChildren(o ? h("span", {}, h("b", {}, o.label || "（单规格）"), o.note ? ` · ${o.note}` : "")
					: h("span", { class: "label" }, cleared ? "都不对：这一行不记" : full ? "没有这个组合" : "还没选完"));
				for (const { i, v, el } of chips.flat()) {
					el.classList.toggle("on", sel[i] === v.name);
					// 和别的属性已选的值组不成规格的，淡一些
					el.classList.toggle("off", !b.options.some((x) => x.attrs[i] === v.name && fits(x, sel.map((s, j) => (j === i ? null : s)))));
				}
			};
			update();
			return h("div", { class: "card vrow" },
				img(r.image, "lg"),
				theirs,
				h("div", { class: "vpick" },
					h("div", {}, h("b", {}, r.label), r.note ? h("div", { class: "label" }, r.note) : null),
					...b.attrs.map((a, i) => h("div", { class: "attr" }, h("span", { class: "label" }, a.name), h("div", { class: "opts" }, chips[i].map((c) => c.el)))),
					h("div", { class: "vfoot" }, result, none),
				),
			);
		});
		answer(b.id, () => ({ ...picked }));
		return h("div", { class: "stack" }, rows);
	};

	const components = { heading, text, image, table, input, choice, variants };

	document.title = page.title;
	root.append(h("h1", {}, page.title), ...page.blocks.map((b) => (components[b.type] ?? ((x) => h("pre", {}, JSON.stringify(x))))(b)));

	if (page.submit && window.X2_ANSWER) {
		const done = (submitted) => async () => {
			const values = Object.fromEntries(Object.entries(readers).map(([k, f]) => [k, f()]));
			bar.replaceChildren(h("span", { class: "label" }, "已交回，可以关掉这一页"));
			await fetch(window.X2_ANSWER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ submitted, values }) });
		};
		const ok = h("button", { class: "primary" }, page.submit.label);
		ok.onclick = done(true);
		const cancel = h("button", {}, page.submit.cancel ?? "取消");
		cancel.onclick = done(false);
		const bar = h("div", { class: "bar" }, cancel, ok);
		root.append(bar);
	}
})();
