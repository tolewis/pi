import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	COMPACTION_FAILURE_CUSTOM_TYPE,
	CompactionModelUnavailableError,
	SUMMARY_OUTPUT_ALLOWANCE_TOKENS,
} from "../../src/core/compaction/index.ts";
import type { SessionBeforeCompactEvent } from "../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "./harness.ts";

function seedHistory(harness: Harness, totalTokens = 650): string {
	const model = harness.session.model!;
	let recentUserId = "";
	for (const label of ["old", "recent"]) {
		recentUserId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: label.padEnd(400, "x") }],
			timestamp: Date.now() - 2000,
		});
		const assistant = fauxAssistantMessage(label.padEnd(400, "y"), { timestamp: Date.now() - 1000 });
		harness.sessionManager.appendMessage({
			...assistant,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { ...assistant.usage, input: totalTokens, totalTokens },
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return recentUserId;
}

function failureRecords(harness: Harness): unknown[] {
	return harness.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === COMPACTION_FAILURE_CUSTOM_TYPE ? [entry.data] : [],
		);
}

/** The context is unchanged: entries added after `count` are only compaction failure records. */
function expectOnlyFailureRecordsAfter(harness: Harness, count: number): void {
	const added = harness.sessionManager.getEntries().slice(count);
	expect(added.length).toBeGreaterThan(0);
	for (const entry of added) {
		expect(entry).toMatchObject({ type: "custom", customType: COMPACTION_FAILURE_CUSTOM_TYPE });
	}
}

