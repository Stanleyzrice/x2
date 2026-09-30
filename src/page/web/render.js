// 在浏览器里把 page 的声明（window.X2_PAGE）画出来。纯 JS，不用框架、不用编译。
// ask：window.X2_ANSWER 是交答案的地址，提交时 POST { submitted, values }
(() => {
	const page = window.X2_PAGE;
	const root = document.getElementById("root");
	const h = (tag, attrs = {}, ...kids) => {
		const el = document.createElement(tag);
		for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : String(v));
		for (const k of kids.flat()) if (k !== null && k !== undefined) el.append(k instanceof Node ? k : String(k));
		return el;
	};
	// 取答案的函数，一块一个
	const readers = {};

	const inputEl = (input, value) => {
		if (input.type === "select") {
			const s = h("select", {}, h("option", { value: "" }, "—"), ...input.options.map((o) => h("option", { value: o.value, selected: String(value ?? "") === o.value }, o.label)));
			return s;
		}
		return h("input", { type: input.type === "number" ? "number" : input.type === "url" ? "url" : "text", value: value ?? "", placeholder: input.placeholder });
	};
	const valueOf = (el, input) => (input.type === "number" ? (el.value === "" ? null : Number(el.value)) : el.value === "" ? null : el.value);

	const cell = (col, v) => {
		if (col.show === "image") return v ? h("img", { src: v, loading: "lazy" }) : "";
		if (col.show === "link") return v ? h("a", { href: v, target: "_blank" }, v) : "";
		return v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
	};

	const table = (b) => {
		const rows = b.rows ?? [];
		const inputs = rows.map(() => ({}));
		const checks = [];
		const head = h("tr", {}, b.select ? h("th", {}, "") : null, ...b.columns.map((c) => h("th", {}, c.label)));
		const body = rows.map((r, i) => h("tr", {},
			b.select ? h("td", {}, (checks[i] = h("input", { type: "checkbox", checked: r._selected === true }))) : null,
			...b.columns.map((c) => h("td", { class: c.input ? "in" : c.show === "image" ? "img" : "" }, c.input ? (inputs[i][c.key] = inputEl(c.input, r[c.key])) : cell(c, r[c.key]))),
		));
		if (b.id) readers[b.id] = () => rows.map((r, i) => ({
			...r,
			...Object.fromEntries(b.columns.filter((c) => c.input).map((c) => [c.key, valueOf(inputs[i][c.key], c.input)])),
			...(b.select ? { _selected: checks[i].checked } : {}),
		}));
		return h("div", { class: "scroll" }, h("table", {}, h("thead", {}, head), h("tbody", {}, rows.length ? body : h("tr", {}, h("td", { colspan: b.columns.length + (b.select ? 1 : 0), class: "empty" }, "没有")))));
	};

	const choice = (b) => {
		const name = `c-${b.id}`;
		const boxes = b.options.map((o) => {
			const box = h("input", { type: b.multiple ? "checkbox" : "radio", name, value: o.value });
			return { o, box, el: h("label", { class: "opt" }, box, o.image ? h("img", { src: o.image, loading: "lazy" }) : null, h("span", {}, o.label, o.note ? h("small", {}, o.note) : null)) };
		});
		readers[b.id] = () => (b.multiple ? boxes.filter((x) => x.box.checked).map((x) => x.o.value) : boxes.find((x) => x.box.checked)?.o.value ?? null);
		return h("fieldset", {}, h("legend", {}, b.label), h("div", { class: "opts" }, boxes.map((x) => x.el)));
	};

	// 点一下看大图（class zoom 的图）；再点一下关掉
	const zoom = (src) => {
		const layer = h("div", { class: "lightbox" }, h("img", { src }));
		layer.onclick = () => layer.remove();
		document.body.append(layer);
	};
	const zoomable = (src, cls) => {
		const img = h("img", { src, class: `zoom ${cls}`, loading: "lazy" });
		img.onclick = () => zoom(img.src);
		return img;
	};

	const variants = (b) => {
		const picked = {};
		const matches = (o, sel) => o.attrs.every((v, i) => sel[i] === null || sel[i] === v);
		const rows = b.rows.map((r) => {
			let sel = b.options.find((o) => o.value === r.value)?.attrs.slice() ?? b.attrs.map(() => null);
			let cleared = !r.value && b.attrs.length === 0;
			const theirs = h("div", { class: "big empty" });
			const result = h("div", { class: "result" });
			const chips = b.attrs.map((a, i) => a.values.map((v) => {
				const chip = h("button", { type: "button", class: v.image ? "chip swatch" : "chip", title: v.name }, v.image ? h("img", { src: v.image, loading: "lazy" }) : null, h("span", {}, v.name));
				chip.onclick = () => { sel[i] = sel[i] === v.name ? null : v.name; cleared = false; update(); };
				return { i, v, chip };
			}));
			const none = h("button", { type: "button", class: "none" }, "都不对");
			none.onclick = () => { sel = b.attrs.map(() => null); cleared = true; update(); };
			const update = () => {
				const full = sel.every((v) => v !== null);
				const o = cleared ? undefined : full ? b.options.find((x) => x.attrs.every((v, i) => v === sel[i])) : undefined;
				picked[r.key] = o?.value ?? null;
				const img = o?.image ?? b.attrs[0]?.values.find((v) => v.name === sel[0])?.image;
				theirs.replaceChildren(img ? zoomable(img, "") : "");
				theirs.className = img ? "big" : "big empty";
				result.replaceChildren(o ? h("span", {}, h("b", {}, o.label || "（单规格）"), o.note ? ` · ${o.note}` : "")
					: h("span", { class: "muted" }, cleared ? "都不对：这一行不记" : full ? "1688 没有这个组合" : "还没选完"));
				for (const { i, v, chip } of chips.flat()) {
					chip.classList.toggle("on", sel[i] === v.name);
					// 和别的属性已选的值组不成规格的，淡一些
					chip.classList.toggle("off", !b.options.some((x) => x.attrs[i] === v.name && matches(x, sel.map((s, j) => (j === i ? null : s)))));
				}
			};
			update();
			return h("div", { class: "vrow" },
				r.image ? zoomable(r.image, "big") : h("div", { class: "big empty" }),
				theirs,
				h("div", { class: "vpick" },
					h("div", { class: "vlabel" }, r.label, r.note ? h("small", {}, r.note) : null),
					...b.attrs.map((a, i) => h("div", { class: "attr" }, h("span", { class: "aname" }, a.name), h("div", { class: "chips" }, chips[i].map((c) => c.chip)))),
					h("div", { class: "vfoot" }, result, none),
				),
			);
		});
		readers[b.id] = () => ({ ...picked });
		return h("div", { class: "variants" }, rows);
	};

	const block = (b) => {
		if (b.type === "heading") return h("h2", {}, b.text);
		if (b.type === "text") return h("p", { class: "text" }, b.text);
		if (b.type === "image") return h("figure", {}, h("img", { src: b.src }), b.caption ? h("figcaption", {}, b.caption) : null);
		if (b.type === "table") return table(b);
		if (b.type === "input") { const el = inputEl(b.input, b.value); readers[b.id] = () => valueOf(el, b.input); return h("label", { class: "field" }, h("span", {}, b.label), el); }
		if (b.type === "choice") return choice(b);
		if (b.type === "variants") return variants(b);
		return h("pre", {}, JSON.stringify(b));
	};

	document.title = page.title;
	root.append(h("h1", {}, page.title), ...page.blocks.map(block));

	if (page.submit && window.X2_ANSWER) {
		const done = (submitted) => async () => {
			const values = Object.fromEntries(Object.entries(readers).map(([k, f]) => [k, f()]));
			bar.replaceChildren(h("span", { class: "sent" }, "已交回，可以关掉这一页"));
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
