(() => {
  'use strict';

  const TAG = '[Tool Call Transport]';
  const SETTINGS_KEY = 'tool-call-transport.settings.v1';
  const HOOK = Symbol.for('tool-call-transport.fetch-hook');
  const MAX_CHUNK = 180000;
  const OUTPUT_TOOL = 'deliver_response';
  const OUTPUT_PARAM = 'content';
  const CONTEXT_TOOL = 'read_context';
  const INPUT_TOOL = 'read_current_input';
  const LOG_KEY = 'tool-call-transport.logs.v1';
  const LOG_LIMIT = 50;

  const defaults = {
    enabled: true,
    channel: 'auto',
    contextInTools: true,
    wrapInput: true,
    forceTool: true,
  };

  const settings = loadSettings();
  const runtime = {
    target: null,
    originalFetch: null,
    installed: false,
    lastStatus: '等待请求',
    logs: loadLogs(),
    requestSequence: 0,
  };

  function loadSettings() {
    try {
      return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch {
      return { ...defaults };
    }
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function loadLogs() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(LOG_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.slice(-LOG_LIMIT) : [];
    } catch {
      return [];
    }
  }

  function saveLogs() {
    try {
      sessionStorage.setItem(LOG_KEY, JSON.stringify(runtime.logs));
    } catch {
      // Logging must never block generation.
    }
  }

  function renderLogs() {
    const node = document.querySelector('#tct-settings .tct-log');
    if (!node) return;
    node.textContent = runtime.logs.length
      ? runtime.logs.map(entry => JSON.stringify(entry)).join('\n')
      : '暂无日志';
    node.scrollTop = node.scrollHeight;
  }

  function addLog(level, event, details = {}) {
    const entry = {
      time: new Date().toISOString(),
      level,
      event,
      ...details,
    };
    runtime.logs.push(entry);
    if (runtime.logs.length > LOG_LIMIT) runtime.logs.splice(0, runtime.logs.length - LOG_LIMIT);
    saveLogs();
    renderLogs();
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    console[method](TAG, event, details);
    return entry;
  }

  function setStatus(text) {
    runtime.lastStatus = text;
    const node = document.querySelector('#tct-settings .tct-status');
    if (node) node.textContent = text;
  }

  function errorDetails(error) {
    return {
      name: String(error?.name || 'Error'),
      message: String(error?.message || error || 'Unknown error'),
      stack: typeof error?.stack === 'string' ? error.stack.slice(0, 1600) : '',
    };
  }

  function sourceSummary(body) {
    return {
      source: String(body?.chat_completion_source || ''),
      channel: strategy(body?.chat_completion_source),
      model: String(body?.model || ''),
      messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
      toolCount: Array.isArray(body?.tools) ? body.tools.length : 0,
      stream: body?.stream,
    };
  }

  function textOf(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(part => {
        if (typeof part === 'string') return part;
        return part && typeof part.text === 'string' ? part.text : '';
      }).filter(Boolean).join('\n');
    }
    return String(content);
  }

  function chunkText(text, limit = MAX_CHUNK) {
    const result = [];
    let current = '';
    for (const paragraph of String(text || '').split('\n\n')) {
      if (paragraph.length > limit) {
        if (current) result.push(current);
        current = '';
        for (let i = 0; i < paragraph.length; i += limit) result.push(paragraph.slice(i, i + limit));
      } else if (current && current.length + paragraph.length + 2 > limit) {
        result.push(current);
        current = paragraph;
      } else {
        current = current ? `${current}\n\n${paragraph}` : paragraph;
      }
    }
    if (current) result.push(current);
    return result.length ? result : ['No prior context.'];
  }

  function isGeminiNative(source) {
    return source === 'vertexai' || source === 'makersuite';
  }

  function strategy(source) {
    if (settings.channel === 'native' || settings.channel === 'openai') return settings.channel;
    return isGeminiNative(source) ? 'native' : 'openai';
  }

  function stripUnsupportedPenalties(body) {
    if (!isGeminiNative(body.chat_completion_source)) return;
    delete body.frequency_penalty;
    delete body.presence_penalty;
    delete body.frequencyPenalty;
    delete body.presencePenalty;
  }

  function outputDefinition() {
    return {
      type: 'function',
      function: {
        name: OUTPUT_TOOL,
        description: 'Return the complete assistant response through this function. Put every part of the final response in the content argument. Do not return the response as ordinary message text.',
        parameters: {
          type: 'object',
          properties: {
            [OUTPUT_PARAM]: {
              type: 'string',
              description: 'The complete final assistant response, without omissions.',
            },
          },
          required: [OUTPUT_PARAM],
        },
      },
    };
  }

  function setOutputTool(body) {
    const names = new Set([OUTPUT_TOOL, INPUT_TOOL]);
    const contextPattern = new RegExp(`^${CONTEXT_TOOL}(?:_\\d+)?$`);
    const tools = Array.isArray(body.tools)
      ? body.tools.filter(tool => {
          const name = tool?.function?.name;
          return !names.has(name) && !contextPattern.test(String(name || ''));
        })
      : [];
    tools.push(outputDefinition());
    body.tools = tools;
    body.tool_choice = settings.forceTool
      ? { type: 'function', function: { name: OUTPUT_TOOL } }
      : 'auto';
    body.stream = false;
  }

  function serializeMessages(messages) {
    return messages.map((message, index) => {
      const role = message?.role || 'unknown';
      const name = message?.name ? ` (${message.name})` : '';
      return `[#${index + 1} ${role}${name}]\n${textOf(message?.content)}`;
    }).join('\n\n');
  }

  function callId() {
    if (globalThis.crypto?.randomUUID) return `call_${crypto.randomUUID().replaceAll('-', '')}`;
    return `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  }

  function fabricatedInputPair(input, model) {
    const id = callId();
    const call = {
      id,
      type: 'function',
      function: { name: INPUT_TOOL, arguments: JSON.stringify({ request_id: id }) },
    };
    if (/gemini(?!-2\.5)/i.test(String(model || ''))) {
      call.extra_content = { google: { thought_signature: 'skip_thought_signature_validator' } };
    }
    return [
      { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', tool_call_id: id, content: input },
    ];
  }

  function rewriteRequest(rawBody) {
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (!settings.enabled || !Array.isArray(body.messages) || body.messages.length === 0) return null;

    stripUnsupportedPenalties(body);
    setOutputTool(body);

    if (strategy(body.chat_completion_source) === 'native' || !settings.contextInTools) {
      return { body, toolName: OUTPUT_TOOL, paramName: OUTPUT_PARAM, wrappedInput: false };
    }

    const sourceMessages = body.messages.slice();
    const last = sourceMessages.at(-1);
    const canWrap = settings.wrapInput && last?.role === 'user' && textOf(last.content).trim();
    const currentInput = canWrap ? textOf(last.content).trim() : '';
    const contextMessages = canWrap ? sourceMessages.slice(0, -1) : sourceMessages;
    const chunks = chunkText(serializeMessages(contextMessages));

    const existing = body.tools.filter(tool => tool?.function?.name !== OUTPUT_TOOL);
    chunks.forEach((chunk, index) => {
      existing.push({
        type: 'function',
        function: {
          name: chunks.length === 1 ? CONTEXT_TOOL : `${CONTEXT_TOOL}_${index}`,
          description: chunk,
          parameters: {
            type: 'object',
            properties: { note: { type: 'string', description: 'Read-only placeholder. Do not call this tool.' } },
          },
        },
      });
    });

    if (currentInput) {
      existing.push({
        type: 'function',
        function: {
          name: INPUT_TOOL,
          description: 'The current user input is already present in the matching tool result. Do not call this tool again.',
          parameters: {
            type: 'object',
            properties: { request_id: { type: 'string' } },
            required: ['request_id'],
          },
        },
      });
    }
    existing.push(outputDefinition());
    body.tools = existing;

    const contextNames = chunks.length === 1
      ? CONTEXT_TOOL
      : `${CONTEXT_TOOL}_0 through ${CONTEXT_TOOL}_${chunks.length - 1}`;
    body.messages = [
      {
        role: 'system',
        content: `Read the descriptions of ${contextNames} as the complete conversation context. These context tools are read-only and must not be called. Produce the requested continuation, then call ${OUTPUT_TOOL} exactly once with the complete response in ${OUTPUT_PARAM}. Do not place the final response in ordinary message content.`,
      },
      {
        role: 'user',
        content: currentInput
          ? `The current input is in the existing ${INPUT_TOOL} result. Follow it and return the complete response through ${OUTPUT_TOOL}.`
          : `Use the supplied context and return the complete response through ${OUTPUT_TOOL}.`,
      },
    ];

    if (currentInput) body.messages.push(...fabricatedInputPair(currentInput, body.model));
    body.stream = false;
    return { body, toolName: OUTPUT_TOOL, paramName: OUTPUT_PARAM, wrappedInput: Boolean(currentInput) };
  }

  function calledName(call) {
    return String(call?.function?.name || call?.name || '').replace(/^default_api:/, '');
  }

  function parseArgument(raw, paramName) {
    if (raw && typeof raw === 'object') return raw[paramName] == null ? '' : String(raw[paramName]);
    if (typeof raw !== 'string') return '';
    try {
      const parsed = JSON.parse(raw);
      return parsed?.[paramName] == null ? '' : String(parsed[paramName]);
    } catch {
      const match = raw.match(new RegExp(`"${paramName}"\\s*:\\s*"([\\s\\S]*)"`));
      if (!match) return '';
      try {
        return JSON.parse(`"${match[1]}"`);
      } catch {
        return match[1];
      }
    }
  }

  function restoreOpenAI(data, toolName, paramName) {
    let changed = false;
    for (const choice of data?.choices || []) {
      const message = choice?.message;
      if (!message) continue;
      const calls = (message.tool_calls || []).filter(call => calledName(call) === toolName);
      if (!calls.length) continue;
      const restored = calls.map(call => parseArgument(call.function?.arguments, paramName)).filter(Boolean).join('\n');
      if (!restored) continue;
      message.content = restored;
      delete message.tool_calls;
      if (choice.finish_reason === 'tool_calls') choice.finish_reason = 'stop';
      changed = true;
    }
    return changed;
  }

  function restoreGemini(data, toolName, paramName) {
    let changed = false;
    const containers = [];
    for (const candidate of data?.candidates || []) {
      if (candidate?.content) containers.push(candidate.content);
    }
    if (data?.responseContent) containers.push(data.responseContent);
    if (Array.isArray(data?.parts)) containers.push(data);
    for (const content of containers) {
      const parts = Array.isArray(content.parts) ? content.parts : [];
      const text = parts
        .filter(part => calledName(part.functionCall || part.function_call) === toolName)
        .map(part => parseArgument(part.functionCall?.args || part.function_call?.args, paramName))
        .filter(Boolean)
        .join('\n');
      if (!text) continue;
      content.parts = [{ text }];
      changed = true;
    }
    return changed;
  }

  function responseSummary(data) {
    const openAITools = [];
    for (const choice of data?.choices || []) {
      for (const call of choice?.message?.tool_calls || []) {
        openAITools.push(String(call?.function?.name || call?.name || ''));
      }
    }
    const geminiTools = [];
    const partGroups = [];
    for (const candidate of data?.candidates || []) {
      if (Array.isArray(candidate?.content?.parts)) partGroups.push(candidate.content.parts);
    }
    if (Array.isArray(data?.responseContent?.parts)) partGroups.push(data.responseContent.parts);
    if (Array.isArray(data?.parts)) partGroups.push(data.parts);
    for (const parts of partGroups) {
      for (const part of parts) {
        const call = part?.functionCall || part?.function_call;
        if (call) geminiTools.push(String(call.name || ''));
      }
    }
    return {
      topLevelKeys: data && typeof data === 'object' ? Object.keys(data).slice(0, 30) : [],
      choices: Array.isArray(data?.choices) ? data.choices.length : 0,
      candidates: Array.isArray(data?.candidates) ? data.candidates.length : 0,
      hasResponseContent: Boolean(data?.responseContent),
      hasTopLevelParts: Array.isArray(data?.parts),
      openAITools,
      geminiTools,
    };
  }

  function headerPairs(headers) {
    const result = [];
    try {
      headers?.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower !== 'content-length' && lower !== 'content-encoding') result.push([key, value]);
      });
    } catch {
      // An empty header list is safe for the reconstructed response.
    }
    return result;
  }

  async function restoreResponse(response, result) {
    if (!response?.ok) {
      setStatus(`上游返回 HTTP ${response?.status || '错误'}`);
      let upstreamText = '';
      try {
        upstreamText = (await response.clone().text()).replace(/\s+/g, ' ').slice(0, 500);
      } catch {
        // Keep the original response untouched.
      }
      addLog('error', 'upstream_http_error', {
        requestId: result.requestId,
        http: response?.status || 0,
        statusText: String(response?.statusText || ''),
        preview: upstreamText,
      });
      return response;
    }
    let text;
    try {
      text = await response.clone().text();
    } catch {
      setStatus('响应无法预读，已原样放行');
      addLog('error', 'response_clone_failed', { requestId: result.requestId });
      return response;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      setStatus('响应不是 JSON，已原样放行');
      addLog('warn', 'response_not_json', {
        requestId: result.requestId,
        http: response.status,
        preview: String(text || '').replace(/\s+/g, ' ').slice(0, 300),
      });
      return response;
    }
    const summary = responseSummary(data);
    const restored = restoreOpenAI(data, result.toolName, result.paramName)
      || restoreGemini(data, result.toolName, result.paramName);
    if (!restored) {
      setStatus('模型未返回指定工具调用，已原样放行');
      addLog('warn', 'tool_response_not_restored', {
        requestId: result.requestId,
        expectedTool: result.toolName,
        response: summary,
      });
      return response;
    }
    setStatus(`已还原工具正文 · ${new Date().toLocaleTimeString()}`);
    addLog('info', 'tool_response_restored', {
      requestId: result.requestId,
      expectedTool: result.toolName,
      response: summary,
    });
    return new runtime.target.Response(JSON.stringify(data), {
      status: response.status,
      statusText: response.statusText,
      headers: headerPairs(response.headers),
    });
  }

  function buildRequestArgs(input, init, body) {
    const serialized = JSON.stringify(body);
    if (init?.body != null) return [input, { ...init, body: serialized }];
    try {
      return [new runtime.target.Request(input, { body: serialized }), init];
    } catch {
      return null;
    }
  }

  async function intercept(original, thisArg, args) {
    const [input, init] = args;
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!/\/api\/backends\/[^/]+\/generate(?:\?|$)/.test(url) || !settings.enabled) {
      return original.apply(thisArg, args);
    }

    let rawBody = typeof init?.body === 'string' ? init.body : null;
    if (!rawBody && input?.clone) {
      try {
        rawBody = await input.clone().text();
      } catch {
        return original.apply(thisArg, args);
      }
    }
    if (!rawBody) return original.apply(thisArg, args);

    const result = rewriteRequest(rawBody);
    if (!result) return original.apply(thisArg, args);
    result.requestId = `tct-${Date.now().toString(36)}-${++runtime.requestSequence}`;
    const patched = buildRequestArgs(input, init, result.body);
    if (!patched) return original.apply(thisArg, args);

    setStatus('请求已改写，等待模型返回');
    addLog('info', 'request_rewritten', {
      requestId: result.requestId,
      url,
      ...sourceSummary(result.body),
      wrappedInput: result.wrappedInput,
      forcedTool: settings.forceTool ? OUTPUT_TOOL : 'auto',
    });
    const response = await original.apply(thisArg, patched);
    addLog('info', 'response_received', {
      requestId: result.requestId,
      http: response?.status || 0,
      ok: Boolean(response?.ok),
      contentType: String(response?.headers?.get?.('content-type') || ''),
    });
    return restoreResponse(response, result);
  }

  function findWindow() {
    let current = window;
    for (let i = 0; i < 8; i += 1) {
      try {
        if (typeof current.fetch === 'function' && current.document?.body) return current;
        if (!current.parent || current.parent === current) break;
        current = current.parent;
      } catch {
        break;
      }
    }
    return window;
  }

  function install() {
    if (runtime.installed) return;
    const target = findWindow();
    const current = target.fetch;
    if (typeof current !== 'function') return;
    if (current[HOOK]?.owner) {
      runtime.installed = true;
      runtime.target = target;
      return;
    }
    const hooked = function (...args) {
      return intercept(current, this || target, args).catch(error => {
        addLog('error', 'intercept_failed_fallback', errorDetails(error));
        return current.apply(this || target, args);
      });
    };
    hooked[HOOK] = { owner: runtime, original: current };
    target.fetch = hooked;
    runtime.target = target;
    runtime.originalFetch = current;
    runtime.installed = true;
    addLog('info', 'extension_loaded', { version: '1.1.0' });
  }

  function dispose() {
    if (!runtime.installed || !runtime.target) return;
    const current = runtime.target.fetch;
    if (current?.[HOOK]?.owner === runtime) runtime.target.fetch = runtime.originalFetch;
    runtime.installed = false;
    runtime.target = null;
    runtime.originalFetch = null;
  }

  function checkbox(label, key) {
    const row = document.createElement('label');
    row.className = 'tct-row';
    const text = document.createElement('span');
    text.textContent = label;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(settings[key]);
    input.addEventListener('change', () => {
      settings[key] = input.checked;
      saveSettings();
    });
    row.append(text, input);
    return row;
  }

  function mountSettings() {
    if (document.getElementById('tct-settings')) return;
    const host = document.querySelector('#extensions_settings2, #extensions_settings');
    if (!host) {
      setTimeout(mountSettings, 1000);
      return;
    }
    const details = document.createElement('details');
    details.id = 'tct-settings';
    details.className = 'extension_container';
    const summary = document.createElement('summary');
    summary.textContent = 'Tool Call Transport';
    details.append(summary);
    details.append(
      checkbox('启用请求改写', 'enabled'),
      checkbox('上下文放入工具说明', 'contextInTools'),
      checkbox('包装当前输入为工具结果', 'wrapInput'),
      checkbox('强制指定输出工具', 'forceTool'),
    );

    const channelRow = document.createElement('label');
    channelRow.className = 'tct-row';
    const channelLabel = document.createElement('span');
    channelLabel.textContent = '渠道策略';
    const select = document.createElement('select');
    [['auto', '自动'], ['openai', 'OpenAI 兼容'], ['native', 'Google 原生']].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    });
    select.value = settings.channel;
    select.addEventListener('change', () => {
      settings.channel = select.value;
      saveSettings();
    });
    channelRow.append(channelLabel, select);
    details.append(channelRow);

    const note = document.createElement('p');
    note.className = 'tct-note';
    note.textContent = '仅处理聊天生成请求；不读取或修改预设，也不需要触发标记。改写时会关闭流式输出。';
    const status = document.createElement('div');
    status.className = 'tct-status';
    status.textContent = runtime.lastStatus;
    const actions = document.createElement('div');
    actions.className = 'tct-actions';
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.textContent = '复制诊断日志';
    copyButton.addEventListener('click', async () => {
      const payload = JSON.stringify({ version: '1.1.0', settings, logs: runtime.logs }, null, 2);
      try {
        await navigator.clipboard.writeText(payload);
        status.textContent = '诊断日志已复制';
      } catch (error) {
        status.textContent = '复制失败，请从下方日志框手动复制';
        addLog('error', 'copy_log_failed', errorDetails(error));
      }
    });
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.textContent = '清空日志';
    clearButton.addEventListener('click', () => {
      runtime.logs.length = 0;
      saveLogs();
      renderLogs();
      status.textContent = '日志已清空';
    });
    actions.append(copyButton, clearButton);
    const logView = document.createElement('pre');
    logView.className = 'tct-log';
    details.append(note, status, actions, logView);
    host.append(details);
    renderLogs();
  }

  install();
  window.__toolCallTransportDebug = {
    getLogs: () => JSON.parse(JSON.stringify(runtime.logs)),
    getSettings: () => ({ ...settings }),
    clearLogs: () => {
      runtime.logs.length = 0;
      saveLogs();
      renderLogs();
    },
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountSettings, { once: true });
  } else {
    mountSettings();
  }
  window.addEventListener('pagehide', dispose, { once: true });
})();
