import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type CompactionFailureData, isCompactionFailureEntry } from "../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
};

function failureRecords(harness: Harness): CompactionFailureData[] {
	return harness.sessionManager.getBranch().flatMap((entry) => (isCompactionFailureEntry(entry) ? [entry.data] : []));
}

function useFailingSummarizer(harness: Harness): () => number {
	let calls = 0;
	harness.session.agent.streamFunction = () => {
		calls++;
		throw new Error("summarizer down");
	};
	return () => calls;
}

function appendUser(harness: Harness, text: string): void {
	harness.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
}

/** Append one tool turn whose usage reports `totalTokens`, then run the post-turn threshold check. */
async function toolTurn(harness: Harness, totalTokens: number): Promise<void> {
	const model = harness.getModel();
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("tool turn output"),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	await (harness.session as unknown as SessionWithCompactionInternals)._checkCompaction(assistant);
}

async function createBackoffHarness(): Promise<Harness> {
	const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1, reserveTokens: 40_000 } } });
	appendUser(harness, "long task");
	return harness;
}

describe("threshold compaction back-off", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("retries only after growth and pauses after three failures", async () => {
		const harness = await createBackoffHarness();
		harnesses.push(harness);
		const calls = useFailingSummarizer(harness);
		const window = harness.getModel().contextWindow;
		const growth = Math.max(8192, 0.05 * window);
		let tokens = window - 38_000;

		await toolTurn(harness, tokens);
		expect(calls()).toBe(1);

		// Small growth: no retry.
		for (let i = 0; i < 5; i++) await toolTurn(harness, tokens + 1000 * (i + 1));
		expect(calls()).toBe(1);

		tokens += growth;
		await toolTurn(harness, tokens);
		expect(calls()).toBe(2);
		tokens += growth;
		await toolTurn(harness, tokens);
		expect(calls()).toBe(3);
		expect(failureRecords(harness).map((record) => record.attempt)).toEqual([1, 2, 3]);
		expect(harness.session.compactionBackoff).toMatchObject({ consecutiveFailures: 3, paused: true });

		// Paused: no summarization while the context grows below the window (overflow is not gated).
		for (let i = 0; i < 2; i++) {
			tokens += growth;
			await toolTurn(harness, tokens);
		}
		expect(calls()).toBe(3);
	});

	it("resets after a user message", async () => {
		const harness = await createBackoffHarness();
		harnesses.push(harness);
		const calls = useFailingSummarizer(harness);
		const window = harness.getModel().contextWindow;
		await toolTurn(harness, window - 1000);
		await toolTurn(harness, window - 900);
		expect(calls()).toBe(1);

		appendUser(harness, "continue");
		expect(harness.session.compactionBackoff.consecutiveFailures).toBe(0);
		await toolTurn(harness, window - 800);
		expect(calls()).toBe(2);
	});

	it("resets after a successful manual compaction", async () => {
		const harness = await createBackoffHarness();
		harnesses.push(harness);
		const calls = useFailingSummarizer(harness);
		const window = harness.getModel().contextWindow;
		await toolTurn(harness, window - 1000);
		expect(calls()).toBe(1);
		expect(harness.session.compactionBackoff.consecutiveFailures).toBe(1);

		harness.session.agent.streamFunction = (model) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					...fauxAssistantMessage("summary"),
					api: model.api,
					provider: model.provider,
					model: model.id,
				};
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		await harness.session.compact();
		expect(harness.session.compactionBackoff.consecutiveFailures).toBe(0);
		expect(calls()).toBe(1);
	});

	it("stays paused when a session resumes from the same file", async () => {
		const first = await createBackoffHarness();
		harnesses.push(first);
		const firstCalls = useFailingSummarizer(first);
		const window = first.getModel().contextWindow;
		const growth = Math.max(8192, 0.05 * window);
		for (let i = 0; i < 3; i++) await toolTurn(first, window - 38_000 + i * growth);
		expect(firstCalls()).toBe(3);

		const resumed = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 40_000 } },
			sessionManager: first.sessionManager,
		});
		harnesses.push(resumed);
		const resumedCalls = useFailingSummarizer(resumed);
		expect(resumed.session.compactionBackoff.paused).toBe(true);
		await toolTurn(resumed, window - 1000);
		expect(resumedCalls()).toBe(0);
	});
});
