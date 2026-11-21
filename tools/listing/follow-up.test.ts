import assert from "node:assert/strict";
import test from "node:test";
import { markFollowUpBatch } from "./follow-up.ts";

test("one logical follow-up batch spans all cheeroutdoor items in a publish request", () => {
	const plan = [
		[
			{ op: "建商品", params: { shop: "cheeroutdoor" } },
			{ op: "上架", params: { shop: "cheeroutdoor", listingId: "1" } },
		],
		[{ op: "上架", params: { shop: "cheeroutdoor", listingId: "2" } }],
		[{ op: "上架", params: { shop: "ni1206" } }],
	];
	const id = "7327441b-41eb-4276-8ec3-ab80311a432f";
	assert.deepEqual(markFollowUpBatch(plan, id), [
		[plan[0]?.[0], { op: "上架", params: { shop: "cheeroutdoor", listingId: "1", trackingBatch: id } }],
		[{ op: "上架", params: { shop: "cheeroutdoor", listingId: "2", trackingBatch: id } }],
		plan[2],
	]);
	assert.deepEqual(plan[1]?.[0]?.params, { shop: "cheeroutdoor", listingId: "2" });
});