// Regression coverage for #8133.
describe("AgentSession compaction model overrides", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it.each(["manual", "pre-prompt", "post-run", "overflow"] as const)(
		"uses model token settings for %s compaction and extension preparation",
		async (path) => {
			const preparations: SessionBeforeCompactEvent[] = [];
			const harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 4000 }],
				tools: [],
				settings: {
					compaction: {
						enabled: path !== "manual",
						reserveTokens: 10,
						keepRecentTokens: 20000,
						modelOverrides: { "faux/faux-1": { reserveTokens: 2000, keepRecentTokens: 150 } },
					},
				},
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => {
							preparations.push(event);
							return {
								compaction: {
									summary: "compacted history",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				],
			});
			harnesses.push(harness);
			const recentUserId = seedHistory(harness, path === "pre-prompt" ? 2500 : 650);

			if (path === "manual") {
				await harness.session.compact();
			} else {
				harness.setResponses(
					path === "overflow"
						? [
								fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
								fauxAssistantMessage("recovered"),
							]
						: [fauxAssistantMessage(path === "post-run" ? "z".repeat(8000) : "done")],
				);
				await harness.session.prompt("continue");
			}

			expect(preparations).toHaveLength(1);
			expect(preparations[0]?.preparation.settings).toEqual({
				enabled: path !== "manual",
				reserveTokens: 2000,
				keepRecentTokens: 150,
			});
			expect(preparations[0]?.reason).toBe(
				path === "manual" ? "manual" : path === "overflow" ? "overflow" : "threshold",
			);
			if (path === "manual" || path === "pre-prompt") {
				expect(preparations[0]?.preparation.firstKeptEntryId).toBe(recentUserId);
			}
			expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
			expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
				aborted: false,
				willRetry: path === "overflow",
				result: { summary: "compacted history" },
			});
			expect(harness.getPendingResponseCount()).toBe(0);
		},
	);

	it("uses the newly selected model without changing ordinary settings", async () => {
		const harness = await createHarness({
			models: [
				{ id: "small", contextWindow: 4000 },
				{ id: "big", contextWindow: 10000 },
			],
			tools: [],
			settings: {
				compaction: {
					reserveTokens: 10,
					modelOverrides: { "faux/big": { reserveTokens: 8000, keepRecentTokens: 150 } },
				},
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "big model summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedHistory(harness, 2500);
		harness.setResponses([fauxAssistantMessage("small response"), fauxAssistantMessage("big response")]);
		await harness.session.prompt("continue on small");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		// Retain usage from the small model: the next check must use the active big model's policy.
		seedHistory(harness, 2500);
		await harness.session.setModel(harness.getModel("big")!);
		await harness.session.prompt("continue on big");
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")[0]?.result?.summary).toBe("big model summary");
		expect(harness.settingsManager.getCompactionReserveTokens()).toBe(10);
		await harness.session.setModel(harness.getModel("small")!);
		expect(harness.settingsManager.getCompactionReserveTokens(harness.session.model)).toBe(10);
	});

	it("captures model identity before awaiting summarization auth", async () => {
		const harness = await createHarness({
			models: [{ id: "first" }, { id: "second" }],
			settings: {
				compaction: {
					modelOverrides: {
						"faux/first": { reserveTokens: 2000, keepRecentTokens: 150 },
						"faux/second": { reserveTokens: 4000, keepRecentTokens: 20000 },
					},
				},
			},
		});
		harnesses.push(harness);
		seedHistory(harness);
		const getAuth = harness.session.modelRuntime.getAuth.bind(harness.session.modelRuntime);
		vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementation(async (model, ...args) => {
			harness.session.agent.state.model = harness.getModel("second")!;
			return getAuth(model, ...args);
		});
		const requests: string[] = [];
		harness.setResponses([
			(_context, _options, _state, model) => {
				requests.push(model.id);
				return fauxAssistantMessage("summary");
			},
		]);
		await harness.session.compact();
		expect(requests).toEqual(["first"]);
	});

	describe("compaction summarizer model and thinking level", () => {
		type SummaryRequest = { modelId: string; reasoning: unknown };

		async function compactWith(settings: Record<string, unknown>, sessionThinking: "low" | "medium") {
			const harness = await createHarness({
				models: [
					{ id: "faux-1", reasoning: true },
					{ id: "faux-summary", reasoning: true },
				],
				settings: { compaction: { keepRecentTokens: 150, ...settings } },
			});
			harnesses.push(harness);
			harness.session.agent.state.thinkingLevel = sessionThinking;
			seedHistory(harness);
			const requests: SummaryRequest[] = [];
			harness.setResponses([
				(_context, options, _state, model) => {
					requests.push({ modelId: model.id, reasoning: options?.reasoning });
					return fauxAssistantMessage("summary");
				},
			]);
			return { harness, requests };
		}

		it("model override thinkingLevel beats the global compaction.thinkingLevel", async () => {
			const { harness, requests } = await compactWith(
				{
					model: "faux-summary",
					thinkingLevel: "low",
					modelOverrides: { "faux/faux-1": { thinkingLevel: "high" } },
				},
				"medium",
			);
			await harness.session.compact();
			expect(requests).toEqual([{ modelId: "faux-summary", reasoning: "high" }]);
		});

		it("model override can select the compaction model", async () => {
			const { harness, requests } = await compactWith(
				{ modelOverrides: { "faux/faux-1": { model: "faux-summary", thinkingLevel: "off" } } },
				"medium",
			);
			await harness.session.compact();
			expect(requests).toEqual([{ modelId: "faux-summary", reasoning: undefined }]);
		});

		it("global thinkingLevel applies without a model override", async () => {
			const { harness, requests } = await compactWith({ model: "faux-summary", thinkingLevel: "low" }, "medium");
			await harness.session.compact();
			expect(requests).toEqual([{ modelId: "faux-summary", reasoning: "low" }]);
		});

		it("unset thinkingLevel inherits the session thinking level", async () => {
			const { harness, requests } = await compactWith({}, "low");
			await harness.session.compact();
			expect(requests).toEqual([{ modelId: "faux-1", reasoning: "low" }]);
		});

		it("fails loudly when the configured model is missing and leaves the context unchanged", async () => {
			const { harness, requests } = await compactWith({ model: "missing-model" }, "medium");
			const entriesBefore = harness.sessionManager.getEntries().length;
			const error = await harness.session.compact().catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CompactionModelUnavailableError);
			expect((error as CompactionModelUnavailableError).code).toBe("compaction_model_unavailable");
			expect((error as Error).message).toMatch(/^Compaction model faux\/missing-model is not available: /);
			expect(failureRecords(harness)).toEqual([
				expect.objectContaining({
					trigger: "manual",
					outcome: "error",
					reason: "compaction_model_unavailable",
					model: "faux/missing-model",
				}),
			]);
			expectOnlyFailureRecordsAfter(harness, entriesBefore);
			expect(requests).toEqual([]);
		});

		it("records a missing configured model on automatic compaction", async () => {
			const { harness, requests } = await compactWith({ model: "missing-model" }, "medium");
			const entriesBefore = harness.sessionManager.getEntries().length;
			const sessionInternals = harness.session as unknown as {
				_runAutoCompaction(reason: "threshold", willRetry: boolean): Promise<boolean>;
			};
			await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(false);
			expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toBe(
				"Auto-compaction failed: Compaction model faux/missing-model is not available: not found in the model registry. Check compaction.provider and compaction.model in your settings.",
			);
			expect(failureRecords(harness)).toHaveLength(1);
			expect(failureRecords(harness)[0]).toMatchObject({
				trigger: "threshold",
				outcome: "error",
				reason: "compaction_model_unavailable",
				model: "faux/missing-model",
			});
			expectOnlyFailureRecordsAfter(harness, entriesBefore);
			expect(requests).toEqual([]);
			expect(harness.getPendingResponseCount()).toBe(1);
		});

		it("fails loudly when the configured model has no auth instead of using the session model", async () => {
			const { harness, requests } = await compactWith({ model: "faux-summary" }, "medium");
			const getAuth = harness.session.modelRuntime.getAuth.bind(harness.session.modelRuntime);
			vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementation(async (model, ...args) =>
				model.id === "faux-summary" ? undefined : getAuth(model, ...args),
			);
			const entriesBefore = harness.sessionManager.getEntries().length;
			await expect(harness.session.compact()).rejects.toThrow(
				/^Compaction model faux\/faux-summary is not available: /,
			);
			expectOnlyFailureRecordsAfter(harness, entriesBefore);
			expect(requests).toEqual([]);
		});
	});

	describe("compaction model window-fit guard", () => {
		async function setup(summaryWindow: number) {
			const harness = await createHarness({
				models: [
					{ id: "faux-1", contextWindow: 200000 },
					{ id: "faux-small", contextWindow: summaryWindow },
				],
				settings: { compaction: { keepRecentTokens: 150, model: "faux-small" } },
			});
			harnesses.push(harness);
			seedHistory(harness);
			const requests: string[] = [];
			harness.setResponses([
				(_context, _options, _state, model) => {
					requests.push(model.id);
					return fauxAssistantMessage("summary");
				},
			]);
			return { harness, requests, records: () => failureRecords(harness) };
		}

		it("runs the session model and records a fallback when the input does not fit", async () => {
			const { harness, requests, records } = await setup(SUMMARY_OUTPUT_ALLOWANCE_TOKENS);
			const result = await harness.session.compact();
			expect(requests).toEqual(["faux-1"]);
			expect(records()).toHaveLength(1);
			expect(records()[0]).toMatchObject({
				trigger: "manual",
				outcome: "fallback",
				reason: "compaction_model_window",
				model: "faux/faux-small",
				contextWindow: SUMMARY_OUTPUT_ALLOWANCE_TOKENS,
				tokensBefore: result.tokensBefore,
				errorMessage: expect.stringMatching(
					new RegExp(`^\\d+ \\+ ${SUMMARY_OUTPUT_ALLOWANCE_TOKENS} > ${SUMMARY_OUTPUT_ALLOWANCE_TOKENS}$`),
				),
			});
		});

		it("uses the compaction model and records nothing when the input fits", async () => {
			const { harness, requests, records } = await setup(SUMMARY_OUTPUT_ALLOWANCE_TOKENS + 4096);
			await harness.session.compact();
			expect(requests).toEqual(["faux-small"]);
			expect(records()).toEqual([]);
		});

		it("applies the guard on threshold compaction", async () => {
			const { harness, requests, records } = await setup(SUMMARY_OUTPUT_ALLOWANCE_TOKENS);
			const sessionInternals = harness.session as unknown as {
				_runAutoCompaction(reason: "threshold", willRetry: boolean): Promise<boolean>;
			};
			await sessionInternals._runAutoCompaction("threshold", false);
			expect(requests).toEqual(["faux-1"]);
			expect(records()).toHaveLength(1);
			expect(records()[0]).toMatchObject({
				trigger: "threshold",
				outcome: "fallback",
				reason: "compaction_model_window",
			});
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		});
	});
});
