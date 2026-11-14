/* The agent loop: stream a model round, run any tool calls the model chose,
   feed results back, repeat until the model answers. */
import { groundingSources, streamRound, thinkingConfig } from '../lib/vertex.js';

const MAX_ROUNDS = 30;

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason || Object.assign(new Error("Generation stopped."), { name: "AbortError" });
}

export async function runAgent({ model, thinking, simple = false, contents, systemInstruction, toolbox, writer, send, signal, temperature = 0.9 }) {
  const messages = contents.slice();
  const sources = new Map();
  let searchSuggestionHtml = '';
  let text = '';
  let usage = null;
  const currentModel = model;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    throwIfAborted(signal);
    let separatorPending = text.length > 0;
    const result = await streamRound({
      model: currentModel,
      contents: messages,
      systemInstruction,
      tools: simple ? [] : toolbox.geminiTools(),           // small talk needs no tools, which makes the reply start faster
      config: { ...thinkingConfig(currentModel, thinking, { minimal: simple && round === 0 }), temperature },
      signal,
      onText: delta => {
        if (separatorPending) { delta = '\n\n' + delta.replace(/^\s+/, ''); separatorPending = false; }
        text += delta;
        writer.appendText(delta);
        send({ type: 'chunk', text: delta });
      }
    });
    throwIfAborted(signal);
    if (result.usage) usage = result.usage;

    for (const source of groundingSources(result.grounding, 12)) sources.set(source.uri, source);
    if (result.grounding?.searchEntryPoint?.renderedContent) searchSuggestionHtml = result.grounding.searchEntryPoint.renderedContent;
    if (sources.size) {
      const list = [...sources.values()].slice(0, 12);
      writer.update({ sources: list });
      send({ type: 'grounding', sources: list, searchSuggestionHtml });
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
