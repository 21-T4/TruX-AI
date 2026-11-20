/* The agent loop: stream a model round, run any tool calls the model chose,
   feed results back, repeat until the model answers. */
import { groundingSources, streamRound, thinkingConfig } from '../lib/vertex.js';

const MAX_ROUNDS = 30;

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason || Object.assign(new Error("Generation stopped."), { name: "AbortError" });
}

export async function runAgent({ model, thinking, simple = false, contents, systemInstruction, toolbox, writer, send, signal, temperature = 0.9, onUsage = null, client = null }) {
  const messages = contents.slice();
  const sources = new Map();
  let searchSuggestionHtml = '';
  let text = '';
  /* Token totals across every round of the turn. Thinking tokens are counted separately from the visible output. */
  const usage = { promptTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0 };
  const currentModel = model;
  let toolsOff = false;        // set when the model refused every tool setup; the rest of the turn is plain text
  let repairs = 0;             // retries after a malformed tool call
  let repairNote = '';
  let emptyRetries = 0;        // rounds that ended with no visible answer (the budget went into reasoning)
  let thoughtSeparator = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    throwIfAborted(signal);
    let separatorPending = text.length > 0;
    const result = await streamRound({
      model: currentModel,
      contents: messages,
      systemInstruction: repairNote ? systemInstruction + '\n\n' + repairNote : systemInstruction,
      tools: simple || toolsOff ? [] : toolbox.geminiTools(),           // small talk needs no tools, which makes the reply start faster
      fallbackTools: simple || toolsOff ? null : toolbox.geminiTools({ searchAsFunction: true }),
      config: { ...thinkingConfig(currentModel, emptyRetries ? 'low' : thinking, { minimal: simple && round === 0 && !emptyRetries }), temperature },
      signal,
      client,
      /* Thinking summaries are streamed to the thinking bar and stored on their own; they never join the answer. */
      onThought: delta => {
        if (thoughtSeparator) { delta = '\n\n' + delta.replace(/^\s+/, ''); thoughtSeparator = false; }
        writer.appendThinking(delta);
        send({ type: 'thinking', text: delta });
      },
      onText: delta => {
        if (separatorPending) { delta = '\n\n' + delta.replace(/^\s+/, ''); separatorPending = false; }
        text += delta;
        writer.appendText(delta);
        send({ type: 'chunk', text: delta });
      }
    });
    throwIfAborted(signal);
    if (result.degraded === 'functions-only') toolbox.searchAsFunction = true;      // Google Search stays available as a function
    if (result.degraded === 'no-tools') toolsOff = true;
    if (result.usage) {
      const u = result.usage;
      usage.promptTokens += Number(u.promptTokenCount || 0) + Number(u.toolUsePromptTokenCount || 0);
      usage.outputTokens += Number(u.candidatesTokenCount || 0);
      usage.thinkingTokens += Number(u.thoughtsTokenCount || 0);
      usage.totalTokens += Number(u.totalTokenCount || 0);
      onUsage?.({ promptTokens: Number(u.promptTokenCount || 0) + Number(u.toolUsePromptTokenCount || 0), outputTokens: Number(u.candidatesTokenCount || 0), thinkingTokens: Number(u.thoughtsTokenCount || 0) });
    }

    for (const source of groundingSources(result.grounding, 12)) sources.set(source.uri, source);
    if (result.grounding?.searchEntryPoint?.renderedContent) searchSuggestionHtml = result.grounding.searchEntryPoint.renderedContent;
    if (sources.size) {
      const list = [...sources.values()].slice(0, 12);
      writer.update({ sources: list });
      send({ type: 'grounding', sources: list, searchSuggestionHtml });
    }

    /* A tool call the model could not form properly (invalid JSON, wrong tool) is not the user's problem:
       tell the model what went wrong and let it try again, then fall back to answering without tools. */
    if (!result.functionCalls.length && /MALFORMED_FUNCTION_CALL|UNEXPECTED_TOOL_CALL|TOO_MANY_TOOL_CALLS/.test(result.finishReason || '') && !result.text.trim()) {
      repairs++;
      if (repairs > 3) throw Object.assign(new Error('TruX could not finish that tool step. Please try again, or rephrase the request.'), { status: 422 });
      if (repairs === 3) toolsOff = true;
      repairNote = toolsOff
        ? 'NOTE: tools are unavailable for the rest of this answer. Answer in plain text using what you already know and the results so far; do not attempt tool calls.'
        : 'NOTE: your previous tool call was malformed and was not run. Call the tool again using exactly the declared name and one valid JSON object of arguments that matches its schema (all required fields, correct types, no extra keys, no prose in values), or answer without a tool.';
      send({ type: 'status', status: 'Retrying that step…' });
      continue;
    }
    repairNote = '';
    thoughtSeparator = true;

    /* The model used its whole budget thinking and wrote nothing: ask once or twice more with light thinking
       instead of storing an empty answer. */
    if (!result.functionCalls.length && !text.trim() && !result.text.trim() && !writer.state.media.length && emptyRetries < 2 && !signal?.aborted) {
      emptyRetries++;
      repairNote = 'NOTE: your previous attempt ended without a visible answer. Think only briefly, then write your final answer to the user right away.';
      send({ type: 'status', status: 'Finishing the answer…' });
      continue;
    }

    if (!result.functionCalls.length || !result.modelContent) {
      if (!text && result.finishReason && result.finishReason !== 'STOP') {
        throw Object.assign(new Error(result.finishReason === 'SAFETY' ? 'The response was blocked by safety filters.' : 'The model stopped early (' + result.finishReason + ').'), { status: 422 });
      }
      break;
    }

    messages.push(result.modelContent);
    const responses = await Promise.all(result.functionCalls.map(async (call, index) => {
      const id = `${round}-${index}-${call.name}`;
      const label = toolbox.label(call);
      writer.setTool(id, label, 'running');
      send({ type: 'tool_status', id, tool: call.name, label, phase: 'start' });
      let response;
      let parts = [];
      try {
        ({ response, parts = [] } = await toolbox.run(call, signal));
        writer.setTool(id, label, response?.ok === false || response?.success === false ? 'error' : 'done');
        send({ type: 'tool_status', id, tool: call.name, label, phase: 'complete', ok: response?.ok !== false && response?.success !== false });
      } catch (error) {
        if (signal.aborted) throw error;
        response = { ok: false, error: String(error?.message || 'Tool failed').slice(0, 500) };
        writer.setTool(id, label, 'error');
        send({ type: 'tool_status', id, tool: call.name, label, phase: 'complete', ok: false });
      }
      // Gemini 3 accepts images inside function responses (e.g. browser screenshots).
      return { functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response: { output: response }, ...(parts.length ? { parts } : {}) } };
    }));
    throwIfAborted(signal);
    messages.push({ role: 'user', parts: responses });
  }

  return { text, sources: [...sources.values()], usage, model: currentModel };
}
